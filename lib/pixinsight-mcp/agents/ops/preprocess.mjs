// ============================================================================
// Preprocessing: alignment, cropping, integration
//
// The director prompt's flows all open with the same three moves:
//   - StarAlignment   (S/H/O channels, or LRGB, or HO/SO stacks onto one grid)
//   - DynamicCrop     (ONE identical rectangle for every channel — different
//                      crop boxes poison the later background model)
//   - ImageIntegration (C2: merging the two OIII estimates into one high-SNR
//                      OIII; also available for general frame stacking)
//
// PJSR constraint: ECMAScript 5 only — no let/const/arrow inside ctx.pjsr code.
// ============================================================================

/** True when the bridge reports an error status. */
function failed(r) {
  return r && r.status === 'error';
}

function errText(r, fallback) {
  return (r && r.error && (r.error.message || r.error.toString())) || fallback;
}

/**
 * Align one or more source views onto a reference view with StarAlignment.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   reference_id: string,          // the view everything is aligned to
 *   source_ids: string[],          // views to align (must not include the reference)
 *   target_ids?: string[],         // output ids (default: `<src>_aligned`)
 *   output_dir?: string,           // optional directory for the aligned files
 *   pixel_interpolation?: number,  // 3 = auto (default), see StarAlignment docs
 *   ransac_tolerance?: number,     // px, default 2.0 — raise for noisy narrowband
 *   max_stars?: number             // default 2000
 * }
 * @returns {Promise<object>} { reference_id, aligned: [{ source, target, ok, error }] }
 */
export async function starAlign(ctx, opts = {}) {
  const reference = opts.reference_id;
  if (!reference) throw new Error('starAlign: reference_id is required');
  const sources = Array.isArray(opts.source_ids) ? opts.source_ids : [];
  if (!sources.length) throw new Error('starAlign: source_ids must be a non-empty array');

  const targetIds = Array.isArray(opts.target_ids) && opts.target_ids.length === sources.length
    ? opts.target_ids
    : sources.map(id => `${id}_aligned`);

  const pixelInterpolation = Number.isFinite(opts.pixel_interpolation) ? opts.pixel_interpolation : 3;
  const ransacTolerance = Number.isFinite(opts.ransac_tolerance) ? opts.ransac_tolerance : 2.0;
  const maxStars = Number.isFinite(opts.max_stars) ? opts.max_stars : 2000;
  const outputDir = opts.output_dir ? `'${String(opts.output_dir).replace(/\\/g, '/')}'` : 'null';

  const aligned = [];
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const tgt = targetIds[i];
    // One StarAlignment instance per source: each writes its own output window,
    // and reusing one process across multiple executeOn calls leaks the previous
    // registration into the next frame.
    const r = await ctx.pjsr(`
      var refW = ImageWindow.windowById('${reference}');
      if (refW.isNull) throw new Error('reference not found: ${reference}');
      var srcW = ImageWindow.windowById('${src}');
      if (srcW.isNull) throw new Error('source not found: ${src}');
      var old = ImageWindow.windowById('${tgt}');
      if (!old.isNull) old.forceClose();

      var P = new StarAlignment;
      P.referenceImage = '${reference}';
      P.mode = StarAlignment.prototype.OutputImages;
      P.outputDirectory = ${outputDir};
      P.outputPostfix = '_aligned';
      P.pixelInterpolation = ${pixelInterpolation};
      P.ransacTolerance = ${ransacTolerance};
      P.maxStars = ${maxStars};
      P.overlappingOnly = false;
      P.isAboveThreshold = [true, 0.1];
      P.executeOn(srcW.mainView);
      'OK';
    `);
    if (failed(r)) {
      const msg = errText(r, 'StarAlignment failed');
      log(`  [preprocess] align ${src} → ${tgt} FAILED: ${msg}`);
      aligned.push({ source: src, target: tgt, ok: false, error: msg });
      continue;
    }

    // StarAlignment names its output by postfix unless outputDirectory is set;
    // normalise to the requested window id so downstream calls stay stable.
    const ren = await ctx.pjsr(`
      var want = ImageWindow.windowById('${tgt}');
      if (want.isNull) {
        var alt = ImageWindow.windowById('${src}_aligned');
        if (!alt.isNull) alt.id = '${tgt}';
      }
      'OK';
    `);
    if (failed(ren)) {
      log(`  [preprocess] rename ${src} → ${tgt} WARN: ${errText(ren, 'rename failed')}`);
    }
    aligned.push({ source: src, target: tgt, ok: true, error: null });
  }

  const okCount = aligned.filter(a => a.ok).length;
  log(`  [preprocess] StarAlignment: ${okCount}/${sources.length} frames aligned to ${reference}`);
  return { reference_id: reference, aligned };
}

