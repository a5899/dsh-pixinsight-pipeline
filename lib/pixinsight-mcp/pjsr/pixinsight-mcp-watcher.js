// PixInsight MCP Watcher Script
// Runs inside PixInsight's PJSR engine (ECMA-262 with #include support)
// Polls the bridge directory for commands and writes results.
//
// Performance model (important — the original version polled for everything):
//   * A *command file* is only written when a command must be issued.
//   * A *heartbeat file* is rewritten every HEARTBEAT_INTERVAL_MS while idle.
//     Node watches mtime instead of spawning `tasklist`/`powershell` every 10 s.
//   * Fast path: a single write creates the command file, and the watcher waits
//     RELEASE_SETTLE_MS for it to stop changing before reading it. Node never
//     has to pay a separate "release" round trip (optional .ready file remains
//     supported for very large payloads).
//   * The idle poll is self-timed: the next iteration sleeps for the full
//     poll interval minus whatever the loop consumed, instead of a fixed
//     number of 20 ms ticks.

// ============================================================================
// ImageSolver Library (loaded at preprocessor time for plate solving)
// ============================================================================

#define __PJSR_USE_STAR_DETECTOR_V2

#include <pjsr/BRQuadTree.jsh>
#include <pjsr/ColorSpace.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/LinearTransformation.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/SectionBar.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/StarDetector.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/PropertyType.jsh>
#include <pjsr/PropertyAttribute.jsh>
#include <pjsr/RBFType.jsh>
#include <pjsr/APASSFlag.jsh>
#include <pjsr/GaiaFlag.jsh>
#include <pjsr/ReadTextOptions.jsh>

#define TITLE           "Image Solver"
#define SETTINGS_MODULE "SOLVER"
#define STAR_CSV_FILE   (File.systemTempDirectory + "/stars-mcp.csv")

// Include AdP dependencies then ImageSolver in library mode
// (Windows build — paths point at the local PixInsight installation)
#include "C:/Program Files/PixInsight/src/scripts/AdP/Projections.js"
#include "C:/Program Files/PixInsight/src/scripts/AdP/WCSmetadata.jsh"
#include "C:/Program Files/PixInsight/src/scripts/AdP/AstronomicalCatalogs.jsh"
#include "C:/Program Files/PixInsight/src/scripts/AdP/CommonUIControls.js"
#include "C:/Program Files/PixInsight/src/scripts/AdP/SearchCoordinatesDialog.js"
#include "C:/Program Files/PixInsight/src/scripts/AdP/CatalogDownloader.js"

#define USE_SOLVER_LIBRARY
#include "C:/Program Files/PixInsight/src/scripts/AdP/ImageSolver.js"

#define SETTINGS_MODULE_SCRIPT "SOLVER"

// ============================================================================
// Configuration
// ============================================================================

var BRIDGE_DIR = File.homeDirectory + "/.pixinsight-mcp/bridge";
var COMMANDS_DIR = BRIDGE_DIR + "/commands";
var RESULTS_DIR = BRIDGE_DIR + "/results";
var LOGS_DIR = BRIDGE_DIR + "/logs";
var HEARTBEAT_FILE = BRIDGE_DIR + "/watcher.heartbeat";

// Set true to append the poll loop's decisions to bridge/watcher-debug.log.
// Off by default: the log costs a directory write per poll on a busy NAS/home
// directory, and only bridge debugging needs it.
var DEBUG_LOG = false;
var DEBUG_LOG_FILE = BRIDGE_DIR + "/watcher-debug.log";
var _debugBuf = "";
function WATCHER_DEBUG(msg) {
   if (!DEBUG_LOG) return;
   try {
      _debugBuf += new Date().toISOString() + " " + msg + "\n";
      if (_debugBuf.length > 8192) _debugBuf = _debugBuf.substring(_debugBuf.length - 8192);
      File.writeTextFile(DEBUG_LOG_FILE, _debugBuf);
   } catch (e) {}
}

// The command file currently being processed. The poll loop reads it to
// attribute a caught exception to a specific command (see runWatcher).
var CURRENT_COMMAND_ID = null;


var POLL_INTERVAL_MS = 250;
// Idle sleeps: one long slice first (a quiet loop then costs one sleep), then
// short slices so the UI thread still repaints and the heartbeat still ticks.
var IDLE_FIRST_SLICE_MS = 100;
var IDLE_SLICE_MS = 25;
// Grace period after a command file appears: the file must stop growing before
// it is read. Node writes payloads > 256 KiB via a .tmp rename instead.
var RELEASE_SETTLE_MS = 60;
// Stale commands (watcher restarted after a crash) are failed rather than run.
var STALE_COMMAND_MS = 10 * 60 * 1000;
var HEARTBEAT_INTERVAL_MS = 1000;
var WATCHER_VERSION = "0.2.0";

// ============================================================================
// File Helpers (PJSR File API)
// ============================================================================

function readTextFile(path) {
   // File.readTextFile() opens, reads and closes in one call. Keeping the whole
   // payload in one call (rather than streaming it) is what makes the delete in
   // retireCommandFile() succeed: by the time the handler returns, no descriptor
   // of ours is left holding a share lock on the file.
   return File.readTextFile(path);
}

function writeTextFile(path, text) {
   File.writeTextFile(path, text);
}

function deleteFile(path) {
   if (File.exists(path)) {
      File.remove(path);
   }
}

function ensureDirectory(path) {
   if (!File.directoryExists(path)) {
      File.createDirectory(path, true);
   }
}

function listJsonFiles(dirPattern) {
   try {
      return searchDirectory(dirPattern);
   } catch (e) {
      return [];
   }
}

