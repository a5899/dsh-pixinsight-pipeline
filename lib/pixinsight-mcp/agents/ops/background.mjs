// ============================================================================
// Background calibration and neutralisation
//
// The director prompt's rule is "GC → MGC → GraXpert → DBE, evaluate in order
// and keep the best result" — NOT "try one and hope". The only honest way to
// implement that is to measure: run each available method on a clone, compare
// the resulting background uniformity, and keep the winner.
//
// Also here:
//   - BackgroundNeutralization with an Upper limit derived from the measured
//     background RGB (never a hand-waved constant).
//   - Per-channel mode, which Flow B demands for L/R/G/B.
//
// PJSR constraint: ECMAScript 5 only — no let/const/arrow inside ctx.pjsr code.
// ============================================================================

import { detectTools, resolveTool, TOOL_GROUPS } from './tooling.mjs';

function failed(r) {
  return r && r.status === 'error';
}

function errText(r, fallback) {
  return (r && r.error && (r.error.message || r.error.toString())) || fallback;
}

/**
 * Measure background uniformity as the coefficient of variation of the corner
 * means. Lower is better; this is what decides which gradient method wins.
 *
 * The statistic is the spread between the four corner regions' mean levels —
 * NOT each corner's own average. Using the corner average would be dominated
 * by the sky floor (identical in every corner) and would report a flat ~0 for
 * an image with a huge diagonal gradient. The corner sums exposed below are
 * the raw values the coefficient of variation is computed from.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {number} [sampleSize]
 * @returns {Promise<number>} CV of the four corner means (0 = perfectly flat)
 */
async function uniformityScore(ctx, viewId, sampleSize = 128) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    var img = w.mainView.image;
    var W = img.width, H = img.height, S = ${sampleSize};
    S = Math.min(S, Math.floor(Math.min(W, H) / 2));
    var ox = W - S, oy = H - S;
    var corners = [[0,0],[ox,0],[0,oy],[ox,oy]];
    var means = [];
    for (var c = 0; c < corners.length; c++) {
      var x0 = corners[c][0], y0 = corners[c][1];
      var sum = 0, n = 0;
      var step = Math.max(1, Math.floor(S / 32));
      for (var y = y0; y < y0 + S; y += step) {
        for (var x = x0; x < x0 + S; x += step) {
          if (img.isColor) {
            sum += 0.2126*img.sample(x,y,0) + 0.7152*img.sample(x,y,1) + 0.0722*img.sample(x,y,2);
          } else {
            sum += img.sample(x,y);
          }
          n++;
        }
      }
      means.push(n > 0 ? sum / n : 0);
    }
    var mean = 0;
    for (var i = 0; i < means.length; i++) mean += means[i];
    mean /= means.length;
    var sd = 0;
    for (var j = 0; j < means.length; j++) sd += (means[j] - mean) * (means[j] - mean);
    sd = Math.sqrt(sd / means.length);
    JSON.stringify({
      mean: mean,
      sd: sd,
      cv: mean > 0 ? sd / mean : 0,
      corner_means: means
    });
  `);
  if (failed(r)) return Number.POSITIVE_INFINITY;
  const d = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}');
  return Number.isFinite(d.cv) ? d.cv : Number.POSITIVE_INFINITY;
}

/**
 * Run one gradient method on a view.
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
async function applyGradientMethod(ctx, method, viewId, opts = {}) {
  const poly = Number.isFinite(opts.poly_degree) ? opts.poly_degree : 3;
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : 1.0;

  const bodies = {
    GradientCorrection: `
      var P = new GradientCorrection;
      P.layerScale = 0.5;
      P.smoothing = 0.5;
      P.executeOn(w.mainView, false);
    `,
    MultiscaleGradientCorrection: `
      var P = new MultiscaleGradientCorrection;
      P.executeOn(w.mainView, false);
    `,
    GraXpert: `
      var P = new GraXpert;
      P.executeOn(w.mainView, false);
    `,
    DynamicBackgroundExtraction: `
      var P = new DynamicBackgroundExtraction;
      P.polyDegree = ${poly};
      P.tolerance = ${tolerance};
      P.executeOn(w.mainView, false);
    `,
    AutomaticBackgroundExtraction: `
      var P = new AutomaticBackgroundExtraction;
      P.polyDegree = ${poly};
      P.tolerance = ${tolerance};
      P.executeOn(w.mainView, false);
    `
  };

  const body = bodies[method];
  if (!body) return { ok: false, error: `unknown gradient method '${method}'` };

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    ${body}
    'OK';
  `);
  return failed(r) ? { ok: false, error: errText(r, 'gradient method failed') } : { ok: true, error: null };
}

