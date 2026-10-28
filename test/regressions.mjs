#!/usr/bin/env node
// ============================================================================
// Regression tests for tool-layer bugs found on 2026-10-23 while processing M27.
//
// Each case is a bug that FAILED SILENTLY in production: the tool reported
// success while corrupting the image or doing nothing. They are grouped here
// because they share one property — a green result that cannot be trusted
// unless the pixels are checked.
//
// These tests need a live PixInsight with the watcher loaded. When PixInsight is
// not running the whole file SKIPS (exit 0) so it can sit in `npm test` on
// machines without PixInsight.
//
//   node test/regressions.mjs
// ============================================================================
import { createBridgeContext } from '../lib/pixinsight-mcp/agents/ops/bridge.mjs';
import { removeGreen } from '../lib/pixinsight-mcp/agents/ops/star-handling.mjs';
import { combineSho, dynamicBlend } from '../lib/pixinsight-mcp/agents/ops/narrowband.mjs';
import { restoreFromClone, cloneImage } from '../lib/pixinsight-mcp/agents/ops/image-mgmt.mjs';
import { stagedHistogramStretch, sharedSpanStretch } from '../lib/pixinsight-mcp/agents/ops/stretch.mjs';
import { probeCatalogs } from '../lib/pixinsight-mcp/agents/ops/tooling.mjs';
import { mltDenoise, measureDenoiseEffect } from '../lib/pixinsight-mcp/agents/ops/denoise-policy.mjs';

const ctx = createBridgeContext({
  log: (m) => { if (process.env.VERBOSE) console.log(m); }
});

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  FAIL  ${name} — ${detail}`); }
}

/** Build a mono or colour window filled with a constant value. */
async function makeFlat(id, channels, value, w = 64, h = 64) {
  await ctx.pjsr(`
    var old = ImageWindow.windowById('${id}');
    if (!old.isNull) old.forceClose();
    var win = new ImageWindow(${w}, ${h}, ${channels}, 32, false, ${channels > 1}, '${id}');
    var v = win.mainView;
    v.beginProcess();
    var img = v.image;
    for (var c = 0; c < ${channels}; c++)
      for (var y = 0; y < ${h}; y++)
        for (var x = 0; x < ${w}; x++)
          img.setSample(${value}, x, y, c);
    v.endProcess();
    'OK';
  `);
}

async function closeAll(ids) {
  for (const id of ids) {
    await ctx.pjsr(`var w = ImageWindow.windowById('${id}'); if (!w.isNull) w.forceClose(); 'OK';`);
  }
}

async function median(viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('view not found: ${viewId}');
    w.mainView.image.median();
  `);
  return parseFloat((r.outputs?.consoleOutput || '').trim());
}