// Names of the *.json files in a directory, sorted (bare file names).
//
// Two traps this function exists to avoid:
//   1. `searchDirectory()` is a GLOBAL PJSR function, not a File method.
//      `File.searchDirectory` is undefined in 1.9.4 and throws TypeError.
//   2. It only exists once the AdP libraries (included at the top of this
//      script) have been loaded, so it must never be the first thing to run.
// Either mistake throws inside the poll loop; the loop body is not guarded,
// so the watcher dies while the idle heartbeat keeps ticking — the bridge then
// looks alive but never consumes another command. runWatcher() now also guards
// the loop and quits loudly after three consecutive failures instead.

// Retire a handled command file. `File.remove` throws on Windows while another
// process holds the file open (ERROR_SHARING_VIOLATION, "another program is
// using this file"), which is exactly what happens if Node is still reading
// the payload. Renaming first avoids the problem: a rename of a file that is
// open for reading succeeds on NTFS, and the leftover ".done" name is skipped
// by listDirJsonNames() because it no longer ends in ".json".
function retireCommandFile(filePath) {
   try {
      File.remove(filePath);
      return true;
   } catch (e) {
      // fall through to the rename path
   }
   try {
      var donePath = filePath + ".done";
      if (File.exists(donePath)) {
         try { File.remove(donePath); } catch (e2) {}
      }
      File.rename(filePath, donePath);
      try { File.remove(donePath); } catch (e3) {}   // best effort cleanup
      return true;
   } catch (e4) {
      return false;
   }
}

var COMMANDS_DIR_PREFIX = null;

// Bounded id ledgers.
//
// These used to be plain arrays that only ever grew. Every poll does
// `ANSWERED_IDS.indexOf(base)` for each pending command, so a long session
// (hundreds of commands) turned each 250 ms tick into an ever-larger linear
// scan until the watcher stopped ticking altogether — the heartbeat froze and
// commands piled up in commands/ unattended (observed: 1257 stale files, and
// the only way out was restarting PixInsight). The ledger is now a hashed set
// with a hard cap; ids evicted from it fall back to the result-file check,
// which is still correct because a command without a result file is either
// pending or genuinely lost.
var ID_LEDGER_LIMIT = 2048;
var ANSWERED_IDS = {};      // id -> true
var ANSWERED_ORDER = [];    // insertion order, for eviction
var DISCARDED_IDS = {};     // id -> true
var DISCARDED_ORDER = [];

function ledgerHas(ledger, id) {
   return Object.prototype.hasOwnProperty.call(ledger, id);
}

function ledgerAdd(ledger, order, id) {
   if (ledgerHas(ledger, id)) return;
   ledger[id] = true;
   order.push(id);
   // Evict oldest entries in bulk so this stays O(1) amortised.
   if (order.length > ID_LEDGER_LIMIT) {
      var drop = order.splice(0, order.length - ID_LEDGER_LIMIT);
      for (var i = 0; i < drop.length; ++i) delete ledger[drop[i]];
   }
}

function markAnswered(id) { ledgerAdd(ANSWERED_IDS, ANSWERED_ORDER, id); }
function markDiscarded(id) { ledgerAdd(DISCARDED_IDS, DISCARDED_ORDER, id); }

// Strip bridge directory bookkeeping suffixes to recover the command file's
// basename without its directory: "masterLight.json" -> "masterLight",
// "abc.tmp" -> "abc".
function commandFileBase(filePath) {
   var base = String(filePath);
   base = base.substring(base.lastIndexOf("/") + 1);
   base = base.substring(base.lastIndexOf("\\") + 1);
   var suffixes = [".json", ".tmp"];
   for (var i = 0; i < suffixes.length; ++i) {
      var s = suffixes[i];
      if (base.length > s.length && base.substring(base.length - s.length) === s) {
         base = base.substring(0, base.length - s.length);
         break;
      }
   }
   return base;
}

// True when this id already produced a result in this session, or when the
// result file is still on disk (a previous session answered it).
function commandAlreadyAnswered(filePath) {
   var base = commandFileBase(filePath);
   if (ledgerHas(ANSWERED_IDS, base)) return true;
   return File.exists(RESULTS_DIR + "/" + base + ".json");
}

function listDirJsonNames(dir) {
   var found = [];
   try {
      found = searchDirectory(dir + "/*");            // absolute paths
   } catch (err) {
      WATCHER_DEBUG("[MCP Watcher] searchDirectory failed for " + dir + ": " + err);
      return null;                                    // directory not readable
   }
   if (!found) return [];

   if (COMMANDS_DIR_PREFIX === null) {
      COMMANDS_DIR_PREFIX = dir.replace(/\\/g, "/") + "/";
   }
   var names = [];
   for (var i = 0; i < found.length; ++i) {
      var e = String(found[i]).replace(/\\/g, "/");
      if (e.substring(0, COMMANDS_DIR_PREFIX.length) === COMMANDS_DIR_PREFIX) {
         e = e.substring(COMMANDS_DIR_PREFIX.length);   // strip the directory
      }
      if (e.length > 5 && e.substring(e.length - 5) === ".json") names.push(e);
   }
   names.sort();
   WATCHER_DEBUG("listed " + names.length + " json command(s): " + names.join(","));
   return names;
}

function fileSize(path) {
   try {
      var f = new File();
      if (!f.openForReading(path)) return -1;
      var n = f.size;
      f.close();
      return n;
   } catch (e) {
      return -1;
   }
}

function fileAgeMs(path) {
   try {
      var f = new File();
      if (!f.openForReading(path)) return 0;
      var ms = Date.now() - f.lastModified.toMilliseconds();
      f.close();
      return ms > 0 ? ms : 0;
   } catch (e) {
      return 0;
   }
}

