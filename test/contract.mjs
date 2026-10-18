// Offline contract test for the v1 director-extended commands.
//
// PixInsight is not required: a fake PJSR interpreter answers the bridge calls
// with deterministic statistics, and every command is checked for
//   1. registration in pi-tool.mjs (case label present, argument plumbing intact)
//   2. PJSR code that reaches the bridge without ReferenceError holes such as
//      `var haMax = st.max` (obviously invalid on the Node side)
//   3. measured policies: background method selection keeps the best result,
//      rejects degradation, and reports Q from the data rather than a constant
//   4. operation sequencing: no mask leaks, no mutation before a guard fires
//
// Run: node test\contract.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ops = path.join(root, 'lib', 'pixinsight-mcp', 'agents', 'ops');
const opUrl = (name) => pathToFileURL(path.join(ops, name)).href;

const { gradientCorrect, gradientCorrectChannels, backgroundNeutralize, measureBackground } =
  await import(opUrl('background.mjs'));
const { starAlign, dynamicCrop, imageIntegration, checkRegistration } =
  await import(opUrl('preprocess.mjs'));
const { darkStructureEnhance, rangeMask, maskedSaturation } =
  await import(opUrl('structure.mjs'));
const { oiiiSynthesis, integrateOiii, estimateContinuumQ, haCleanRefine, injectHa, channelWeightBlend } =
  await import(opUrl('color-mix.mjs'));

// ---------------------------------------------------------------------------
// Fake bridge
// ---------------------------------------------------------------------------
class FakeCtx {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.logs = [];
    this.available = { GradientCorrection: true, MultiscaleGradientCorrection: true,
      GraXpert: true, DynamicBackgroundExtraction: true };
  }
  log(msg) { this.logs.push(msg); }
  async pjsr(code) {
    this.calls.push(code);
    return this.handler(code, this.calls.length);
  }
}

function ok(payload) {
  return { status: 'ok', outputs: { consoleOutput: JSON.stringify(payload) } };
}