/**
 * Crop several views with ONE identical rectangle.
 *
 * The director prompt is explicit: the crop box must be identical across
 * channels, otherwise the later background model is built on inconsistent
 * geometry. This helper therefore computes the rectangle once and reuses it.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   view_ids: string[],     // views to crop
 *   x, y, width, height     // explicit rectangle (pixels, 0-based)
 *   OR margin: number       // uniform margin to shave off all four edges
 * }
 * @returns {Promise<object>} { rect: {x,y,width,height}, cropped: [...] }
 */
export async function dynamicCrop(ctx, opts = {}) {
  const views = Array.isArray(opts.view_ids) ? opts.view_ids : [];
  if (!views.length) throw new Error('dynamicCrop: view_ids must be a non-empty array');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  let rect = {
    x: Number.isFinite(opts.x) ? opts.x : 0,
    y: Number.isFinite(opts.y) ? opts.y : 0,
    width: Number.isFinite(opts.width) ? opts.width : null,
    height: Number.isFinite(opts.height) ? opts.height : null
  };

  // Derive the rectangle from the first view when width/height are absent.
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    const dimR = await ctx.pjsr(`
      var w = ImageWindow.windowById('${views[0]}');
      if (w.isNull) throw new Error('view not found: ${views[0]}');
      var img = w.mainView.image;
      JSON.stringify({ width: img.width, height: img.height });
    `);
    if (failed(dimR)) throw new Error('dynamicCrop: ' + errText(dimR, 'cannot read dimensions'));
    const dims = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');
    const margin = Number.isFinite(opts.margin) ? opts.margin : 0;
    rect.width = (dims.width || 0) - 2 * margin;
    rect.height = (dims.height || 0) - 2 * margin;
    rect.x = margin;
    rect.y = margin;
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error(`dynamicCrop: margin ${margin} leaves no pixels in ${views[0]}`);
    }
  }

  const cropped = [];
  for (const viewId of views) {
    const r = await ctx.pjsr(`
      var w = ImageWindow.windowById('${viewId}');
      if (w.isNull) throw new Error('view not found: ${viewId}');
      var P = new DynamicCrop;
      P.center = new Point(${rect.x + rect.width / 2}, ${rect.y + rect.height / 2});
      P.size = new Point(${rect.width}, ${rect.height});
      P.interpolation = DynamicCrop.prototype.Bicubic;
      P.executeOn(w.mainView, false);
      'OK';
    `);
    if (failed(r)) {
      const msg = errText(r, 'DynamicCrop failed');
      log(`  [preprocess] crop ${viewId} FAILED: ${msg}`);
      cropped.push({ view_id: viewId, ok: false, error: msg });
    } else {
      cropped.push({ view_id: viewId, ok: true, error: null });
    }
  }

  const okCount = cropped.filter(c => c.ok).length;
  log(`  [preprocess] DynamicCrop ${rect.width}x${rect.height} at (${rect.x},${rect.y}) → ${okCount}/${views.length} views`);
  return { rect, cropped };
}

/**
 * Integrate several views into one with ImageIntegration.
 *
 * Flow C2 uses this to merge the two independent OIII estimates (OIII_HO and
 * OIII_S). The prompt suggests feeding each at least once and repeating to
 * reach three or more inputs for a better SNR gain.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   source_ids: string[],   // inputs (repeat an id to weight it more)
 *   target_id: string,      // new output window
 *   combination?: number,   // 0=average 1=median (default 0)
 *   rejection?: number,     // 0=none 1=sigma clipping (default 0 for 2 inputs)
 *   weighting?: number      // 0=no weighting 1=noise-based (default 0)
 * }
 * @returns {Promise<object>} { target_id, inputs, combination, rejection, stats }
 */