function getTimestamp() {
   return (new Date()).toISOString();
}

// ============================================================================
// Pixel Access Helpers (shared by the statistics commands)
// ============================================================================

// Resample a copy of a channel so that large frames are measured on a bounded
// number of pixels. `resample(scale)` is a plain box filter for downscaling, so
// median/MAD of the reduced image stay representative while the cost drops
// from O(W*H) to O(maxDimension^2). Sampling via sample() on a 60 MP frame is
// the difference between a ~2 s and a ~40 s statistics step.
var STATS_MAX_DIMENSION = 2000;

function statsImage(img) {
   var maxDim = Math.max(img.width, img.height);
   if (maxDim <= STATS_MAX_DIMENSION) return img;
   var reduced = new Image(img);
   reduced.resample(STATS_MAX_DIMENSION / maxDim);
   return reduced;
}

// Unreferenced by any handler since measurement moved to Image.median()/MAD();
// kept: PJSR has no way to exclude these definitions, and the per-pixel
// sampler documents why the native path replaced it.
function sampleChannelValues(img, channel, maxSamples) {
   var px = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / maxSamples)));
   var out = [];
   for (var c = 0; c < img.numberOfChannels; ++c) {
      var ch = (channel === undefined) ? c : channel;
      var vals = new Float64Array((Math.floor((img.width - 1) / px) + 1) * (Math.floor((img.height - 1) / px) + 1));
      var k = 0;
      for (var y = 0; y < img.height; y += px) {
         for (var x = 0; x < img.width; x += px) {
            vals[k++] = img.sample(x, y, ch);
         }
      }
      out.push(vals.subarray(0, k));
      if (channel !== undefined) break;
   }
   return out;
}

function medianOf(values) {
   var n = values.length;
   if (n === 0) return 0;
   var sorted = Float64Array.from(values);
   sorted.sort();
   return (n & 1) ? sorted[(n - 1) >> 1] : 0.5 * (sorted[(n >> 1) - 1] + sorted[n >> 1]);
}

// ============================================================================
// Command Handlers
// ============================================================================

function handleListOpenImages(command) {
   var windows = ImageWindow.windows;
   var images = [];
   for (var i = 0; i < windows.length; ++i) {
      var w = windows[i];
      var v = w.mainView;
      var img = v.image;
      images.push({
         id: v.id,
         filePath: w.filePath || null,
         width: img.width,
         height: img.height,
         channels: img.numberOfChannels,
         isColor: img.isColor,
         bitDepth: img.bitsPerSample
      });
   }
   return {
      status: "success",
      outputs: { images: images },
      message: "Found " + images.length + " open image(s)"
   };
}

function handleOpenImage(command) {
   var filePath = command.parameters.filePath;
   if (!File.exists(filePath)) {
      throw new Error("File not found: " + filePath);
   }
   var windows = ImageWindow.open(filePath);
   if (windows.length === 0) {
      throw new Error("Failed to open image: " + filePath);
   }
   var w = windows[0];
   w.show();
   var v = w.mainView;
   var img = v.image;
   return {
      status: "success",
      outputs: {
         id: v.id,
         width: img.width,
         height: img.height,
         channels: img.numberOfChannels
      },
      message: "Opened " + v.id
   };
}

function handleSaveImage(command) {
   var viewId = command.parameters.viewId;
   var filePath = command.parameters.filePath;
   var overwrite = command.parameters.overwrite || false;

   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   if (File.exists(filePath) && !overwrite) {
      throw new Error("File already exists (set overwrite=true): " + filePath);
   }
   window.saveAs(filePath, false, false, false, false);
   return {
      status: "success",
      outputs: { filePath: filePath },
      message: "Saved " + viewId + " to " + filePath
   };
}

function handleCloseImage(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   window.forceClose();
   return {
      status: "success",
      outputs: {},
      message: "Closed " + viewId
   };
}

function handleGetImageStatistics(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   // Measure on a downscaled copy: identical numbers to within sampling noise,
   // an order of magnitude faster on full-frame stacks.
   var full = window.mainView.image;
   var img = statsImage(full);
   var stats = [];
   var channelNames = img.isColor ? ["Red", "Green", "Blue"] : ["Gray"];

   for (var c = 0; c < img.numberOfChannels; ++c) {
      img.selectedChannel = c;
      stats.push({
         channel: c,
         channelName: c < channelNames.length ? channelNames[c] : "Channel_" + c,
         mean: img.mean(),
         median: img.median(),
         stdDev: img.stdDev(),
         MAD: img.MAD(),
         min: img.minimum(),
         max: img.maximum()
      });
   }
   img.resetSelections();

   return {
      status: "success",
      outputs: {
         statistics: stats,
         sampledScale: img.width / full.width,
         sourceWidth: full.width,
         sourceHeight: full.height
      },
      message: "Statistics for " + viewId + " (" + stats.length + " channel(s)"
         + (img.width !== full.width ? ", sampled at 1/" + Math.round(full.width / img.width) : "") + ")"
   };
}