/**
 * Evaluate the gradient-correction chain and keep the best result.
 *
 * Each *installed* method is tried on a throwaway clone seeded from a pristine
 * copy of the input. The winner is re-run on the real view. A method that makes
 * uniformity worse is rejected — that guard is what stops a bad GC from eating
 * real nebula signal.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} [opts] {
 *   methods?: string[],   // override the chain (default: GC → MGC → GraXpert → DBE)
 *   poly_degree?: number,
 *   tolerance?: number,
 *   max_degradation?: number  // reject a method worse than this × baseline (default 1.25)
 * }
 * @returns {Promise<object>} {
 *   applied, baseline_cv, result_cv, improvement, evaluated: [{ method, ok, cv, error }]
 * }
 */
export async function gradientCorrect(ctx, viewId, opts = {}) {
  if (!viewId) throw new Error('gradientCorrect: view_id is required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};
  const maxDegradation = Number.isFinite(opts.max_degradation) ? opts.max_degradation : 1.25;

  const available = await detectTools(ctx);
  const chain = Array.isArray(opts.methods) && opts.methods.length
    ? opts.methods
    : TOOL_GROUPS.background;

  // Baseline uniformity, and a pristine snapshot to re-seed every trial.
  const baselineCv = await uniformityScore(ctx, viewId);
  const pristine = `${viewId}__pristine`;
  const seedR = await ctx.pjsr(`
    var src = ImageWindow.windowById('${viewId}');
    if (src.isNull) throw new Error('not found: ${viewId}');
    var old = ImageWindow.windowById('${pristine}');
    if (!old.isNull) old.forceClose();
    var img = src.mainView.image;
    var c = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, '${pristine}');
    c.mainView.beginProcess();
    c.mainView.image.assign(img);
    c.mainView.endProcess();
    c.hide();
    'OK';
  `);
  if (failed(seedR)) throw new Error('gradientCorrect: ' + errText(seedR, 'cannot snapshot input'));

  const evaluated = [];
  const reverted = [];
  let best = null;

  for (const method of chain) {
    if (!available[method]) {
      evaluated.push({ method, ok: false, cv: null, error: 'not installed' });
      continue;
    }

    // Re-seed the working view from the snapshot so methods are compared fairly.
    const reseed = await ctx.pjsr(`
      var src = ImageWindow.windowById('${pristine}');
      var dst = ImageWindow.windowById('${viewId}');
      if (src.isNull || dst.isNull) throw new Error('reseed failed');
      dst.mainView.beginProcess();
      dst.mainView.image.assign(src.mainView.image);
      dst.mainView.endProcess();
      'OK';
    `);
    if (failed(reseed)) {
      evaluated.push({ method, ok: false, cv: null, error: 'reseed failed' });
      continue;
    }

    const res = await applyGradientMethod(ctx, method, viewId, opts);
    if (!res.ok) {
      evaluated.push({ method, ok: false, cv: null, error: res.error });
      log(`  [background] ${method} failed: ${res.error}`);
      continue;
    }

    const cv = await uniformityScore(ctx, viewId);
    evaluated.push({ method, ok: true, cv, error: null });
    log(`  [background] ${method.padEnd(32)} uniform-CV ${cv.toExponential(3)}`);

    // A "winner" that leaves the background less flat than it arrived is not a
    // winner. Reject it on the spot so a later, better method can still be the
    // one we keep — and so the view is never left holding a degraded result.
    if (cv > baselineCv * maxDegradation) {
      const why = `degraded uniformity: CV ${cv.toExponential(3)} vs ` +
                  `baseline ${baselineCv.toExponential(3)} (limit x${maxDegradation})`;
      reverted.push({ method, cv, reason: why });
      log(`  [background] ${method} rejected — ${why}`);
      continue;
    }

    if (!best || cv < best.cv) best = { method, cv };
  }

  // Restore the pristine pixels: the working view currently holds the last
  // trial (possibly a rejected one), which must never survive.
  await ctx.pjsr(`
    var src = ImageWindow.windowById('${pristine}');
    var dst = ImageWindow.windowById('${viewId}');
    if (!src.isNull && !dst.isNull) {
      dst.mainView.beginProcess();
      dst.mainView.image.assign(src.mainView.image);
      dst.mainView.endProcess();
    }
    if (!src.isNull) src.forceClose();
    'OK';
  `);

  if (!best) {
    log('  [background] no gradient method kept — view reverted to its input state');
    return {
      applied: null,
      baseline_cv: baselineCv,
      result_cv: baselineCv,
      improvement: 0,
      evaluated,
      reverted,
      rejected: reverted.length ? reverted[reverted.length - 1].method : null,
      reason: reverted.length
        ? 'every available method degraded background uniformity beyond max_degradation'
        : 'no gradient method available'
    };
  }

  // Re-run the winner on the clean view and confirm the gain reproduces.
  const finalRes = await applyGradientMethod(ctx, best.method, viewId, opts);
  if (!finalRes.ok) throw new Error(`gradientCorrect: re-applying ${best.method} failed: ${finalRes.error}`);
  const resultCv = await uniformityScore(ctx, viewId);

  log(`  [background] kept ${best.method} (CV ${baselineCv.toExponential(3)} → ${resultCv.toExponential(3)})`);
  return {
    applied: best.method,
    baseline_cv: baselineCv,
    result_cv: resultCv,
    improvement: baselineCv > 0 ? 1 - resultCv / baselineCv : 0,
    evaluated,
    reverted
  };
}

/**
 * Read the background level per channel, which is what BackgroundNeutralization's
 * "Upper limit" must sit just above.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @returns {Promise<object>} { median: {r,g,b} | number, max_median, offset }
 */
export async function measureBackground(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    var img = w.mainView.image;
    if (!img.isColor) {
      JSON.stringify({ mono: true, median: img.median() });
    } else {
      var meds = [];
      for (var c = 0; c < img.numberOfChannels; c++) {
        img.selectedChannel = c;
        meds.push(img.median());
      }
      img.resetChannelSelection();
      JSON.stringify({ mono: false, r: meds[0], g: meds[1], b: meds[2] });
    }
  `);
  if (failed(r)) throw new Error('measureBackground: ' + errText(r, 'measurement failed'));
  const d = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}');
  if (d.mono) {
    const m = Number(d.median) || 0;
    return { mono: true, median: m, max_median: m, offset: m > 0 ? m * 1.1 : 0 };
  }
  const maxMedian = Math.max(d.r || 0, d.g || 0, d.b || 0);
  return {
    mono: false,
    median: { r: d.r, g: d.g, b: d.b },
    max_median: maxMedian,
    // "slightly above the largest" — 10 % headroom, per the director prompt.
    offset: maxMedian * 1.1
  };
}

/**
 * Neutralise the background: set Upper limit from the measured background
 * rather than guessing, then run BackgroundNeutralization.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} [opts] {
 *   upper_limit?: number,   // override; otherwise measured max median × 1.1
 *   target_bg?: number,     // clip target (default 0.0 = neutral black)
 *   shadows?: number,       // ignore pixels below this
 * }
 * @returns {Promise<object>} { upper_limit, before, after }
 */
export async function backgroundNeutralize(ctx, viewId, opts = {}) {
  if (!viewId) throw new Error('backgroundNeutralize: view_id is required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  const before = await measureBackground(ctx, viewId);
  const upperLimit = Number.isFinite(opts.upper_limit) ? opts.upper_limit : before.offset;
  const target = Number.isFinite(opts.target_bg) ? opts.target_bg : 0.0;
  const shadows = Number.isFinite(opts.shadows) ? opts.shadows : 0.0;

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    var P = new BackgroundNeutralization;
    P.upperLimit = ${upperLimit};
    P.targetBackground = ${target};
    P.shadowsClipping = ${shadows};
    P.executeOn(w.mainView, false);
    'OK';
  `);
  if (failed(r)) throw new Error('backgroundNeutralize: ' + errText(r, 'BackgroundNeutralization failed'));

  const after = await measureBackground(ctx, viewId);
  const spread = after.mono
    ? 0
    : Math.max(
        Math.abs(after.median.r - after.median.g),
        Math.abs(after.median.g - after.median.b),
        Math.abs(after.median.r - after.median.b)
      );
  log(`  [background] BackgroundNeutralization upper-limit=${upperLimit.toExponential(3)} → channel spread ${spread.toExponential(3)}`);

  return { upper_limit: upperLimit, before, after, channel_spread: spread };
}

/**
 * Batch helper: run gradientCorrect on several views (Flow B's per-channel
 * correction for L/R/G/B, each with its own gradient profile).
 *
 * @param {object} ctx
 * @param {string[]} viewIds
 * @param {object} [opts] passed through to gradientCorrect
 * @returns {Promise<object>} { results: [{ view_id, ...gradientCorrect result }] }
 */
export async function gradientCorrectChannels(ctx, viewIds = [], opts = {}) {
  const ids = Array.isArray(viewIds) ? viewIds : [];
  if (!ids.length) throw new Error('gradientCorrectChannels: view_ids must be non-empty');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  const results = [];
  for (const id of ids) {
    log(`  [background] per-channel gradient correction: ${id}`);
    try {
      const res = await gradientCorrect(ctx, id, opts);
      results.push({ view_id: id, ok: true, ...res });
    } catch (e) {
      results.push({ view_id: id, ok: false, error: e.message });
    }
  }
  const ok = results.filter(r => r.ok).length;
  log(`  [background] per-channel done: ${ok}/${ids.length}`);
  return { results };
}

export { TOOL_GROUPS, resolveTool };