export async function imageIntegration(ctx, opts = {}) {
  const sources = Array.isArray(opts.source_ids) ? opts.source_ids : [];
  if (sources.length < 2) throw new Error('imageIntegration: need at least 2 source_ids');
  const targetId = opts.target_id;
  if (!targetId) throw new Error('imageIntegration: target_id is required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  const combination = Number.isFinite(opts.combination) ? opts.combination : 0;
  // Sigma clipping needs enough frames to be meaningful; with 2-3 inputs it
  // costs more than it gains, so default to no rejection unless asked.
  const rejection = Number.isFinite(opts.rejection)
    ? opts.rejection
    : (sources.length >= 5 ? 1 : 0);
  const weighting = Number.isFinite(opts.weighting) ? opts.weighting : 0;

  const idList = sources.map(s => `'${s}'`).join(', ');
  const r = await ctx.pjsr(`
    var ids = [${idList}];
    for (var i = 0; i < ids.length; i++) {
      var w = ImageWindow.windowById(ids[i]);
      if (w.isNull) throw new Error('integration input not found: ' + ids[i]);
    }
    var old = ImageWindow.windowById('${targetId}');
    if (!old.isNull) old.forceClose();

    var P = new ImageIntegration;
    P.images = ids;
    P.combination = ${combination};
    P.rejection = ${rejection};
    P.weighting = ${weighting};
    P.normalization = ImageIntegration.prototype.AdditiveWithScaling;
    P.generateRejectionLayers = false;
    P.createNewImage = true;
    P.newImageId = '${targetId}';
    P.executeGlobal();
    if (ImageWindow.windowById('${targetId}').isNull) {
      throw new Error('ImageIntegration produced no output window');
    }
    'OK';
  `);
  if (failed(r)) throw new Error('imageIntegration: ' + errText(r, 'ImageIntegration failed'));

  // Report the input/output noise so the caller can see the SNR gain.
  const statsR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${targetId}');
    var img = w.mainView.image;
    JSON.stringify({ median: img.median(), mad: img.MAD(), max: img.maximum(new Rect(0, 0, img.width, img.height)) });
  `);
  const stats = JSON.parse(statsR.outputs?.consoleOutput?.trim() || '{}');

  log(`  [preprocess] ImageIntegration: ${sources.length} inputs → ${targetId} ` +
      `(combination=${combination}, rejection=${rejection}, mad=${(stats.mad ?? 0).toExponential(3)})`);
  return {
    target_id: targetId,
    inputs: sources,
    combination,
    rejection,
    weighting,
    stats
  };
}

/**
 * Report the geometry/type of a set of views so the director can verify all
 * channels share one grid before integrating or combining.
 *
 * @param {object} ctx
 * @param {string[]} viewIds
 * @returns {Promise<object>} { consistent, frames: [...] }
 */
export async function checkRegistration(ctx, viewIds = []) {
  const ids = Array.isArray(viewIds) ? viewIds : [];
  if (!ids.length) throw new Error('checkRegistration: view_ids must be non-empty');

  const frames = [];
  for (const id of ids) {
    const r = await ctx.pjsr(`
      var w = ImageWindow.windowById('${id}');
      if (w.isNull) throw new Error('view not found: ${id}');
      var img = w.mainView.image;
      JSON.stringify({ width: img.width, height: img.height, channels: img.numberOfChannels, color: img.isColor });
    `);
    if (failed(r)) {
      frames.push({ view_id: id, ok: false, error: errText(r, 'not found') });
      continue;
    }
    const d = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}');
    frames.push({ view_id: id, ok: true, ...d });
  }

  const good = frames.filter(f => f.ok);
  const consistent = good.length > 1
    ? good.every(f => f.width === good[0].width && f.height === good[0].height)
    : good.length === 1;

  return { consistent, frames };
}