// Histogram of luminance (or a single channel), used for gap / clipping checks.
function handleGetHistogram(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) throw new Error("Image not found: " + viewId);
   var full = window.mainView.image;
   var img = statsImage(full);
   var bins = command.parameters.bins || 256;
   var step = Math.max(1, command.parameters.step || 1);
   var isColor = img.isColor;
   var counts = new Float64Array(bins);
   var total = 0;

   // Preferred path: PixInsight's native histogram of a luminance copy. Bin
   // indices are mapped onto our [0, bins) range, so the result is directly
   // comparable with the sampled path below but avoids a per-pixel
   // sample() loop (the single most expensive measurement on full frames).
   var native = null;
   try {
      var lum;
      if (isColor) {
         var red = img.channel(0);
         var grn = img.channel(1);
         var blu = img.channel(2);
         lum = new Image(img.width, img.height, 1);
         lum.assign(0.2126, red);
         lum.add(0.7152, grn);
         lum.add(0.0722, blu);
         red.free(); grn.free(); blu.free();
      } else {
         lum = img;
      }
      var nativeCounts = lum.histogram(bins);
      if (nativeCounts && nativeCounts.length >= bins) {
         native = new Array(bins);
         var nativeTotal = 0;
         for (var i = 0; i < bins; ++i) {
            // Float64 -> Array for JSON transport; PI returns Float64Array.
            native[i] = nativeCounts[i];
            nativeTotal += nativeCounts[i];
         }
         total = nativeTotal;
      }
      if (isColor && lum !== img) lum.free();
   } catch (e) {
      native = null;                                    // fall back to sampling
   }

   if (!native) {
      for (var y = 0; y < img.height; y += step) {
         for (var x = 0; x < img.width; x += step) {
            var lumv = isColor
               ? 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2)
               : img.sample(x, y, 0);
            var b = Math.floor(lumv * bins);
            if (b < 0) b = 0;
            if (b >= bins) b = bins - 1;
            counts[b]++;
            total++;
         }
      }
      native = Array.prototype.slice.call(counts);
   }

   return {
      status: "success",
      outputs: {
         bins: bins,
         counts: native,
         total: total,
         method: native && total > 0 ? "native" : "sampled",
         sampledScale: img.width / full.width
      },
      message: "Histogram for " + viewId + " (" + bins + " bins)"
   };
}

function handleGetChannelStats(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) throw new Error("Image not found: " + viewId);
   var full = window.mainView.image;
   var img = statsImage(full);
   var med = [], mad = [], mean = [];
   for (var c = 0; c < img.numberOfChannels; ++c) {
      img.selectedChannel = c;
      med.push(img.median());
      mad.push(img.MAD());
      mean.push(img.mean());
   }
   img.resetSelections();
   return {
      status: "success",
      outputs: {
         channels: img.numberOfChannels,
         median: med, mad: mad, mean: mean,
         min: img.minimum(), max: img.maximum(),
         sampledScale: img.width / full.width
      },
      message: "Channel statistics for " + viewId
   };
}

// One round trip for "what does the director need after a stage": min / max /
// per-channel median / MAD / mean plus an alias list of everything open.
function handleAnalyzeImage(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) throw new Error("Image not found: " + viewId);
   var full = window.mainView.image;
   var img = statsImage(full);
   var isColor = img.isColor;
   var nCh = img.numberOfChannels;
   var med = [], mad = [], mean = [];
   for (var c = 0; c < nCh; ++c) {
      img.selectedChannel = c;
      med.push(img.median());
      mad.push(img.MAD());
      mean.push(img.mean());
   }
   img.resetSelections();
   var result = {
      viewId: viewId,
      width: full.width, height: full.height, isColor: isColor,
      min: img.minimum(), max: img.maximum(),
      median: med, mad: mad, mean: mean,
      sampledScale: img.width / full.width
   };
   if (isColor) {
      result.medianLum = 0.2126 * med[0] + 0.7152 * med[1] + 0.0722 * med[2];
      result.spread = Math.max(med[0], med[1], med[2]) - Math.min(med[0], med[1], med[2]);
   }
   result.ids = aliasList();
   return {
      status: "success",
      outputs: result,
      message: "Analyzed " + viewId
   };
}

function aliasList() {
   var windows = ImageWindow.windows;
   var ids = [];
   for (var i = 0; i < windows.length; ++i) {
      ids.push(windows[i].mainView.id);
   }
   return ids;
}

// ============================================================================
// Process Execution Handlers
// ============================================================================

function handleRunPixelMath(command) {
   var P = new PixelMath;
   P.expression = command.parameters.expression || "";
   P.expression1 = command.parameters.expression1 || "";
   P.expression2 = command.parameters.expression2 || "";
   P.useSingleExpression = command.parameters.useSingleExpression !== false;
   P.createNewImage = command.parameters.createNewImage || false;
   if (command.parameters.symbols) P.symbols = command.parameters.symbols;
   if (command.parameters.newImageId) {
      P.newImageId = command.parameters.newImageId;
   }
   if (command.parameters.newImageWidth) P.newImageWidth = command.parameters.newImageWidth;
   if (command.parameters.newImageHeight) P.newImageHeight = command.parameters.newImageHeight;
   if (command.parameters.newImageColorSpace !== undefined) P.newImageColorSpace = command.parameters.newImageColorSpace;
   if (command.parameters.truncate !== undefined) P.truncate = command.parameters.truncate;
   if (command.parameters.rescale !== undefined) P.rescale = command.parameters.rescale;

   if (command.targetView) {
      var view = findViewById(command.targetView);
      if (!view) throw new Error("View not found: " + command.targetView);
      P.executeOn(view, false);
   } else {
      P.executeGlobal();
   }
   return {
      status: "success",
      outputs: {},
      message: "PixelMath executed: " + command.parameters.expression
   };
}