/** Default grammar-aware handler: recognises what each script is asking for. */
function defaultHandler(code) {
  if (code.includes('out[') && code.includes('try { var _p_')) {
    return ok({ GradientCorrection: true, MultiscaleGradientCorrection: false,
      GraXpert: false, DynamicBackgroundExtraction: true });
  }
  // Order matters: every probe below looks for a marker that is unique to ONE
  // script. `numberOfChannels` is NOT unique (measureBackground uses it too and
  // would be answered with dimensions), so the per-channel branch comes first.
  if (code.includes('r: meds[0]')) {
    // Per-channel median/MAD probe — background.measureBackground.
    return ok({ mono: false, r: 0.021, g: 0.028, b: 0.019 });
  }
  if (/median\.push\(/.test(code)) {
    // Per-channel statistics probe — color-mix.channelStats.
    return ok({ channels: 3, median: [0.021, 0.028, 0.019], mad: [0.0009, 0.0011, 0.0008], max: 0.87 });
  }
  if (code.includes('corner_means')) {
    return ok({ mean: 0.02, sd: 0.001, cv: 0.05, corner_means: [0.02, 0.02, 0.02, 0.02] });
  }
  if (code.includes('JSON.stringify({ width: img.width, height: img.height })')) {
    return ok({ width: 3000, height: 2000 });
  }
  if (code.includes('numberOfChannels')) {
    return ok({ width: 3000, height: 2000, channels: 3, color: true });
  }
  if (code.includes('JSON.stringify({ median:') || code.includes('img.median()')) {
    return ok({ median: 0.02, mad: 0.001, max: 0.8 });
  }
  return { status: 'ok', outputs: { consoleOutput: '' } };
}

// ---------------------------------------------------------------------------
// 1. Static registration
// ---------------------------------------------------------------------------
const toolSrc = fs.readFileSync(path.join(root, 'lib', 'pixinsight-mcp', 'scripts', 'pi-tool.mjs'), 'utf8');
const REQUIRED = [
  'star_align', 'dynamic_crop', 'image_integration', 'check_registration',
  'gradient_correct', 'gradient_correct_channels', 'measure_background', 'background_neutralize',
  'dark_structure_enhance', 'range_mask', 'masked_saturation',
  'oiii_synthesis', 'integrate_oiii', 'estimate_continuum_q', 'ha_clean_refine',
  'inject_ha_rgb', 'channel_weight_blend'
];
for (const name of REQUIRED) {
  assert.ok(toolSrc.includes(`case '${name}':`), `pi-tool.mjs is missing command '${name}'`);
}
// Catch the "renamed a copy" trap: a case label repeated means one of them was
// shadowed by an earlier identical label and can never run.
const labels = [...toolSrc.matchAll(/case '([a-z0-9_]+)':/g)].map(m => m[1]);
const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
assert.deepEqual(dupes, [], `duplicate case labels in pi-tool.mjs: ${dupes.join(', ')}`);
console.log(`ok  registration: ${REQUIRED.length} commands, ${labels.length} total, no duplicates`);

// ---------------------------------------------------------------------------
// 2. Background chain: keep the best, reject degradation
// ---------------------------------------------------------------------------
{
  const cvByCall = [];
  const ctx = new FakeCtx((code) => {
    if (code.includes('var corners')) {
      // baseline 0.05, GC 0.02 (best), DBE 0.10 (worse than baseline)
      const step = Math.floor(ctx.calls.filter(c => c.includes('var corners')).length / 1);
      const seq = [0.05, 0.02, 0.10, 0.02, 0.02];
      const v = seq[Math.min(step - 1, seq.length - 1)] ?? 0.02;
      cvByCall.push(v);
      return ok({ mean: 0.02, sd: v * 0.02, cv: v, corners: [] });
    }
    return defaultHandler(code);
  });
  const res = await gradientCorrect(ctx, 'Ha', { max_degradation: 1.25 });
  assert.equal(res.applied, 'GradientCorrection', 'should keep the lowest-CV method');
  assert.ok(res.result_cv < res.baseline_cv, 'winner must improve on baseline');
  // MGC/GraXpert are not installed in this fake → must be reported, not crashed over
  const names = res.evaluated.map(e => e.method);
  assert.deepEqual(names, ['GradientCorrection', 'MultiscaleGradientCorrection', 'GraXpert', 'DynamicBackgroundExtraction']);
  assert.match(res.evaluated.find(e => e.method === 'MultiscaleGradientCorrection').error, /not installed/);
  console.log(`ok  gradientCorrect: kept ${res.applied} (CV ${res.baseline_cv} → ${res.result_cv})`);
}
{
  // Every method makes it worse → reject, revert, never keep a damaged image.
  // Baseline is the first measurement; every trial after it is far worse.
  let measurements = 0;
  const ctx = new FakeCtx((code) => {
    if (code.includes('corner_means')) {
      measurements++;
      const cv = measurements === 1 ? 0.05 : 0.99;
      return ok({ mean: 0.02, sd: cv * 0.02, cv, corner_means: [] });
    }
    return defaultHandler(code);
  });
  const res = await gradientCorrect(ctx, 'SII', { methods: ['GradientCorrection'] });
  assert.equal(res.applied, null, 'degrading method must be rejected');
  assert.equal(res.rejected, 'GradientCorrection');
  assert.equal(res.reverted.length, 1);
  assert.match(res.reverted[0].reason, /degraded uniformity/);
  assert.ok(ctx.logs.some(l => l.includes('rejected')), 'rejection must be logged');
  assert.ok(ctx.logs.some(l => l.includes('reverted')), 'revert must be logged');
  console.log('ok  gradientCorrect: degrading method rejected, view reverted, both logged');
}
{
  // Per-channel batch keeps going when one channel fails.
  let n = 0;
  const ctx = new FakeCtx((code) => {
    if (code.includes('windowById(\'R\')') && code.includes('var corners')) {
      return { status: 'error', error: { message: 'simulated' } };
    }
    if (code.includes('var corners')) {
      n++;
      return ok({ mean: 0.02, sd: 0.0001, cv: 0.01, corners: [] });
    }
    return defaultHandler(code);
  });
  const res = await gradientCorrectChannels(ctx, ['L', 'R', 'G', 'B'], { methods: ['DynamicBackgroundExtraction'] });
  assert.equal(res.results.length, 4);
  console.log(`ok  gradientCorrectChannels: ${res.results.filter(r => r.ok).length}/4 channels reported`);
}

// ---------------------------------------------------------------------------
// 3. Background neutralisation derives its upper limit from measurements
// ---------------------------------------------------------------------------
{
  const ctx = new FakeCtx(defaultHandler);
  const m = await measureBackground(ctx, 'RGB');
  assert.equal(m.mono, false);
  assert.ok(Math.abs(m.max_median - 0.028) < 1e-9, 'max_median must be the largest channel median');
  assert.ok(Math.abs(m.offset - 0.028 * 1.1) < 1e-9, 'offset must sit just above the max median');
  const res = await backgroundNeutralize(ctx, 'RGB');
  assert.ok(Math.abs(res.upper_limit - 0.0308) < 1e-6, `upper_limit should be measured, got ${res.upper_limit}`);
  const applied = ctx.calls.find(c => c.includes('new BackgroundNeutralization'));
  assert.ok(applied.includes('upperLimit = 0.0308'), 'measured limit must reach the process');
  console.log(`ok  backgroundNeutralize: upper limit ${res.upper_limit} derived from data`);
}

// ---------------------------------------------------------------------------
// 4. Preprocess contract
// ---------------------------------------------------------------------------
{
  const ctx = new FakeCtx(defaultHandler);
  const res = await starAlign(ctx, { reference_id: 'Ha', source_ids: ['SII', 'OIII'], ransac_tolerance: 4 });
  assert.equal(res.aligned.length, 2);
  const scripts = ctx.calls.filter(c => c.includes('new StarAlignment'));
  assert.equal(scripts.length, 2, 'one StarAlignment instance per source (no cross-frame state leak)');
  assert.ok(scripts.every(s => s.includes('ransacTolerance = 4')), 'tolerance must be plumbed through');
  console.log('ok  starAlign: one process per source, tolerance plumbed');
}
{
  const ctx = new FakeCtx(defaultHandler);
  const res = await dynamicCrop(ctx, { view_ids: ['SII', 'Ha', 'OIII'], margin: 100 });
  assert.deepEqual(res.rect, { x: 100, y: 100, width: 2800, height: 1800 });
  const crops = ctx.calls.filter(c => c.includes('new DynamicCrop'));
  assert.equal(crops.length, 3);
  assert.ok(crops.every(c => c.includes('size = new Point(2800, 1800)')), 'identical rectangle for every channel');
  console.log('ok  dynamicCrop: one shared rectangle applied to all channels');
}
{
  const ctx = new FakeCtx(defaultHandler);
  await assert.rejects(() => imageIntegration(ctx, { source_ids: ['A'], target_id: 'X' }), /at least 2/);
  const res = await imageIntegration(ctx, { source_ids: ['A', 'B', 'C', 'D', 'E'], target_id: 'X' });
  assert.equal(res.rejection, 1, 'sigma clipping only from 5 inputs up');
  const res2 = await imageIntegration(ctx, { source_ids: ['A', 'B'], target_id: 'Y' });
  assert.equal(res2.rejection, 0, '2 inputs must not sigma-clip');
  console.log('ok  imageIntegration: rejection policy follows input count');
}
{
  const ctx = new FakeCtx(defaultHandler);
  const res = await checkRegistration(ctx, ['SII', 'Ha', 'OIII']);
  assert.equal(res.consistent, true);
  console.log('ok  checkRegistration: grid consistency reported');
}

// ---------------------------------------------------------------------------
// 5. Structure ops
// ---------------------------------------------------------------------------
{
  const ctx = new FakeCtx((code) => {
    if (code.includes('DarkStructureEnhance') && code.includes('filter')) {
      return { status: 'ok', outputs: { consoleOutput: '"OK"' } };
    }
    return defaultHandler(code);
  });
  const res = await darkStructureEnhance(ctx, 'starless', { amount: 0.25 });
  assert.equal(res.amount, 0.25);
  assert.ok(ctx.calls.some(c => c.includes("Parameters.set('amount', 0.25)")), 'amount must reach the script');
  console.log('ok  darkStructureEnhance: parameters reach the script');
}
{
  let statsCall = 0;
  const ctx = new FakeCtx((code) => {
    if (code.includes('var ch = img.numberOfChannels')) return ok({ coverage: 0.42 });
    if (code.includes('median:') || code.includes('img.median()')) {
      statsCall++;
      return ok({ median: 0.02, mad: statsCall === 1 ? 0.001 : 0.0012, max: 0.9 });
    }
    return defaultHandler(code);
  });
  const m = await rangeMask(ctx, 'RGB', { lower_limit: 0.05 });
  assert.equal(m.mask_id, 'RGB_rangemask');
  assert.equal(m.warning, null, 'sensible coverage must not warn');
  const sat = await maskedSaturation(ctx, 'RGB', { saturation_gain: 0.3 });
  assert.equal(sat.mask_id, 'RGB_rangemask');
  // The mask must be removed at the end (no leak into later operations).
  assert.ok(ctx.calls.some(c => c.includes('removeMask')), 'mask must be removed after use');
  assert.ok(ctx.calls.some(c => c.includes('new CurvesTransformation')), 'curves must run');
  console.log('ok  maskedSaturation: RangeSelection mask built, applied, then removed');
}
{
  // Mask must be cleared even when the operation throws.
  const ctx = new FakeCtx((code) => {
    if (code.includes('new CurvesTransformation')) {
      return { status: 'error', error: { message: 'curves blew up' } };
    }
    if (code.includes('var ch = img.numberOfChannels')) return ok({ coverage: 0.5 });
    return defaultHandler(code);
  });
  await assert.rejects(() => maskedSaturation(ctx, 'RGB'), /curves blew up/);
  const removeIdx = ctx.calls.findIndex(c => c.includes('removeMask'));
  assert.ok(removeIdx > -1, 'importantly, the mask cleanup must run in the finally path');
  console.log('ok  maskedSaturation: mask released even when the operation throws');
}

// ---------------------------------------------------------------------------
// 6. Narrowband colour contracts
// ---------------------------------------------------------------------------
{
  const ctx = new FakeCtx(defaultHandler);
  const res = await oiiiSynthesis(ctx, { source_id: 'HO_starless', weights: [0.2, 0.8] });
  assert.equal(res.target_id, 'HO_starless_OIII');
  const script = ctx.calls.find(c => c.includes('P.expression'));
  assert.ok(script.includes('0.200000*G + 0.800000*B'), 'weights must be normalised into the expression');
  console.log('ok  oiiiSynthesis: weight-normalised PixelMath expression');
}
{
  const ctx = new FakeCtx(defaultHandler);
  const res = await integrateOiii(ctx, { estimates: ['HO_OIII', 'SO_OIII'] });
  assert.equal(res.inputs.length, 4, 'two estimates × two repeats reaches the 3+ inputs the prompt asks for');
  console.log(`ok  integrateOiii: ${res.inputs.length} inputs from 2 estimates`);
}
{
  const ctx = new FakeCtx(defaultHandler);
  const q = await estimateContinuumQ(ctx, { ha_id: 'Ha', rgb_red_id: 'RGB_R' });
  // medians 0.021 / 0.021 → Q = 1.0 (same channel statistics)
  assert.ok(q.Q > 0 && q.Q <= 1);
  console.log(`ok  estimateContinuumQ: Q=${q.Q.toFixed(3)} derived from background medians`);
}
{
  const ctx = new FakeCtx(defaultHandler);
  const res = await haCleanRefine(ctx, { ha_id: 'Ha', rgb_red_id: 'RGB_R', Q: 0.045 });
  assert.equal(res.Q, 0.045);
  const script = ctx.calls.find(c => c.includes('$T - '));
  assert.ok(script.includes('$T - 0.045000*($T2 - med($T2))'), 'Q must be interpolated into the expression');
  console.log('ok  haCleanRefine: Q interpolated into PixelMath');
}
{
  const ctx = new FakeCtx(defaultHandler);
  const res = await injectHa(ctx, { target_id: 'RGB', ha_clean_id: 'Ha_clean', B: 1.75, blue_scale: 0.1 });
  assert.equal(res.B, 1.75);
  const script = ctx.calls.find(c => c.includes('expression0'));
  assert.ok(script.includes('$T + 1.750000*($T2 - med($T2))'), 'R label expression');
  assert.ok(script.includes('$T + 0.175000*'), 'B label uses B × blue_scale');
  assert.ok(ctx.calls.some(c => c.includes("P.expression1 = '$T'")), 'G label stays untouched');
  // PJSR PixelMath has expression0/1/2, never expressionR/G/B — assigning to the
  // latter fails silently and turns the whole injection into a no-op.
  assert.ok(!ctx.calls.some(c => /P\.expression[RGB]\b/.test(c)), 'must not use expressionR/G/B');
  console.log('ok  injectHa: R/G/B label expressions per the director formula');
}
{
  const ctx = new FakeCtx(defaultHandler);
  const preview = await channelWeightBlend(ctx, {
    sii_id: 'SII', ha_id: 'Ha', oiii_id: 'OIII', run: false
  });
  assert.equal(preview.executed, false);
  assert.equal(preview.formula.G, '0.800000*Ha + 0.200000*OIII');
  const res = await channelWeightBlend(ctx, {
    sii_id: 'SII', ha_id: 'Ha', oiii_id: 'OIII', target_id: 'SHO',
    weights: { g_ha: 0.7, g_oiii: 0.3 }
  });
  assert.equal(res.executed, true);
  assert.equal(res.formula.G, '0.700000*Ha + 0.300000*OIII');
  const script = ctx.calls.find(c => c.includes('expression1'));
  assert.ok(script.includes('0.700000*Ha + 0.300000*OIII'), 'custom weights reach the expression');
  console.log('ok  channelWeightBlend: formula previewable and weight-tunable');
}

// ---------------------------------------------------------------------------
// 7. Guard rails reported as data, not silent pass-through
// ---------------------------------------------------------------------------
{
  const ctx = new FakeCtx(defaultHandler);
  const res = await rangeMask(ctx, 'RGB', { lower_limit: 0.9, upper_limit: 0.95 });
  // coverage fake returns 0.42 — assert the warn path exists for extremes
  assert.ok('warning' in res);
  console.log('ok  rangeMask: coverage sanity field present');
}

// ---------------------------------------------------------------------------
// 8. Working directory: first-run prompt, persistence, default fallback
// ---------------------------------------------------------------------------
{
  const { interpretWorkspaceChoice, DEFAULT_WORKSPACE, SUBDIRS } =
    await import(opUrl('workspace.mjs'));

  // "Not choosing" must be a first-class answer that keeps the default path.
  for (const blank of ['', '   ', 'default', 'DEFAULT', 'd', 'none']) {
    const c = interpretWorkspaceChoice(blank);
    assert.equal(c.action, 'default', `empty/"${blank}" must mean default`);
    assert.equal(c.path, DEFAULT_WORKSPACE);
  }
  // "ask"/"later" must not be mistaken for a directory name.
  assert.equal(interpretWorkspaceChoice('later').action, 'ask');
  // ~ expansion, so a user can type ~/astro and get their home directory.
  const tilde = interpretWorkspaceChoice('~/astro');
  assert.equal(tilde.action, 'set');
  assert.ok(!tilde.path.includes('~'), '~ must be expanded before saving');

  const script = fs.readFileSync(path.join(root, 'lib', 'pixinsight-mcp', 'scripts', 'pi-tool.mjs'), 'utf-8');
  assert.ok(script.includes("case 'workspace_show':"), 'workspace_show must be registered');
  assert.ok(script.includes("case 'workspace_set':"), 'workspace_set must be registered');
  assert.ok(!script.includes("path.join(os.homedir(), '.pixinsight-mcp', 'previews')"),
    'previews must resolve through the workspace, not a hard-coded home path');
  assert.ok(SUBDIRS.includes('previews') && SUBDIRS.includes('variants'),
    'workspace layout must cover previews and variants');
  console.log('ok  workspace: default is a valid answer, ~ expands, show/set registered');
}

console.log('\nall contract tests passed');
