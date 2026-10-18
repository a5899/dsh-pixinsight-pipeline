// ============================================================================
// Bridge communication with PixInsight via file-based IPC
//
// Protocol (v2, see pjsr/pixinsight-mcp-watcher.js for the other side):
//   commands/<id>.json   command payload, one write for small payloads,
//                        <id>.tmp + rename above ATOMIC_WRITE_BYTES,
//                        optional <id>.ready to release a slow writer
//   results/<id>.json    result payload, written by the watcher
//   watcher.heartbeat    rewritten by an *idle* watcher every second
//
// Liveness is read from the heartbeat's mtime. That replaces the previous
// `tasklist` call every 10 s (and the PowerShell call for memory readings):
// each of those spawns a process, which on this host costs far more than the
// 500 ms poll itself and made long PixInsight processes feel sluggish.
// ============================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const home = os.homedir();
const DEFAULT_BRIDGE_DIR = path.join(home, '.pixinsight-mcp/bridge');
const DEFAULT_CMD_DIR = path.join(DEFAULT_BRIDGE_DIR, 'commands');
const DEFAULT_RES_DIR = path.join(DEFAULT_BRIDGE_DIR, 'results');
const DEFAULT_HEARTBEAT = path.join(DEFAULT_BRIDGE_DIR, 'watcher.heartbeat');

/** Writes above this size go through a tmp file + rename (no partial reads). */
const ATOMIC_WRITE_BYTES = 256 * 1024;
/** Poll cadence for the result file. 50–200 ms keeps latency invisible. */
const RESULT_POLL_MS = 100;
/** A heartbeat older than this means the watcher is not running. */
const HEARTBEAT_STALE_MS = 8000;
/** A busy watcher cannot refresh the heartbeat while a process runs. */
const BUSY_GRACE_MS = 120_000;

/**
 * Error thrown when PixInsight process is not found (crashed).
 * Callers should catch this specifically and handle crash recovery.
 */
export class BridgeCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeCrashError';
    this.isCrash = true;
  }
}

// Lazy-load child_process for the fallback process/memory checks (ESM compat)
let _execSync = null;
async function getExecSync() {
  if (!_execSync) {
    const cp = await import('child_process');
    _execSync = cp.execSync;
  }
  return _execSync;
}

/**
 * Cross-platform: is the PixInsight process running?
 * Windows uses `tasklist`; POSIX uses `ps`. Only consulted as a *fallback*
 * when the heartbeat is stale — see createBridgeContext().isAlive.
 */
async function isPixInsightRunning() {
  try {
    const execSync = await getExecSync();
    let out;
    if (process.platform === 'win32') {
      out = execSync('tasklist /FI "IMAGENAME eq PixInsight.exe" /FO CSV /NH', { timeout: 5000 }).toString();
      return /\bPixInsight\.exe\b/i.test(out);
    } else {
      out = execSync("ps aux | grep '[P]ixInsight.app' | wc -l", { timeout: 5000 }).toString().trim();
      return parseInt(out, 10) > 0;
    }
  } catch {
    return false;
  }
}

/**
 * Cross-platform: approximate PixInsight working-set memory in MB.
 * Returns 0 on failure (memory management is then skipped safely).
 */
async function getPixInsightMemMB() {
  try {
    const execSync = await getExecSync();
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "$p=Get-Process PixInsight -ErrorAction SilentlyContinue; if($p){[math]::Round((($p.WorkingSet64)|Measure-Object -Sum).Sum/1MB)}"',
        { timeout: 8000 }).toString().trim();
      return parseInt(out, 10) || 0;
    } else {
      const out = execSync("ps aux | grep '[P]ixInsight.app' | awk '{s+=$6} END{print s}'", { timeout: 5000 }).toString().trim();
      return Math.round(parseInt(out, 10) / 1024);
    }
  } catch {
    return 0;
  }
}

/** Sleep that never blocks the event loop longer than needed. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a bridge context for communicating with PixInsight.
 * All ops functions take this context as their first argument.
 */