function handleExecuteProcess(command) {
   var name = command.parameters.process;
   var params = command.parameters.params || {};
   var P = null;
   try {
      P = eval("new " + name);
   } catch (e) {
      throw new Error("Process not available: " + name + " (" + e.message + ")");
   }
   for (var key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      try {
         P[key] = params[key];
      } catch (e2) {
         throw new Error(name + "." + key + " could not be set: " + e2.message);
      }
   }
   var view = command.targetView ? findViewById(command.targetView) : null;
   if (view) {
      P.executeOn(view, false);
   } else {
      P.executeGlobal();
   }
   return {
      status: "success",
      outputs: { process: name, id: P.id },
      message: name + " executed" + (view ? " on " + view.id : " globally")
   };
}

function handleRemoveGradient(command) {
   var P = new AutomaticBackgroundExtractor;
   P.polyDegree = command.parameters.polyDegree || 4;
   P.tolerance = command.parameters.tolerance || 1.0;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view, false);
   return {
      status: "success",
      outputs: {},
      message: "Gradient removed from " + command.targetView + " (ABE, degree " + P.polyDegree + ")"
   };
}

function handleColorCalibrate(command) {
   var method = command.parameters.method || "spcc";
   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);

   if (method === "spcc") {
      var P = new SpectrophotometricColorCalibration;
      P.executeOn(view, false);
   } else if (method === "pcc") {
      var P = new PhotometricColorCalibration;
      P.executeOn(view, false);
   } else {
      var P = new ColorCalibration;
      P.executeOn(view, false);
   }
   return {
      status: "success",
      outputs: {},
      message: "Color calibrated " + command.targetView + " using " + method.toUpperCase()
   };
}

function handleRemoveGreenCast(command) {
   var P = new SCNR;
   P.colorToRemove = SCNR.prototype.Green;
   P.amount = command.parameters.amount !== undefined ? command.parameters.amount : 1.0;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view, false);
   return {
      status: "success",
      outputs: {},
      message: "Green cast removed from " + command.targetView
   };
}

function handleStretchImage(command) {
   var method = command.parameters.method || "auto";
   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);

   if (method === "auto") {
      var P = new AutoHistogram;
      P.executeOn(view, false);
   } else if (method === "stf") {
      // STF is a screen-transfer function: it is NOT destructive by itself, so
      // the only useful thing the bridge can do is translate it into a
      // permanent HistogramTransformation — which is what a director wants.
      // (The previous version reported success and changed nothing.)
      var img = view.image;
      var n = img.isColor ? 3 : 1;
      var H = [
         [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1],
         [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1]
      ];
      var target = command.parameters.targetBackground !== undefined
         ? command.parameters.targetBackground : 0.25;
      var shadowsClipping = command.parameters.shadowsClipping !== undefined
         ? command.parameters.shadowsClipping : -2.8;
      for (var c = 0; c < n; ++c) {
         img.selectedChannel = c;
         var med = img.median();
         var c0 = Math.range(med + shadowsClipping * img.avgDev(), 0.0, 1.0);
         var m = Math.mtf(target, med - c0);
         H[c] = [c0, m, 1, 0, 1];
      }
      img.resetSelections();
      var ht = new HistogramTransformation;
      ht.H = H;
      ht.executeOn(view, false);
      return {
         status: "success",
         outputs: { histograms: H },
         message: "STF-equivalent HistogramTransformation applied to " + command.targetView
      };
   } else {
      var P = new HistogramTransformation;
      var sc = command.parameters.shadowsClipping || 0.0;
      var mt = command.parameters.midtones || 0.5;
      P.H = [
         [sc, mt, 1, 0, 1],
         [sc, mt, 1, 0, 1],
         [sc, mt, 1, 0, 1],
         [sc, mt, 1, 0, 1],
         [sc, mt, 1, 0, 1]
      ];
      P.executeOn(view, false);
   }
   return {
      status: "success",
      outputs: {},
      message: "Stretched " + command.targetView + " using " + method + " method"
   };
}

function handleApplyCurves(command) {
   var P = new CurvesTransformation;
   var curvePoints = command.parameters.curvePoints || [[0, 0], [1, 1]];
   var channel = command.parameters.channel || "rgb";

   // Channel mapping: R, G, B, K(RGB), L, a, b, c, H, S
   var channelMap = {
      "red": "R", "green": "G", "blue": "B", "rgb": "K",
      "lightness": "L", "saturation": "S", "hue": "H"
   };
   var ch = channelMap[channel] || "K";
   P[ch] = curvePoints;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view, false);
   return {
      status: "success",
      outputs: {},
      message: "Curves applied to " + command.targetView + " (" + channel + " channel)"
   };
}

function handleDenoise(command) {
   var P = new MultiscaleLinearTransform;
   var layers = command.parameters.layers || 4;
   var layerConfig = [];
   for (var i = 0; i < layers; ++i) {
      layerConfig.push([true, true, 0.000, true, 3.000, 1.00, false]);
   }
   layerConfig.push([true, true, 0.000, false, 3.000, 1.00, false]);
   P.layers = layerConfig;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view, false);
   return {
      status: "success",
      outputs: {},
      message: "Denoised " + command.targetView + " (MLT, " + layers + " layers)"
   };
}

function handleSharpen(command) {
   var P = new UnsharpMask;
   P.sigma = command.parameters.sigma || 2.0;
   P.amount = command.parameters.amount || 0.8;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view, false);
   return {
      status: "success",
      outputs: {},
      message: "Sharpened " + command.targetView + " (sigma: " + P.sigma + ", amount: " + P.amount + ")"
   };
}

function handleDeconvolve(command) {
   var P = new Deconvolution;
   P.algorithm = Deconvolution.prototype.RichardsonLucy;
   P.psfMode = Deconvolution.prototype.Gaussian;
   P.psfGaussianSigma = command.parameters.psfSigma || 2.5;
   P.iterations = [
      [command.parameters.iterations || 50, false, 0, 0, 0, false, 0, 0]
   ];

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view, false);
   return {
      status: "success",
      outputs: {},
      message: "Deconvolved " + command.targetView
   };
}