async function main() {
  // --- Is PixInsight reachable? -------------------------------------------
  // pjsr() THROWS BridgeCrashError when the process is gone (rather than
  // returning status:'error'), so the probe has to catch it or the whole file
  // exits 1 on a machine that simply has no PixInsight running.
  let alive;
  try {
    alive = await ctx.pjsr(`'alive'`);
  } catch (e) {
    console.log('SKIP: PixInsight + watcher not reachable — regression tests need a live session.');
    console.log(`      (${e?.message || e})`);
    console.log('      Start PixInsight, run pjsr/pixinsight-mcp-watcher.js, then re-run.');
    return 0;
  }
  if (alive.status === 'error') {
    console.log('SKIP: PixInsight + watcher not reachable — regression tests need a live session.');
    console.log('      Start PixInsight, run pjsr/pixinsight-mcp-watcher.js, then re-run.');
    return 0;
  }

  // === Regression 1: SCNR constants ---------------------------------------
  // removeGreen() used SCNR.prototype.MaximumMasking, which is undefined in
  // PJSR, so the assignment threw "invalid argument type: unsigned integer".
  console.log('\n[1] removeGreen / SCNR parameter types');
  await makeFlat('rg_test', 3, 0.30);
  try {
    await removeGreen(ctx, { view_id: 'rg_test', amount: 0.85 });
    const m = await median('rg_test');
    check('removeGreen runs', Number.isFinite(m), `median not finite: ${m}`);
    check('removeGreen leaves an image', m > 0, `median collapsed to ${m}`);
  } catch (e) {
    check('removeGreen runs', false, e.message);
  }

  // === Regression 2: ChannelCombination.channels --------------------------
  // combineSho() assigned an empty array first, which raises
  // "ChannelCombination.channels(): table length out of range (0)".
  console.log('\n[2] combineSho / ChannelCombination channels table');
  await makeFlat('sho_s', 1, 0.10);
  await makeFlat('sho_h', 1, 0.20);
  await makeFlat('sho_o', 1, 0.30);
  try {
    await combineSho(ctx, { sii_id: 'sho_s', ha_id: 'sho_h', oiii_id: 'sho_o', target_id: 'sho_out' });
    const ch = await ctx.pjsr(`
      var w = ImageWindow.windowById('sho_out');
      w.isNull ? -1 : w.mainView.image.numberOfChannels;
    `);
    const n = parseInt((ch.outputs?.consoleOutput || '-1').trim(), 10);
    check('combineSho produces a 3-channel view', n === 3, `got ${n} channel(s)`);
  } catch (e) {
    check('combineSho produces a 3-channel view', false, e.message);
  }

  // === Regression 3: Image.assign collapses colour -> mono ----------------
  // restoreFromClone() onto a 3-channel target from a mono clone silently
  // turned the target mono, then later channel writes failed with
  // "Image.Set(): invalid channel index".
  console.log('\n[3] restoreFromClone / assign channel collapse guard');
  await makeFlat('clsrc', 1, 0.10);
  await makeFlat('cltgt', 3, 0.20);
  await cloneImage(ctx, 'clsrc', 'clclone');
  let guarded = false;
  try {
    await restoreFromClone(ctx, 'cltgt', 'clclone');
  } catch (e) {
    guarded = /channel count mismatch/i.test(e.message);
  }
  check('mismatched restore is refused, not silently applied', guarded,
    'restoreFromClone did not raise the channel-count guard');
  if (guarded) {
    const after = await ctx.pjsr(`
      var w = ImageWindow.windowById('cltgt');
      w.mainView.image.numberOfChannels;
    `);
    const n = parseInt((after.outputs?.consoleOutput || '0').trim(), 10);
    check('refused restore leaves the target intact', n === 3, `target degraded to ${n} channel(s)`);
  }

  // === Regression 4: staged HT must not flatten the image -----------------
  // The old implementation derived an MTF coefficient with an inverted
  // formula; the image became a flat 0.5 field (MAD = 0), which every
  // downstream stage then "succeeded" on.
  console.log('\n[4] stagedHistogramStretch / no flat-field collapse');
  await makeFlat('ht_test', 3, 0.011);
  // Give it real structure: the bright patch has to cover a decent share of the
  // frame or the MAD statistic rounds to 0 and the test has no signal to move.
  await ctx.pjsr(`
    var w = ImageWindow.windowById('ht_test');
    var v = w.mainView;
    v.beginProcess();
    var img = v.image;
    for (var c = 0; c < 3; c++)
      for (var y = 8; y < 40; y++)
        for (var x = 8; x < 40; x++)
          img.setSample(0.25, x, y, c);
    v.endProcess();
    'OK';
  `);
  const before = await ctx.pjsr(`
    var im = ImageWindow.windowById('ht_test').mainView.image;
    JSON.stringify({ med: im.median(), mad: im.MAD(), mean: im.mean() });
  `);
  const b = JSON.parse((before.outputs?.consoleOutput || '{}').trim());
  // MAD here is the median-of-absolute-deviations, which is 0 whenever most
  // pixels sit exactly on the median — so "has structure" is judged by the mean
  // being meaningfully above the median, not by MAD.
  check('test image starts with structure', b.mean > b.med * 2,
    `mean ${b.mean} is not above median ${b.med} (no signal to stretch)`);
  try {
    await stagedHistogramStretch(ctx, 'ht_test', { targetBackground: 0.15, passes: 2 });
    const after = await ctx.pjsr(`
      var im = ImageWindow.windowById('ht_test').mainView.image;
      JSON.stringify({ med: im.median(), mad: im.MAD(), mean: im.mean(), min: im.minimum(), max: im.maximum() });
    `);
    const a = JSON.parse((after.outputs?.consoleOutput || '{}').trim());
    // The old bug wrote a constant 0.5 everywhere: median, min and max all
    // became identical. That is the flat-field signature to assert against.
    const flat = Math.abs(a.max - a.min) < 1e-9;
    check('stretch does not flatten the image', !flat,
      `min=${a.min} max=${a.max} — image collapsed to a constant field`);
    check('stretch moved the median upward', a.med > b.med,
      `median ${b.med} -> ${a.med} (expected an increase toward 0.15)`);
    check('stretch did not slam to white', a.med < 0.6,
      `median ${a.med} — stretch overshot the target 0.15`);
    check('stretch keeps the bright patch brighter than the background', a.max > a.med,
      `max ${a.max} <= median ${a.med} — structure was lost`);
  } catch (e) {
    check('stagedHistogramStretch runs', false, e.message);
  }

  // === Regression 5: catalog probe ----------------------------------------
  // SPCC no-ops silently without a Gaia catalogue; the probe must say so
  // rather than reporting the process as simply "available".
  console.log('\n[5] probeCatalogs / SPCC silent no-op detection');
  try {
    const c = await probeCatalogs(ctx);
    check('probeCatalogs returns a verdict', typeof c.spccUsable === 'boolean',
      'spccUsable is not boolean');
    check('probeCatalogs explains itself', typeof c.reason === 'string' && c.reason.length > 0,
      'reason is empty — a silent no-op would be undiagnosable');
    console.log(`        catalogue: spccUsable=${c.spccUsable} (${c.reason})`);
  } catch (e) {
    check('probeCatalogs returns a verdict', false, e.message);
  }

  // === Regression 6: staged HT on a MONO image ---------------------------
  // HistogramTransformation's H table is [R, G, B, L, Alpha]. A mono image is
  // driven ONLY by row 3; writing the stretch value into rows 0..2 (correct for
  // colour) makes a mono stretch a silent no-op — the tool reported success and
  // the median never moved. Found while building an HOO from H/O masters.
  console.log('\n[6] stagedHistogramStretch / mono images use the L row');
  await makeFlat('ht_mono', 1, 0.0068);
  await ctx.pjsr(`
    var w = ImageWindow.windowById('ht_mono');
    var v = w.mainView;
    v.beginProcess();
    var img = v.image;
    for (var y = 8; y < 40; y++)
      for (var x = 8; x < 40; x++)
        img.setSample(0.25, x, y);
    v.endProcess();
    'OK';
  `);
  const monoBefore = parseFloat((await ctx.pjsr(`
    ImageWindow.windowById('ht_mono').mainView.image.median();
  `)).outputs?.consoleOutput || '0');
  try {
    const monoRes = await stagedHistogramStretch(ctx, 'ht_mono', { targetBackground: 0.12, passes: 2 });
    const monoAfter = parseFloat((await ctx.pjsr(`
      ImageWindow.windowById('ht_mono').mainView.image.median();
    `)).outputs?.consoleOutput || '0');
    check('mono stretch actually moves the median', monoAfter > monoBefore * 2,
      `median ${monoBefore} -> ${monoAfter} — mono image was untouched (wrong H row)`);
    const noopPass = (monoRes.history || []).some((h) => h.noop);
    check('mono stretch does not report a frozen pass as progress', !noopPass,
      'a pass moved nothing yet was recorded as success');
  } catch (e) {
    check('mono stagedHistogramStretch runs', false, e.message);
  }

  // === Regression 7: dynamicBlend without SII (HOO) -----------------------
  // sii_id was mandatory, so an HOO blend failed with
  // "channel not found: undefined" and forced callers to hand-roll PixelMath.
  console.log('\n[7] dynamicBlend / HOO has no SII channel');
  await makeFlat('db_ha', 1, 0.10);
  await makeFlat('db_o3', 1, 0.20);
  await makeFlat('db_rgb', 3, 0.10);
  try {
    await dynamicBlend(ctx, {
      rgb_id: 'db_rgb', ha_id: 'db_ha', oiii_id: 'db_o3',
      weights: { rHa: 1, gHa: 0.35, gO3: 0.65, bO3: 1 }
    });
    const m = await median('db_rgb');
    check('dynamicBlend works with no sii_id', Number.isFinite(m) && m > 0,
      `median ${m} — blend produced an empty image`);
  } catch (e) {
    check('dynamicBlend works with no sii_id', false, e.message);
  }

  // === Regression 8: per-channel stretch amplifies colour noise -------------
  // Picking a white point per channel gives the weaker channel a smaller span
  // and therefore a LARGER gain, so identical noise lands at different levels.
  // On M27 HOO the O span was 62% of H → 366x vs 230x, i.e. 59% more gain on
  // the same noise, and R/G came out 0.952 instead of ~1.8. sharedSpanStretch()
  // must give every channel the same gain.
  console.log('\n[8] sharedSpanStretch / one span for all channels');
  await ctx.pjsr(`
    var old = ImageWindow.windowById('ss_test');
    if (!old.isNull) old.forceClose();
    var win = new ImageWindow(64, 64, 3, 32, false, true, 'ss_test');
    var v = win.mainView;
    v.beginProcess();
    var img = v.image;
    // R carries 2x the signal of G/B, same noise amplitude -> a per-channel
    // stretch would give G/B a smaller span and more gain.
    for (var y = 0; y < 64; y++) for (var x = 0; x < 64; x++) {
      img.setSample(0.010 + (Math.random() - 0.5) * 0.00002, x, y, 0);
      img.setSample(0.005 + (Math.random() - 0.5) * 0.00002, x, y, 1);
      img.setSample(0.005 + (Math.random() - 0.5) * 0.00002, x, y, 2);
    }
    // a bright patch so the shared span is not degenerate
    for (var y2 = 24; y2 < 40; y2++) for (var x2 = 24; x2 < 40; x2++)
      img.setSample(0.25, x2, y2, 0);
    v.endProcess();
    'OK';
  `);
  try {
    const ss = await sharedSpanStretch(ctx, 'ss_test', { targetMedian: 0.22 });
    const chans = ss.channels || [];
    check('sharedSpanStretch returns per-channel geometry', chans.length === 3,
      `got ${chans.length} channel records`);
    const whites = chans.map((c) => c.white);
    const blacks = chans.map((c) => c.black);
    // Same span everywhere => white_c - black_c identical for every channel.
    const spans = chans.map((c) => c.white - c.black);
    const spanSpread = Math.max(...spans) - Math.min(...spans);
    check('every channel shares one span', spanSpread < 1e-9,
      `span spread ${spanSpread} — channels were stretched independently `
      + `(whites ${whites.map((w) => w.toFixed(6)).join('/')}, `
      + `blacks ${blacks.map((b) => b.toFixed(6)).join('/')})`);
    // Different pedestals per channel is the whole point of per-channel black.
    check('each channel keeps its own black point', new Set(blacks.map((b) => b.toFixed(6))).size > 1,
      'all black points identical — the per-channel pedestal was not measured');
    const st = await ctx.pjsr(`
      var im = ImageWindow.windowById('ss_test').mainView.image;
      im.median();
    `);
    const med = parseFloat((st.outputs?.consoleOutput || '0').trim());
    check('sharedSpanStretch moves the median', med > 0.02 && med < 0.9,
      `median ${med} — stretch produced a flat or blown image`);
  } catch (e) {
    check('sharedSpanStretch runs', false, e.message);
  }

  // === Regression 9: MLT layers column 3 is BIAS, not strength --------------
  // Writing a denoise strength into layers column 3 sets the bias instead: the
  // image came back with 600x the pedestal (0.0068 → 0.21) and no error at all.
  // mltDenoise() must put the strength in noiseThresholdingAmount and leave the
  // pedestal alone.
  console.log('\n[9] mltDenoise / layers column 3 is bias, not strength');
  await ctx.pjsr(`
    var old = ImageWindow.windowById('mlt_test');
    if (!old.isNull) old.forceClose();
    var win = new ImageWindow(128, 128, 3, 32, false, true, 'mlt_test');
    var v = win.mainView;
    v.beginProcess();
    var img = v.image;
    for (var y = 0; y < 128; y++) for (var x = 0; x < 128; x++) {
      img.setSample(0.0068 + (Math.random() - 0.5) * 0.0004, x, y, 0);
      img.setSample(0.0068 + (Math.random() - 0.5) * 0.0004, x, y, 1);
      img.setSample(0.0068 + (Math.random() - 0.5) * 0.0004, x, y, 2);
    }
    v.endProcess();
    'OK';
  `);
  try {
    const base = await measureDenoiseEffect(ctx, 'mlt_test');
    const res = await mltDenoise(ctx, 'mlt_test', { amount: 1.0, threshold: 3.0 });
    check('mltDenoise reports ok', res.status === 'ok', `status ${res.status}: ${res.error || ''}`);
    const after = await measureDenoiseEffect(ctx, 'mlt_test', base);
    // The bias blow-up produced a median far above the ~0.0068 pedestal.
    const pedestalRatio = (after.signal || 0) / (base.signal || 1);
    check('mltDenoise does not inflate the pedestal', pedestalRatio < 2,
      `pedestal went ${base.signal} -> ${after.signal} (${pedestalRatio.toFixed(1)}x) — `
      + 'a strength value reached the layers bias column');
    check('mltDenoise actually reduces noise', after.pass === true,
      `verdict: ${after.verdict}`);
  } catch (e) {
    check('mltDenoise runs', false, e.message);
  }

  await closeAll(['rg_test', 'sho_s', 'sho_h', 'sho_o', 'sho_out',
    'clsrc', 'cltgt', 'clclone', 'ht_test', 'ht_mono',
    'db_ha', 'db_o3', 'db_rgb', 'ss_test', 'mlt_test']);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error('regressions: ' + (e?.stack || e));
    process.exitCode = 1;
  });