export function createBridgeContext(opts = {}) {
  const cmdDir = opts.cmdDir || DEFAULT_CMD_DIR;
  const resDir = opts.resDir || DEFAULT_RES_DIR;
  const heartbeatFile = opts.heartbeatFile || DEFAULT_HEARTBEAT;
  const logFn = opts.log || console.log;

  // Clean up stale results from previous crashed sessions (older than 5 min)
  try {
    const cutoff = Date.now() - 5 * 60_000;
    for (const f of fs.readdirSync(resDir)) {
      const fp = path.join(resDir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) { try { fs.unlinkSync(fp); } catch {} }
    }
  } catch {}

  // ---- liveness -----------------------------------------------------------
  /**
   * Age of the watcher heartbeat in ms (Infinity when the file is absent).
   * The heartbeat is the cheap liveness signal: reading one mtime costs
   * microseconds, whereas `tasklist`/`ps` spawns a process.
   */
  function heartbeatAgeMs() {
    try {
      return Date.now() - fs.statSync(heartbeatFile).mtimeMs;
    } catch {
      return Infinity;
    }
  }

  /**
   * Is the watcher alive? Cheap path: heartbeat freshness. A long processor
   * blocks the watcher's thread, so the heartbeat legitimately freezes while a
   * command is pending — the caller passes the pending age so a frozen-but-
   * recent heartbeat is never read as death.
   */
  async function isAlive(pendingSince = 0) {
    const age = heartbeatAgeMs();
    if (age <= HEARTBEAT_STALE_MS) return true;
    // A command is in flight: the watcher may be inside a long processor and
    // cannot tick. Only the OS can tell "still working" from "gone", and it is
    // worth the one process check because a false crash abandons the result.
    if (pendingSince) return isPixInsightRunning();
    // No fresh heartbeat and no command in flight: PixInsight may still be
    // running without the watcher, which would hang forever waiting for a
    // result. Distinguish the two.
    return isPixInsightRunning();
  }

  // ---- send ---------------------------------------------------------------
  async function send(tool, proc, params, sendOpts) {
    const id = crypto.randomUUID();
    const cmd = {
      id, timestamp: new Date().toISOString(), tool, process: proc,
      parameters: params,
      executeMethod: sendOpts?.exec || 'executeGlobal',
      targetView: sendOpts?.view || null
    };
    const payload = JSON.stringify(cmd);
    const cmdPath = path.join(cmdDir, id + '.json');
    const readyPath = path.join(cmdDir, id + '.ready');

    if (Buffer.byteLength(payload) > ATOMIC_WRITE_BYTES) {
      const tmpPath = path.join(cmdDir, id + '.tmp');
      fs.writeFileSync(tmpPath, payload);
      fs.renameSync(tmpPath, cmdPath);
      fs.writeFileSync(readyPath, '1');
    } else {
      fs.writeFileSync(cmdPath, payload);
    }

    const rp = path.join(resDir, id + '.json');
    const startedAt = Date.now();
    const timeoutMs = sendOpts?.timeoutMs ?? 20 * 60_000;
    let lastHealthCheck = Date.now();

    for (;;) {
      if (fs.existsSync(rp)) {
        let r = null;
        try {
          const text = fs.readFileSync(rp, 'utf-8');
          if (text.trim()) r = JSON.parse(text);
        } catch { /* writer still finishing — retry */ }
        if (r && r.status !== 'running') {
          // The watcher may still be holding the result file open on Windows
          // while it retires the command. An unlink failure is harmless — the
          // watcher deletes leftovers with the command — so never let it throw.
          try { fs.unlinkSync(rp); } catch { /* left for the watcher */ }
          return r;
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Timeout: ' + tool + ' (no result after ' + Math.round(timeoutMs / 1000) + 's)');
      }

      // Health check at most once every 5 s. A missing PixInsight process is
      // the only conclusive crash signal while a command is pending, so keep
      // polling until the command's own timeout runs out rather than giving up
      // on a heartbeat that a long processor legitimately froze.
      if (Date.now() - lastHealthCheck > 5000) {
        lastHealthCheck = Date.now();
        const alive = await isAlive(startedAt);
        if (!alive) {
          throw new BridgeCrashError('PixInsight process not found — it may have crashed. Restart PixInsight and the watcher, then resume with --resume --run-id <runId>');
        }
      }

      await sleep(RESULT_POLL_MS);
    }
  }

  async function pjsr(code) {
    const r = await send('run_script', '__script__', { code });
    r.result = r.outputs?.consoleOutput;
    if (r.status !== 'error') r.status = 'ok';
    return r;
  }

  /**
   * Run an upstream PixInsight process by name with a flat parameter object.
   * Generic escape hatch: `executeProcess(ctx, 'HistogramTransformation', {...})`.
   */
  async function executeProcess(name, params = {}, viewId = null, sendOpts = {}) {
    const r = await send('execute_process', name, { process: name, params }, { ...sendOpts, view: viewId });
    return r;
  }

  async function listImages() {
    const list = await send('list_open_images', '__internal__', {});
    return list.outputs?.images || [];
  }

  async function detectNewImages(beforeIds) {
    const imgs = await listImages();
    return imgs.filter(i => !beforeIds.includes(i.id));
  }

  /**
   * Quick health check — true when the watcher answers within the timeout.
   */
  async function ping(timeoutMs = 10000) {
    try {
      if (!(await isAlive())) return false;
      const result = await Promise.race([
        send('list_open_images', '__internal__', {}, { timeoutMs }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), timeoutMs))
      ]);
      return result.status !== 'error';
    } catch {
      return false;
    }
  }

  /**
   * Batched measurement: one round trip returns min/max, per-channel
   * median/MAD/mean and the open view ids. Use this instead of three separate
   * pjsr() calls when a stage needs "everything the director reports".
   */
  async function analyze(viewId) {
    const r = await send('analyze_image', '__internal__', { viewId });
    r.status = r.status === 'error' ? 'error' : 'ok';
    return r.outputs || {};
  }

  /** Histogram of luminance in one round trip. */
  async function histogram(viewId, bins = 256, step = 1) {
    const r = await send('get_histogram', '__internal__', { viewId, bins, step });
    r.status = r.status === 'error' ? 'error' : 'ok';
    return r.outputs || {};
  }

  /** Per-channel median/MAD/mean in one round trip. */
  async function channelStats(viewId) {
    const r = await send('get_channel_stats', '__internal__', { viewId });
    r.status = r.status === 'error' ? 'error' : 'ok';
    return r.outputs || {};
  }

  const MEM_WARN_MB = opts.memWarnMB || 4000;
  const MEM_ABORT_MB = opts.memAbortMB || 8000;

  async function checkMemory(stepId, liveImages, onAbort) {
    try {
      const memMB = await getPixInsightMemMB();
      if (!memMB) return memMB;
      if (memMB > MEM_ABORT_MB) {
        logFn(`  [MEMORY] CRITICAL: PixInsight using ${memMB}MB`);
        if (onAbort) await onAbort(stepId);
        return memMB;
      } else if (memMB > MEM_WARN_MB) {
        logFn(`  [MEMORY] WARNING: PixInsight using ${memMB}MB — purging undo history`);
        if (liveImages && Object.keys(liveImages).length) {
          // One round trip for every open view instead of one per view.
          const ids = JSON.stringify(Object.values(liveImages));
          await pjsr(`var ids = ${ids}; for (var i = 0; i < ids.length; i++) { var w = ImageWindow.windowById(ids[i]); if (!w.isNull) w.purge(); } gc(); processEvents(); 'purged';`);
        }
        await pjsr('gc(); processEvents(); 0;');
        const memMB2 = await getPixInsightMemMB();
        logFn(`  [MEMORY] After purge: ${memMB2}MB`);
        return memMB2;
      } else {
        logFn(`  [memory] ${memMB}MB`);
        return memMB;
      }
    } catch { return 0; }
  }

  function log(msg) { logFn(msg); }

  return {
    send, pjsr, executeProcess,
    listImages, detectNewImages,
    analyze, histogram, channelStats,
    checkMemory, ping,
    isAlive, heartbeatAgeMs,
    log
  };
}