function handleCombineLRGB(command) {
   var P = new LRGBCombination;
   P.channelL = [true, command.parameters.luminanceViewId];
   P.channelR = [false, ""];
   P.channelG = [false, ""];
   P.channelB = [false, ""];
   P.luminanceWeight = command.parameters.luminanceWeight || 1.0;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view, false);
   return {
      status: "success",
      outputs: {},
      message: "LRGB combined onto " + command.targetView
   };
}

function handleBlendNarrowband(command) {
   var P = new PixelMath;
   var nbView = command.parameters.narrowbandViewId;
   var strength = command.parameters.blendStrength || 1.0;
   var mode = command.parameters.blendMode || "max";
   var channel = command.parameters.targetChannel || "red";

   var expr;
   if (mode === "max") {
      expr = "max($T, " + nbView + " * " + strength + ")";
   } else if (mode === "screen") {
      expr = "~(~$T * ~(" + nbView + " * " + strength + "))";
   } else if (mode === "add") {
      expr = "$T + " + nbView + " * " + strength;
   } else {
      expr = "max($T, " + nbView + " * " + strength + ")";
   }

   // Red is channel 0; leave G/B untouched by using per-channel expressions
   // whenever the target image is colour.
   if (channel === "red") {
      P.expressionR = expr;
      P.expressionG = "$T";
      P.expressionB = "$T";
      P.useSingleExpression = false;
   } else {
      P.expression = expr;
      P.useSingleExpression = true;
   }
   P.createNewImage = false;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view, false);
   return {
      status: "success",
      outputs: {},
      message: "Blended " + nbView + " into " + command.targetView + " (" + mode + ", strength: " + strength + ")"
   };
}

function handleRunScript(command) {
   var code = command.parameters.code;
   try {
      var result = eval(code);
      return {
         status: "success",
         outputs: { consoleOutput: String(result !== undefined ? result : "Script executed.") },
         message: "Script executed successfully"
      };
   } catch (e) {
      throw new Error("Script error: " + e.message);
   }
}

// ============================================================================
// Utility Functions
// ============================================================================

// One pass over the window list builds an id -> view map, so N lookups cost one
// traversal instead of N traversals of every window and every preview.
var _viewIndex = null;

function rebuildViewIndex() {
   _viewIndex = {};
   var windows = ImageWindow.windows;
   for (var i = 0; i < windows.length; ++i) {
      var w = windows[i];
      _viewIndex[w.mainView.id] = w.mainView;
      var previews = w.previews;
      for (var j = 0; j < previews.length; ++j) {
         _viewIndex[previews[j].id] = previews[j];
      }
   }
}

function findViewById(viewId) {
   if (_viewIndex && _viewIndex[viewId]) {
      var hit = _viewIndex[viewId];
      if (!hit.isNull) return hit;
   }
   rebuildViewIndex();
   return _viewIndex[viewId] || null;
}

function findWindowByViewId(viewId) {
   var view = findViewById(viewId);
   if (!view) return null;
   return view.window;
}

// ============================================================================
// Command Router
// ============================================================================

function dispatchCommand(command) {
   var tool = command.tool;

   // Internal commands
   if (tool === "list_open_images") return handleListOpenImages(command);
   if (tool === "open_image") return handleOpenImage(command);
   if (tool === "save_image") return handleSaveImage(command);
   if (tool === "close_image") return handleCloseImage(command);
   if (tool === "get_image_statistics") return handleGetImageStatistics(command);
   if (tool === "get_histogram") return handleGetHistogram(command);
   if (tool === "get_channel_stats") return handleGetChannelStats(command);
   if (tool === "analyze_image") return handleAnalyzeImage(command);

   // Processing commands
   if (tool === "run_pixelmath") return handleRunPixelMath(command);
   if (tool === "execute_process") return handleExecuteProcess(command);
   if (tool === "remove_gradient") return handleRemoveGradient(command);
   if (tool === "color_calibrate") return handleColorCalibrate(command);
   if (tool === "remove_green_cast") return handleRemoveGreenCast(command);
   if (tool === "stretch_image") return handleStretchImage(command);
   if (tool === "apply_curves") return handleApplyCurves(command);
   if (tool === "denoise") return handleDenoise(command);
   if (tool === "sharpen") return handleSharpen(command);
   if (tool === "deconvolve") return handleDeconvolve(command);
   if (tool === "combine_lrgb") return handleCombineLRGB(command);
   if (tool === "blend_narrowband") return handleBlendNarrowband(command);

   // Script execution
   if (tool === "run_script") return handleRunScript(command);

   throw new Error("Unknown tool: " + tool);
}

// ============================================================================
// Main Polling Loop
// ============================================================================

// Wait until the command file stops changing (single-shot write) or its .ready
// sibling appears (large-payload write). Returns the file's text, or null when
// the file vanished.
function readCommandFile(filePath, commandId) {
   var readyPath = COMMANDS_DIR + "/" + commandId + ".ready";
   var deadline = Date.now() + 3000;
   var lastSize = -2;
   var initialWrite = null;

   for (;;) {
      var size = fileSize(filePath);
      if (size < 0) return null;                       // vanished
      if (File.exists(readyPath)) break;               // explicit release
      if (size === lastSize && initialWrite !== null && (Date.now() - initialWrite) >= RELEASE_SETTLE_MS) break;
      if (size !== lastSize) { lastSize = size; initialWrite = Date.now(); }
      if (Date.now() > deadline) break;                // give up waiting, read anyway
      msleep(10);
      processEvents();
   }
   try { File.remove(readyPath); } catch (e) {}
   var text = readTextFile(filePath);
   return text;
}

