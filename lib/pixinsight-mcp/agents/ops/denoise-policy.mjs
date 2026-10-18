// ============================================================================
// Denoise policy — "噪声一旦变强就酌情轻降" (denoise opportunistically)
//
// The director prompt forbids saving all noise reduction for the end:
//   - Linear stage: gentle only (Denoise 0.5–0.7, Detail 0.15)
//   - Nonlinear stage: lighter still, applied where noise resurfaces
//   - Never a single violent pass at the end ("不要拖到最后一次性猛降")
//
// This module measures the noise floor (MAD, and the local-MAD structure) and
// decides whether a step is warranted, how strong, and which engine to use
// (NXT when present, TGVDenoise + MMT natively).
// ============================================================================

import { getStats } from './stats.mjs';

/**
 * Estimate noise level from MAD, normalised against the median so the value is
 * comparable between linear (median ~0.001) and stretched (median ~0.2) frames.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} [opts] { sampleStep }
 * @returns {Promise<object>} {
 *   sigma, normalized, localSigma, noiseScore, backgroundFraction, verdict
 * }
 */
export async function measureNoise(ctx, viewId, opts = {}) {
  const sampleStep = opts.sampleStep ?? 8;
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureNoise: not found: ${viewId}');
    var img = w.mainView.image;
    var isColor = img.isColor;
    var step = ${sampleStep};

    img.selectedChannel = 0; var mR = img.median();
    var mG = mR, mB = mR;
    if (isColor) { img.selectedChannel = 1; mG = img.median(); img.selectedChannel = 2; mB = img.median(); }
    img.resetChannelSelection();

    function lum(x, y) {
      if (isColor) return 0.2126*img.sample(x,y,0) + 0.7152*img.sample(x,y,1) + 0.0722*img.sample(x,y,2);
      return img.sample(x,y);
    }
    var bgLum = isColor ? (0.2126*mR + 0.7152*mG + 0.0722*mB) : mR;

    // Global absolute deviation from the background
    var diffs = [];
    for (var y = 0; y < img.height; y += step) {
      for (var x = 0; x < img.width; x += step) {
        diffs.push(Math.abs(lum(x, y) - bgLum));
      }
    }
    diffs.sort(function(a,b){return a-b;});
    var globalMAD = diffs.length ? diffs[Math.floor(diffs.length/2)] : 0;

    // Local structure: 16x16 block stddev in background-ish regions only
    var blockStd = [];
    var bsz = 16;
    for (var by = 0; by + bsz <= img.height; by += bsz * 2) {
      for (var bx = 0; bx + bsz <= img.width; bx += bsz * 2) {
        var sum = 0, sum2 = 0, n = 0, bright = 0;
        for (var yy = by; yy < by + bsz; yy += 2) {
          for (var xx = bx; xx < bx + bsz; xx += 2) {
            var l = lum(xx, yy);
            sum += l; sum2 += l*l; n++;
            if (l > bgLum + 6*globalMAD) bright++;
          }
        }
        // Only background blocks (no subject)
        if (n > 0 && bright / n < 0.05) {
          var mean = sum/n;
          var v = sum2/n - mean*mean;
          if (v > 0) blockStd.push(Math.sqrt(v));
        }
      }
    }
    blockStd.sort(function(a,b){return a-b;});
    var localSigma = blockStd.length ? blockStd[Math.floor(blockStd.length/2)] : 0;

    // Background fraction: how much of the frame is near-background
    var bgCount = 0;
    for (var i = 0; i < diffs.length; i++) if (diffs[i] < 4*globalMAD) bgCount++;
    var bgFrac = diffs.length ? bgCount / diffs.length : 0;

    JSON.stringify({
      median: bgLum,
      globalMAD: globalMAD,
      localSigma: localSigma,
      blocksMeasured: blockStd.length,
      backgroundFraction: bgFrac
    });
  `);
  if (r.status === 'error') throw new Error('Noise measurement failed: ' + (r.error?.message || 'PJSR error'));
  const d = JSON.parse(r.outputs?.consoleOutput || '{}');

  const sigma = d.globalMAD || 0;
  const localSigma = d.localSigma || 0;
  // Normalise by the background level: a MAD of 0.0004 on a 0.001 background
  // (linear) is far worse than 0.004 on a 0.25 background (stretched).
  const basis = Math.max(d.median || 0, 1e-6);
  const normalized = sigma / basis;
  const localNormalized = localSigma / basis;

  // Noise score 0..1: under 0.01 normalized is clean, above 0.10 is heavy.
  const rawScore = Math.min(1, localNormalized / 0.10);
  let verdict;
  if (localNormalized < 0.02) verdict = 'clean';
  else if (localNormalized < 0.05) verdict = 'light';
  else if (localNormalized < 0.10) verdict = 'moderate';
  else verdict = 'heavy';

  return {
    view_id: viewId,
    sigma,
    localSigma,
    normalized,
    localNormalized,
    noiseScore: rawScore,
    backgroundFraction: d.backgroundFraction ?? 0,
    blocksMeasured: d.blocksMeasured ?? 0,
    verdict
  };
}

/**
 * Decide the denoise strength for a stage. Encodes the director prompt's
 * constraint that linear-stage denoise is cautious (0.5–0.7 / detail 0.15)
 * and nonlinear passes are lighter still.
 *
 * @param {object} noise - result of measureNoise()
 * @param {object} opts {
 *   phase: 'linear' | 'nonlinear',
 *   purpose: 'pre-mix' | 'post-split' | 'final' | 'rescue',
 *   starred: boolean
 * }
 * @returns {object} {
 *   needed, denoise, detail, engine, reason
 * }
 */
export function planDenoise(noise, opts = {}) {
  noise = noise || {};
  const phase = opts.phase || 'linear';
  const purpose = opts.purpose || 'pre-mix';
  const verdict = noise.verdict || 'light';
  const localNormalized = Number.isFinite(noise.localNormalized)
    ? noise.localNormalized
    : Number.isFinite(noise.noiseScore)
      ? noise.noiseScore * 0.10
      : 0;

  // Hard caps per the director prompt.
  const caps = {
    linear: { maxDenoise: 0.70, minDenoise: 0.50, detail: 0.15 },
    nonlinear: { maxDenoise: 0.45, minDenoise: 0.15, detail: 0.12 }
  };
  const cap = caps[phase] || caps.linear;

  // Map the measured noise verdict onto a strength inside the allowed band.
  const byVerdict = {
    clean: 0.0,
    light: cap.minDenoise * 0.7,
    moderate: cap.minDenoise,
    heavy: cap.maxDenoise
  };
  let denoise = byVerdict[verdict] ?? cap.minDenoise;

  // Purpose modifiers
  if (purpose === 'final') denoise = Math.min(denoise, cap.minDenoise * 0.7);
  if (purpose === 'rescue') denoise = Math.min(cap.maxDenoise, denoise * 1.25);
  if (purpose === 'post-split') denoise = Math.min(cap.maxDenoise, denoise * 1.15);

  // Starred plates tolerate less denoise (stars smear before sky does).
  if (opts.starred) denoise *= 0.8;

  denoise = Math.max(0, Math.min(cap.maxDenoise, denoise));

  const needed = denoise >= 0.10 && verdict !== 'clean';
  const reason = needed
    ? `${verdict} noise (local σ/bg=${localNormalized.toFixed(4)}) at ${phase}/${purpose} → denoise ${denoise.toFixed(2)}`
    : `${verdict} noise (local σ/bg=${localNormalized.toFixed(4)}) at ${phase}/${purpose} → skip`;

  return {
    needed,
    denoise: Number(denoise.toFixed(3)),
    detail: cap.detail,
    engine: opts.engine || 'NoiseXTerminator',
    phase,
    purpose,
    noiseVerdict: verdict,
    reason
  };
}

/**
 * Apply a denoise plan. Uses NXT when available; otherwise TGVDenoise followed
 * by a light MultiscaleMedianTransform pass (the stock substitute named in the
 * director prompt's tool table).
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} plan - result of planDenoise()
 * @param {object} [toolResolution] - result of resolveTool(ctx, 'denoise')
 * @returns {Promise<object>} { applied, tool, stats, before, after }
 */
export async function applyDenoise(ctx, viewId, plan, toolResolution) {
  const before = await getStats(ctx, viewId);
  if (!plan.needed) {
    ctx.log(`  [denoise] skipped: ${plan.reason}`);
    return { applied: false, tool: null, reason: plan.reason, stats: before, before, after: before };
  }

  const tool = toolResolution?.tool || 'NoiseXTerminator';
  let r;
  if (tool === 'NoiseXTerminator') {
    r = await ctx.pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${plan.denoise};
      P.detail = ${plan.detail};
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      'OK';
    `);
  } else if (tool === 'TGVDenoise') {
    // TGV pass, strength mapped from NXT's scale.
    const tgvStrength = (plan.denoise * 4.0).toFixed(3);
    r = await ctx.pjsr(`
      var P = new TGVDenoise;
      P.strength = ${tgvStrength};
      P.edgeProtection = ${(plan.detail * 2 + 0.2).toFixed(3)};
      P.smoothness = 2;
      P.iterations = 250;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      'OK';
    `);
    if (r.status !== 'error') {
      // MMT cleanup of remaining chroma/luma noise
      const mm = await ctx.pjsr(`
        var M = new MultiscaleMedianTransform;
        M.numberOfLayers = 3;
        M.layers = [
          [0.800, ${(0.6 + plan.denoise * 0.3).toFixed(3)}, 0, 1],
          [0.500, ${(0.5 + plan.denoise * 0.2).toFixed(3)}, 0, 1],
          [0.250, 0.250, 0, 1]
        ];
        M.executeOn(ImageWindow.windowById('${viewId}').mainView);
        'OK';
      `);
      if (mm.status === 'error') ctx.log(`    [denoise] MMT cleanup skipped: ${mm.error?.message}`);
    }
  } else {
    ctx.log(`  [denoise] unknown engine '${tool}' — skipped`);
    return { applied: false, tool: null, reason: `unknown engine ${tool}`, stats: before, before, after: before };
  }

  if (r.status === 'error') {
    ctx.log(`  [denoise] WARN: ${tool} failed: ${r.error?.message}`);
    return { applied: false, tool, error: r.error?.message, stats: before, before, after: before };
  }

  const after = await getStats(ctx, viewId);
  ctx.log(`  [denoise] ${tool} applied to ${viewId} (denoise=${plan.denoise}, detail=${plan.detail})`);
  return { applied: true, tool, plan, stats: after, before, after };
}

/**
 * Convenience: measure, plan, apply, and report in one call.
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} opts { phase, purpose, starred, engine, toolResolution }
 * @returns {Promise<object>} { noise, plan, result }
 */
export async function autoDenoise(ctx, viewId, opts = {}) {
  const noise = await measureNoise(ctx, viewId, opts);
  const plan = planDenoise(noise, {
    phase: opts.phase,
    purpose: opts.purpose,
    starred: opts.starred,
    engine: opts.engine
  });
  const result = await applyDenoise(ctx, viewId, plan, opts.toolResolution);
  return { noise, plan, result };
}
