// Offline smoke test for the v1 director-extended command surface.
//
// Unlike test/contract.mjs (which checks a few commands' *policy*), this test
// drives EVERY exported operation once against a recording fake bridge:
//   - the operation must resolve without throwing
//   - every PJSR snippet it emitted must be non-empty and free of obvious
//     interpolation holes (undefined / NaN / [object Object] baked into code)
//   - the returned object must be JSON-serialisable so the CLI can print it
//
// PixInsight is not required.
//
// Run: node test\smoke.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ops = path.join(root, 'lib', 'pixinsight-mcp', 'agents', 'ops');
const load = async (f) => import(pathToFileURL(path.join(ops, f)).href);

// ---------------------------------------------------------------------------
// Recording fake bridge
// ---------------------------------------------------------------------------
class FakeCtx {
  constructor() {
    this.calls = [];
    this.logs = [];
    this.availability = null;
    // Per-case canned replies, consumed in order. Keyword matching alone cannot
    // classify the cached-pixel prelude (it carries grey-corner probes AND the
    // block-labelled corner means), so gates pre-load their answers.
    this.queue = [];
  }
  log(msg) { this.logs.push(String(msg)); }
  async pjsr(code) {
    this.calls.push(code);
    if (this.queue.length) {
      const next = this.queue.shift();
      if (next instanceof Error) {
        return { status: 'error', error: { message: next.message } };
      }
      return { status: 'ok', outputs: { consoleOutput: typeof next === 'string' ? next : JSON.stringify(next) } };
    }
    return { status: 'ok', outputs: { consoleOutput: this.answer(code) } };
  }
  /** Deterministic answers keyed on what the snippet is asking for. */
  answer(code) {
    const n = this.calls.length;
    const J = (o) => JSON.stringify(o);

    // --- process detection probe
    if (code.includes('try { var _p_')) {
      return J(Object.fromEntries(
        ['GradientCorrection', 'MultiscaleGradientCorrection', 'GraXpert',
          'DynamicBackgroundExtraction', 'HistogramTransformation', 'SCNR',
          'CurvesTransformation', 'MaskedStretch'].map((k) => [k, true])
      ));
    }
    // --- image dimensions
    if (code.includes('JSON.stringify({ width: img.width')) {
      return J({ width: 3000, height: 2000, channels: 3, color: true });
    }
    // --- bare dimension probe (masks.createOiiiMask and friends)
    if (/JSON\.stringify\(\{\s*w: Math\.round\(img\.width\)/.test(code)) {
      return J({ w: 3000, h: 2000, color: true });
    }
    // --- channel/colour probe used by structure.maskedSaturation
    if (code.includes('color: img.isColor, mad: img.MAD()')) {
      return J({ channels: 3, color: true, mad: 0.0011 });
    }
    // --- per-channel median (background.measureBackground)
    if (code.includes('r: meds[0]')) return J({ mono: false, r: 0.021, g: 0.028, b: 0.019 });
    // --- per-channel median/mad (colorMix.channelStats)
    if (/median\.push\(/.test(code)) {
      return J({ channels: 3, median: [0.021, 0.028, 0.019], mad: [0.0009, 0.0011, 0.0008], max: 0.87 });
    }
    // --- statistics / STF / acceptance
    if (code.includes('hist') || code.includes('bins')) {
      return J({
        median: 0.02, mean: 0.025, mad: 0.001, min: 0.0005, max: 0.87,
        channelMedian: [0.02, 0.021, 0.019], channelMad: [0.001, 0.001, 0.0009],
        channelMean: [0.025, 0.026, 0.024],
        histogram: [40, 30, 20, 10, 5, 3, 2, 1, 1, 1].concat(new Array(246).fill(0))
      });
    }
    if (code.includes('corner_means')) {
      return J({ mean: 0.02, sd: 0.001, cv: 0.05, corner_means: [0.02, 0.02, 0.02, 0.02] });
    }
    // --- noise measurement (block grid)
    if (code.includes('block') || code.includes('bs')) {
      return J({ sigma: 0.0012, blocks: 96, blockMedian: 0.002, perChannel: [0.0011, 0.0012, 0.0013] });
    }
    // --- fallback single-image statistics
    if (code.includes('median:')) return J({ median: 0.02, mad: 0.001, max: 0.8, min: 0.0004, mean: 0.03 });
    // --- anything else: an empty success (process execution snippets)
    return '';
  }
}

// ---------------------------------------------------------------------------
// Snippet hygiene
// ---------------------------------------------------------------------------
function checkSnippet(op, code) {
  const s = String(code ?? '');
  assert.ok(s.trim().length > 0, `${op}: emitted an empty PJSR snippet`);
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    assert.ok(!s.includes(bad), `${op}: PJSR snippet contains "${bad}":\n${s.slice(0, 400)}`);
  }
}

function checkSerialisable(op, value) {
  try {
    const s = JSON.stringify(value);
    assert.ok(s !== undefined, `${op}: result is not JSON-serialisable (returned undefined)`);
  } catch (err) {
    assert.fail(`${op}: result is not JSON-serialisable: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Case table: one entry per exported operation
// ---------------------------------------------------------------------------
const VIEW = 'IMG';
const M2 = 'IMG2';

const cases = [
  // stats.mjs
  ['stats.getStats', 'stats.mjs', 'getStats', [VIEW]],
  ['stats.measureUniformity', 'stats.mjs', 'measureUniformity', [VIEW]],
  ['stats.computeSTF', 'stats.mjs', 'computeSTF', [VIEW]],
  ['stats.acceptanceCheck', 'stats.mjs', 'acceptanceCheck', [VIEW, { stage: 'smoke', phase: 'linear' }]],
  ['stats.enforceAcceptance', 'stats.mjs', 'enforceAcceptance', [VIEW, { stage: 'smoke', strict: false }]],

  // tooling.mjs
  ['tooling.detectTools', 'tooling.mjs', 'detectTools', [{ force: true }]],
  ['tooling.resolveTool', 'tooling.mjs', 'resolveTool', ['sharpen']],
  ['tooling.capabilityReport', 'tooling.mjs', 'capabilityReport', [{ force: true }]],
  ['tooling.hasTool', 'tooling.mjs', 'hasTool', ['SCNR']],

  // preprocess.mjs
  ['preprocess.starAlign', 'preprocess.mjs', 'starAlign', [{ reference_id: VIEW, source_ids: [M2], target_id: M2 }]],
  ['preprocess.dynamicCrop', 'preprocess.mjs', 'dynamicCrop', [{ view_ids: [VIEW, M2], margin: 100 }]],
  ['preprocess.imageIntegration', 'preprocess.mjs', 'imageIntegration', [{ source_ids: [VIEW, M2], target_id: 'INT' }]],
  ['preprocess.checkRegistration', 'preprocess.mjs', 'checkRegistration', [[VIEW, M2]]],

  // background.mjs
  ['background.gradientCorrect', 'background.mjs', 'gradientCorrect', [VIEW]],
  ['background.gradientCorrectChannels', 'background.mjs', 'gradientCorrectChannels', [[VIEW, M2]]],
  ['background.measureBackground', 'background.mjs', 'measureBackground', [VIEW]],
  ['background.backgroundNeutralize', 'background.mjs', 'backgroundNeutralize', [VIEW]],

  // structure.mjs
  ['structure.darkStructureEnhance', 'structure.mjs', 'darkStructureEnhance', [VIEW]],
  ['structure.rangeMask', 'structure.mjs', 'rangeMask', [VIEW]],
  ['structure.maskedSaturation', 'structure.mjs', 'maskedSaturation', [VIEW, { mask_id: 'MASK' }]],

  // color-mix.mjs
  ['colorMix.oiiiSynthesis', 'color-mix.mjs', 'oiiiSynthesis', [{ source_id: VIEW, target_id: 'O3' }]],
  ['colorMix.integrateOiii', 'color-mix.mjs', 'integrateOiii', [{ estimates: ['O3', 'O3b'] }]],
  ['colorMix.estimateContinuumQ', 'color-mix.mjs', 'estimateContinuumQ', [{ ha_id: VIEW, rgb_red_id: M2 }]],
  ['colorMix.haCleanRefine', 'color-mix.mjs', 'haCleanRefine', [{ ha_id: VIEW, rgb_red_id: M2 }]],
  ['colorMix.injectHa', 'color-mix.mjs', 'injectHa', [{ target_id: VIEW, ha_clean_id: 'HC' }]],
  ['colorMix.channelWeightBlend', 'color-mix.mjs', 'channelWeightBlend', [{ sii_id: 'S', ha_id: 'H', oiii_id: 'O' }]],

  // narrowband.mjs
  ['narrowband.combineSho', 'narrowband.mjs', 'combineSho', [{ sii_id: 'S', ha_id: 'H', oiii_id: 'O', target_id: 'SHO' }]],
  ['narrowband.dynamicBlend', 'narrowband.mjs', 'dynamicBlend', [{ rgb_id: VIEW, sii_id: 'S', ha_id: 'H', oiii_id: 'O' }]],
  ['narrowband.extractCleanHa', 'narrowband.mjs', 'extractCleanHa', [{ ha_id: 'H', red_id: 'R', out_id: 'HC' }]],
  ['narrowband.injectHa', 'narrowband.mjs', 'injectHa', [{ target_id: VIEW, ha_clean_id: 'HC' }]],
  ['narrowband.mixOiii', 'narrowband.mjs', 'mixOiii', [{ source_id: VIEW, out_id: 'O3MIX' }]],
  ['narrowband.extractChannel', 'narrowband.mjs', 'extractChannel', [{ source_id: VIEW, out_id: 'RED', channel: 0 }]],

  // star-handling.mjs
  ['stars.separateStars', 'star-handling.mjs', 'separateStars', [{ source_id: VIEW }]],
  ['stars.fixStarColor', 'star-handling.mjs', 'fixStarColor', [{ view_id: VIEW }]],
  ['stars.removeGreen', 'star-handling.mjs', 'removeGreen', [{ view_id: VIEW }]],
  ['stars.shrinkStars', 'star-handling.mjs', 'shrinkStars', [{ view_id: VIEW }]],
  ['stars.recombineStars', 'star-handling.mjs', 'recombineStars', [{ starless_id: VIEW, stars_id: M2 }]],
  ['stars.denoiseChroma', 'star-handling.mjs', 'denoiseChroma', [{ view_id: VIEW }]],

  // denoise-policy.mjs
  ['denoise.measureNoise', 'denoise-policy.mjs', 'measureNoise', [VIEW]],
  ['denoise.autoDenoise', 'denoise-policy.mjs', 'autoDenoise', [VIEW, { phase: 'linear' }]],
  ['denoise.applyDenoise', 'denoise-policy.mjs', 'applyDenoise', [VIEW, { denoise: 0.5, detail: 0.15, method: 'NXT' }, { tool: 'NoiseXTerminator' }]],

  // stretch.mjs
  ['stretch.setiStretch', 'stretch.mjs', 'setiStretch', [VIEW]],
  ['stretch.ghsStretch', 'stretch.mjs', 'ghsStretch', [VIEW]],
  ['stretch.masStretch', 'stretch.mjs', 'masStretch', [VIEW]],
  ['stretch.stagedHistogramStretch', 'stretch.mjs', 'stagedHistogramStretch', [VIEW]],
  ['stretch.arcsinhStretch', 'stretch.mjs', 'arcsinhStretch', [VIEW]],
  ['stretch.channelHistogramStretch', 'stretch.mjs', 'channelHistogramStretch', [VIEW]],
  ['stretch.linearFit', 'stretch.mjs', 'linearFit', [{ reference_id: VIEW, target_id: M2 }]],

  // masks.mjs
  ['masks.createMask', 'masks.mjs', 'createMask', [VIEW, 'MASK']],
  ['masks.createLumMask', 'masks.mjs', 'createLumMask', [VIEW, 'LMASK']],
  ['masks.applyMask', 'masks.mjs', 'applyMask', [VIEW, 'MASK']],
  ['masks.removeMask', 'masks.mjs', 'removeMask', [VIEW]],
  ['masks.closeMask', 'masks.mjs', 'closeMask', ['MASK']],
  ['masks.createOiiiMask', 'masks.mjs', 'createOiiiMask', [VIEW, 'OMASK']],

  // image-mgmt.mjs
  ['imageMgmt.cloneImage', 'image-mgmt.mjs', 'cloneImage', [VIEW, 'CLONE']],
  ['imageMgmt.restoreFromClone', 'image-mgmt.mjs', 'restoreFromClone', [VIEW, 'CLONE']],
  ['imageMgmt.closeImage', 'image-mgmt.mjs', 'closeImage', [VIEW]],
  ['imageMgmt.purgeUndoHistory', 'image-mgmt.mjs', 'purgeUndoHistory', [VIEW]],

  // quality-gates.mjs
  ['quality.checkStarQuality', 'quality-gates.mjs', 'checkStarQuality', [VIEW]],
  ['quality.checkRinging', 'quality-gates.mjs', 'checkRinging', [VIEW]],
  ['quality.checkSharpness', 'quality-gates.mjs', 'checkSharpness', [VIEW]],
  ['quality.checkCoreBurning', 'quality-gates.mjs', 'checkCoreBurning', [VIEW]],
  ['quality.scanBurntRegions', 'quality-gates.mjs', 'scanBurntRegions', [VIEW]],
  ['quality.checkSaturation', 'quality-gates.mjs', 'checkSaturation', [VIEW]],
  ['quality.checkTonalPresence', 'quality-gates.mjs', 'checkTonalPresence', [VIEW, 'nebula']],
  ['quality.checkHighlightTexture', 'quality-gates.mjs', 'checkHighlightTexture', [VIEW]],
  ['quality.checkStarLayerIntegrity', 'quality-gates.mjs', 'checkStarLayerIntegrity', [VIEW]],
  ['quality.checkBrightChroma', 'quality-gates.mjs', 'checkBrightChroma', [VIEW]],

  // preview.mjs
  ['preview.autoStretch', 'preview.mjs', 'autoStretch', [VIEW]]
];

// ---------------------------------------------------------------------------
// Quality gates: canned replies in call order
// ---------------------------------------------------------------------------
// Most gates run a single statistics read after their pixel-cache prelude; the
// few that run warm-up probes first get their own queue.
const GATE_REPLIES = {
  'quality.checkStarQuality': [{
    starsFound: 120, starsMeasured: 30, medianFWHM: 2.8, colorDiversity: 0.22,
    fwhms: [2.6, 2.8], colorDivs: [0.2, 0.24], medianPeak: 0.4, p25Peak: 0.3,
    bgMedian: 0.02, starBgContrast: 20, starPeaks: [0.6, 0.5]
  }],
  'quality.checkRinging': [{ ringingScore: 0.04, peakValue: 0.7, samplesUsed: 400 }],
  'quality.checkSharpness': [{ sharpness: 0.0031, samplesUsed: 5000, roi: { x: 0, y: 0, w: 1500, h: 1000 } }],
  'quality.checkCoreBurning': [{
    burntFraction: 0.001, innerBurntFraction: 0.0, peakValue: 0.92, coreCenter: [1500, 1000]
  }],
  'quality.scanBurntRegions': [{
    burntBlockCount: 0, totalBlocks: 2400, blockSize: 50, threshold: 0.95, worstBlocks: []
  }],
  'quality.checkSaturation': [{
    medianS: 0.18, p90S: 0.42, p99S: 0.6, maxS: 0.8, subjectPixelCount: 12000
  }],
  'quality.checkTonalPresence': [{
    subject_median: 0.11, background_median: 0.02, separation: 5.5,
    core_brightness: 0.4, faint_structure_visibility: 0.08
  }],
  // One measurement per view; only the current view is measured without a reference.
  'quality.checkHighlightTexture': [
    { shellLocalStdDev: 0.019, shellTonalSpan: 0.19, shellGradientEnergy: 0.4, shellPixelCount: 900,
      blockCount: 40, shellZone: { low: 0.9, high: 0.99 }, roi: { cx: 1500, cy: 1000, radius: 600 }, bgMedian: 0.02 }
  ],
  'quality.checkStarLayerIntegrity': [{
    max_value: 0.88, clipped_fraction_995: 0.001, clipped_fraction_98: 0.01,
    color_diversity: 0.14, bright_star_chroma: 0.06
  }],
  'quality.checkBrightChroma': [{
    medianChroma: 0.05, meanChroma: 0.07, p25Chroma: 0.03, p75Chroma: 0.09,
    brightPixelCount: 4000
  }]
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const failures = [];
for (const [name, file, fnName, args] of cases) {
  const mod = await load(file);
  const fn = mod[fnName];
  if (typeof fn !== 'function') {
    failures.push(`${name}: ${file} does not export ${fnName}()`);
    continue;
  }
  const ctx = new FakeCtx();
  if (GATE_REPLIES[name]) {
    ctx.queue = GATE_REPLIES[name].slice();
    // Any extra statistics read falls back to a generic reply rather than
    // the (now ambiguous) keyword matcher.
    ctx.answer = () => JSON.stringify({});
  }
  try {
    const out = await fn(ctx, ...args);
    for (const call of ctx.calls) checkSnippet(name, call);
    checkSerialisable(name, out);
    if (GATE_REPLIES[name] && ctx.queue.length) {
      failures.push(`${name}: consumed ${GATE_REPLIES[name].length - ctx.queue.length} of ${GATE_REPLIES[name].length} canned replies — update GATE_REPLIES`);
    }
    console.log(`ok  ${name}  (${ctx.calls.length} pjsr call${ctx.calls.length === 1 ? '' : 's'})`);
  } catch (err) {
    failures.push(`${name}: threw ${err.message}`);
  }
}

// Functions that need live state (preview.savePreview writes files) are only
// checked for being exported rather than executed.
const { savePreview } = await load('preview.mjs');
assert.equal(typeof savePreview, 'function', 'preview.mjs must export savePreview()');

if (failures.length) {
  console.error(`\n${failures.length} smoke failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exitCode = 1;
} else {
  console.log(`\nall ${cases.length} smoke operations passed`);
}