function processNextCommand() {
   var names = listDirJsonNames(COMMANDS_DIR);
   if (names === null) {
      CURRENT_COMMAND_ID = "(list-dir)";
      msleep(10);                                     // unreadable dir: yield
      return false;
   }
   if (names.length === 0) {
      CURRENT_COMMAND_ID = null;
      msleep(1);                                      // let the UI paint
      return false;
   }

   // Drop the head of the queue only once it has been handled. Names are
   // sorted, so a file that cannot be retired would otherwise stay at the head
   // forever and block every later command — the watcher would look alive
   // (heartbeat still ticking) while never dispatching anything again.
   var dispatchPath = null;
   var dispatchName = null;
   for (var i = 0; i < names.length; ++i) {
      var candidate = COMMANDS_DIR + "/" + names[i];
      // A command whose result already exists was handled by an earlier pass
      // and only survived because the delete failed. Never dispatch it twice
      // (pjsr / PixelMath are not idempotent); retire it and move on.
      if (commandAlreadyAnswered(candidate)) {
         if (!ledgerHas(DISCARDED_IDS, names[i])) {
            markDiscarded(names[i]);
            if (!retireCommandFile(candidate)) {
               console.writeln("[MCP Watcher] Answered command " + names[i] +
                  " could not be removed; skipping it and continuing.");
            }
         }
         continue;
      }
      dispatchPath = candidate;
      dispatchName = names[i];
      break;
   }

   if (dispatchPath === null) {
      // Every queued file was already answered. Resume normal polling.
      CURRENT_COMMAND_ID = null;
      msleep(1);
      return false;
   }

   CURRENT_COMMAND_ID = dispatchName;
   var filePath = dispatchPath;
   var commandId = null;
   var command;

   try {
      var probe = readTextFile(filePath);
      command = JSON.parse(probe);
      commandId = command.id;
      if (commandId && File.exists(COMMANDS_DIR + "/" + commandId + ".ready")) {
         var released = readCommandFile(filePath, commandId);
         if (released === null) return true;
         command = JSON.parse(released);
      }
   } catch (e) {
      console.criticalln("[MCP Watcher] Failed to parse command file: " + filePath + " - " + e.message);
      deleteFile(filePath);
      return true;
   }

   // A command from a previous watcher session is stale: its Node side has
   // already timed out. Fail it explicitly so the log says why it was skipped.
   var age = fileAgeMs(filePath);
   if (age > STALE_COMMAND_MS) {
      var stalePath = RESULTS_DIR + "/" + command.id + ".json";
      writeTextFile(stalePath, JSON.stringify({
         id: command.id,
         timestamp: getTimestamp(),
         status: "error",
         duration_ms: 0,
         error: { message: "Stale command (" + Math.round(age / 1000) + "s old) — watcher was not running; command skipped", type: "Stale" }
      }));
      deleteFile(filePath);
      console.criticalln("[MCP Watcher] Skipped stale command " + command.id + " (" + Math.round(age / 1000) + "s old)");
      return true;
   }

   var startTime = Date.now();
   var resultObj;

   // Claim the id BEFORE dispatching, not after. Node removes the result file
   // as soon as it reads it, so "answer file exists" cannot protect a command
   // whose file is still locked — the claim has to live in this session's
   // memory. Registering it after `dispatchCommand` would leave the whole run
   // of a long processor exposed to a re-dispatch.
   markAnswered(command.id);

   try {
      // Publish a fresh heartbeat immediately before dispatching. A long
      // processor (StarAlignment on a 60-frame stack, BXT, integration) can
      // block this thread far past HEARTBEAT_INTERVAL_MS, and the poll loop
      // cannot tick inside dispatchCommand(). Deleting the heartbeat here — the
      // old "absent means busy" signal — made a busy watcher indistinguishable
      // from a dead one, so Node declared a crash and abandoned the result.
      // Node tells "busy" from "dead" by heartbeat age plus the command's own
      // pending timeout instead (see bridge.mjs isAlive/send).
      try { writeTextFile(HEARTBEAT_FILE, String(Date.now())); } catch (e) {}
      console.writeln("[MCP Watcher] Executing: " + command.tool + " (id: " + command.id + ")");
      var handlerResult = dispatchCommand(command);
      resultObj = {
         id: command.id,
         timestamp: getTimestamp(),
         status: handlerResult.status,
         process: command.process,
         duration_ms: Date.now() - startTime,
         outputs: handlerResult.outputs || {},
         message: handlerResult.message || ""
      };
   } catch (e) {
      console.criticalln("[MCP Watcher] Error executing " + command.tool + ": " + e.message);
      resultObj = {
         id: command.id,
         timestamp: getTimestamp(),
         status: "error",
         process: command.process,
         duration_ms: Date.now() - startTime,
         error: {
            message: e.message,
            type: e.name || "Error",
            stack: e.stack || ""
         }
      };
   }

   var resultPath = RESULTS_DIR + "/" + command.id + ".json";
   try {
      writeTextFile(resultPath, JSON.stringify(resultObj));
      console.writeln("[MCP Watcher] Result written: " + resultObj.status +
         " (" + resultObj.duration_ms + "ms)");
   } catch (e) {
      console.criticalln("[MCP Watcher] Failed to write result: " + e.message);
   }

   // The result is on disk, so the command is already answered. Retiring the
   // command file must therefore never be able to break the loop: Windows
   // holds a share lock while Node streams the payload, and a failed delete
   // would otherwise re-dispatch the very same command forever.
   if (!retireCommandFile(filePath)) {
      // Expected rather than exceptional: Node may still be reading the file it
      // wrote. It is already recorded as answered, so the next pass retires it
      // quietly. A writeln keeps the console free of red text for a normal race.
      console.writeln("[MCP Watcher] Command " + command.id +
         " answered; file still locked, will be retired automatically.");
   }
   // Any view may have been created/closed/renamed by this command.
   _viewIndex = null;
   // Publish a fresh heartbeat immediately: Node's next health check must see
   // the watcher as idle again instead of waiting up to one interval.
   try { writeTextFile(HEARTBEAT_FILE, String(Date.now())); } catch (e) {}

   return true;
}

function runWatcher() {
   ensureDirectory(BRIDGE_DIR);
   ensureDirectory(COMMANDS_DIR);
   ensureDirectory(RESULTS_DIR);
   ensureDirectory(LOGS_DIR);

   // A previous watcher session can die (PixInsight reload, crash) before it
   // removes its heartbeat. Node would then read that frozen number as a live
   // watcher, so delete it before this session starts ticking and replace it
   // with one owned by this run.
   try { File.remove(HEARTBEAT_FILE); } catch (e) {}

   console.noteln("===========================================");
   console.noteln("  PixInsight MCP Watcher v" + WATCHER_VERSION);
   console.noteln("  Bridge: " + BRIDGE_DIR);
   console.noteln("  Polling every " + POLL_INTERVAL_MS + "ms");
   console.noteln("  Ctrl+F11 to abort");
   console.noteln("===========================================");

   var commandCount = 0;
   var SHUTDOWN_FILE = BRIDGE_DIR + "/shutdown";
   var lastHeartbeat = 0;

   console.show();

   function shouldShutdown() {
      if (console.abortRequested) return true;
      if (File.exists(SHUTDOWN_FILE)) {
         try { File.remove(SHUTDOWN_FILE); } catch (e) {}
         return true;
      }
      return false;
   }

   function heartbeat() {
      var now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS || !File.exists(HEARTBEAT_FILE)) {
         lastHeartbeat = now;
         // A missing heartbeat makes the Node side report a dead watcher, so
         // rewrite whenever it is gone. (The dispatch path no longer deletes it,
         // but a manual clean-up of the bridge directory still can.)
         try { writeTextFile(HEARTBEAT_FILE, String(now)); } catch (e) {}
      }
   }

   // Self-timed idle: sleep the remainder of the poll interval in bounded
   // slices so the UI stays responsive and the heartbeat keeps ticking. The
   // first slice is the long one — a quiet loop then costs a couple of
   // processEvents() calls plus one msleep, not twenty. A 1 ms floor keeps a
   // long dispatch (or a blocked publish) from turning the loop into a spin.
   function idle(intervalMs) {
      var until = Date.now() + Math.max(1, intervalMs);
      var first = true;
      while (Date.now() < until) {
         processEvents();
         heartbeat();
         if (shouldShutdown()) return false;
         var remaining = until - Date.now();
         if (remaining > 0) {
            var slice = first ? Math.min(IDLE_FIRST_SLICE_MS, remaining)
                              : Math.min(IDLE_SLICE_MS, remaining);
            first = false;
            msleep(slice);
         }
      }
      return true;
   }

   // A caught exception keeps the loop alive, but an exception from a
   // dispatch is re-entered here on the very next poll, so three consecutive
   // failures on the same command id mean the loop is about to burn the CPU at
   // 250 ms intervals. Stop with an explicit console message instead of leaving
   // a watcher that looks alive but does nothing.
   var consecutiveErrors = 0;
   var lastErrorId = null;

   for (;;) {
      var cycleStart = Date.now();
      processEvents();
      heartbeat();

      if (shouldShutdown()) {
         console.warningln("[MCP Watcher] Shutdown requested. Stopping.");
         break;
      }

      var processed = false;
      try {
         processed = processNextCommand();
         consecutiveErrors = 0;
      } catch (loopError) {
         var loopId = READ_ERROR_CONTEXT();
         if (loopId && loopId === lastErrorId) consecutiveErrors++;
         else consecutiveErrors = 1;
         lastErrorId = loopId;
         console.criticalln("[MCP Watcher] Poll loop error (" + consecutiveErrors +
                             ") on " + loopId + ": " + loopError);
         if (consecutiveErrors >= 3) break;
         msleep(500);
      }

      if (processed) {
         commandCount++;
         // Let the UI repaint after a long process, but do not burn a fixed
         // 400 ms on every command: two yields are enough for the message
         // queue, and `continue` re-enters the loop immediately.
         processEvents();
         msleep(10);
         processEvents();
         continue;
      }

      var spent = Date.now() - cycleStart;
      if (!idle(Math.max(20, POLL_INTERVAL_MS - spent))) break;
   }

   try { File.remove(HEARTBEAT_FILE); } catch (e) {}
   console.noteln("[MCP Watcher] Stopped. Processed " + commandCount + " command(s).");
}

// Id of the command the poll loop is currently working on, so a caught loop
// exception can be attributed to it (see runWatcher).
function READ_ERROR_CONTEXT() {
   return CURRENT_COMMAND_ID;
}

// Kept for the dispatch-time heartbeat refresh: the loop calls this before a
// long processor so the file's mtime is as young as possible when Node next
// checks. A missing file is rewritten here rather than treated as "busy".
function refreshHeartbeat() {
   try { writeTextFile(HEARTBEAT_FILE, String(Date.now())); } catch (e) {}
}

// ============================================================================
// Entry Point
// ============================================================================

runWatcher();
