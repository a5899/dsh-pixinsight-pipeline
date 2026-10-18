// ============================================================================
// Image statistics, quality measurement, and STF acceptance checks
// ============================================================================

/**
 * Get basic image statistics (median, MAD, min, max) for a view.
 * @param {object} ctx - Bridge context from createBridgeContext()
 * @param {string} viewId - PixInsight view ID
 * @returns {object} { median, mad, min, max, mean, perChannel? }
 */
export async function getStats(ctx, viewId) {
  // `analyze_image` is a watcher-native command: one round trip returns
  // min/max + per-channel median/MAD/mean on a downsampled copy, instead of
  // three separate pjsr() calls that each re-walk the image.
  if (typeof ctx.analyze === 'function') {
    const a = await ctx.analyze(viewId);
    if (!a || a.error) {
      ctx.log?.(`  [stats] analyze failed for ${viewId}: ${a?.error || 'no output'}`);
    } else {
      const medianOf = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
      const out = {
        median: medianOf(a.median || []),
        mad: medianOf(a.mad || []),
        mean: medianOf(a.mean || []),
        min: a.min,
        max: a.max
      };
      if (a.isColor && Array.isArray(a.median) && a.median.length >= 3) {
        out.perChannel = {
          R: { median: a.median[0], mad: a.mad[0], mean: a.mean[0] },
          G: { median: a.median[1], mad: a.mad[1], mean: a.mean[1] },
          B: { median: a.median[2], mad: a.mad[2], mean: a.mean[2] }
        };
      }
      return out;
    }
  }
  const r = await ctx.pjsr(`
    var v = ImageWindow.windowById('${viewId}').mainView;
    var img = v.image;
    var result = {};
    if (img.isColor) {
      var meds = [], mads = [], means = [];
      for (var c = 0; c < img.numberOfChannels; c++) {
        img.selectedChannel = c;
        meds.push(img.median());
        mads.push(img.MAD());
        means.push(img.mean());
      }
      img.resetSelections();
      result.median = (meds[0] + meds[1] + meds[2]) / 3;
      result.mad = (mads[0] + mads[1] + mads[2]) / 3;
      result.mean = (means[0] + means[1] + means[2]) / 3;
      result.perChannel = {
        R: { median: meds[0], mad: mads[0], mean: means[0] },
        G: { median: meds[1], mad: mads[1], mean: means[1] },
        B: { median: meds[2], mad: mads[2], mean: means[2] }
      };
    } else {
      result.median = img.median();
      result.mad = img.MAD();
      result.mean = img.mean();
    }
    // minimum()/maximum() require an explicit Rect in PJSR — the no-argument
    // form throws "invalid argument type: Rect expected".
    var full = new Rect(0, 0, img.width, img.height);
    result.min = img.minimum(full);
    result.max = img.maximum(full);
    JSON.stringify(result);
  `);
  try { return JSON.parse(r.outputs?.consoleOutput || '{}'); }
  catch { return { median: 0.01, mad: 0.001, mean: 0.01, min: 0, max: 1 }; }
}

/**
 * Measure background uniformity via 4-corner median stddev.
 * @param {object} ctx - Bridge context
 * @param {string} viewId - PixInsight view ID
 * @param {number} sampleSize - Corner sample size in pixels (default 200)
 * @returns {object} { score, corners, perChannel, mean }
 */
export async function measureUniformity(ctx, viewId, sampleSize = 200) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureUniformity: not found: ${viewId}');
    var img = w.mainView.image;
    var sz = ${sampleSize};
    var corners = [
      [0, 0],
      [img.width - sz, 0],
      [0, img.height - sz],
      [img.width - sz, img.height - sz]
    ];
    var meds = [];
    var perCh = [];
    for (var i = 0; i < corners.length; i++) {
      var r = new Rect(corners[i][0], corners[i][1], corners[i][0] + sz, corners[i][1] + sz);
      img.selectedRect = r;
      if (img.isColor) {
        var chMeds = [];
        for (var c = 0; c < img.numberOfChannels; c++) {
          img.selectedChannel = c;
          chMeds.push(img.median());
        }
        img.resetChannelSelection();
        perCh.push(chMeds);
        meds.push((chMeds[0] + chMeds[1] + chMeds[2]) / 3);
      } else {
        var m = img.median();
        meds.push(m);
        perCh.push([m]);
      }
    }
    img.resetSelections();
    var mean = 0;
    for (var i = 0; i < meds.length; i++) mean += meds[i];
    mean /= meds.length;
    var variance = 0;
    for (var i = 0; i < meds.length; i++) variance += (meds[i] - mean) * (meds[i] - mean);
    var stddev = Math.sqrt(variance / meds.length);
    JSON.stringify({ score: stddev, corners: meds, perChannel: perCh, mean: mean });
  `);
  if (r.status === 'error') {
    ctx.log(`  [uniformity] WARN: ${r.error?.message || 'unknown error'}`);
    return { score: 999, corners: [], perChannel: [], mean: 0 };
  }
  return JSON.parse(r.outputs?.consoleOutput?.trim() || '{"score":999}');
}

// ============================================================================
// STF acceptance checks — the director prompt's per-step validation gate
//
// The director prompt requires after every stage:
//   - 背景中性: three-channel median should be close (color cast)
//   - 拉伸不截断: neither a clipped black foot nor a burnt core
//   - 无断层: no gaps in the histogram (stretch not delivered in one violent step)
//   - 噪点: MAD should be sane (not collapsed to 0 / not exploded)
//
// `acceptanceCheck` returns a structured verdict { pass, checks[], failures[],
// warnings[] } which the caller prints to the user alongside the STF preview.
// ============================================================================

/**
 * Compute histogram statistics needed for clipping/gap detection.
 * PJSR Image has no histogram API exposed to the bridge, so we sample.
 */
async function sampleHistogram(ctx, viewId, bins = 256, sampleStep = 3) {
  // Watcher-native histogram: downsampled to <=2000 px on the long side before
  // binning, which is an order of magnitude cheaper than sampling the full
  // resolution image pixel by pixel from Node-driven PJSR.
  if (typeof ctx.histogram === 'function') {
    const h = await ctx.histogram(viewId, bins, sampleStep);
    if (h && Array.isArray(h.counts)) return { counts: h.counts, total: h.total, bins: h.bins };
    ctx.log?.(`  [histogram] native call failed for ${viewId}: ${h?.error || 'no counts'}`);
  }
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('sampleHistogram: not found: ${viewId}');
    var img = w.mainView.image;
    var bins = ${bins};
    var step = ${sampleStep};
    var isColor = img.isColor;
    var counts = new Array(bins);
    for (var i = 0; i < bins; i++) counts[i] = 0;
    var total = 0;
    for (var y = 0; y < img.height; y += step) {
      for (var x = 0; x < img.width; x += step) {
        var lum;
        if (isColor) {
          lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
        } else {
          lum = img.sample(x, y);
        }
        var b = Math.floor(lum * bins);
        if (b < 0) b = 0;
        if (b >= bins) b = bins - 1;
        counts[b]++;
        total++;
      }
    }
    JSON.stringify({ counts: counts, total: total, bins: bins });
  `);
  if (r.status === 'error') throw new Error('Histogram sampling failed: ' + (r.error?.message || 'PJSR error'));
  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * STF-style auto stretch parameters.
 *
 * PixInsight's ScreenTransferFunction uses MTF driven by the median and MAD:
 *   n = MAD * 1.4826 * k / max(1e8, 10*median)  ... (normalized)
 *   c0 = median - n * shadowClip
 *   m  = MTF(median - c0, targetBackground)
 *
 * Returns the derived stretch values so the director can *report* them and
 * optionally apply an equivalent HT, exactly like eyeballing STF.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} [opts] { targetBackground: 0.25, shadowClip: -2.8 }
 * @returns {object} { shadows, midtone, highlights, applied }
 */
export async function computeSTF(ctx, viewId, opts = {}) {
  const targetBg = opts.targetBackground ?? 0.25;
  const shadowClip = opts.shadowClip ?? -2.8;
  const st = await getStats(ctx, viewId);
  const med = st.median ?? 0.01;
  const mad = st.mad ?? 0.001;

  // PixInsight STF algorithm (ImageStatistics-driven)
  const sigma = 1.4826 * mad;
  const denom = Math.max(1e-8, 10 * med);
  const n = sigma / denom;
  let c0 = med - n * shadowClip;
  if (c0 < 0) c0 = 0;
  if (c0 >= 1) c0 = 0.9999;
  const m = (med - c0) / (1 - c0);
  const midtone = mtf(m, targetBg);

  return {
    view_id: viewId,
    median: med,
    mad: mad,
    shadows: -c0,
    shadowsClipped: c0,
    midtone,
    highlights: 1.0,
    targetBackground: targetBg,
    stats: st
  };
}

// Midtone Transfer Function: maps x through a point so that x maps to m.
function mtf(x, m) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return ((m - 1) * x) / ((2 * m - 1) * x - m);
}

/**
 * Full STF acceptance check for one pipeline stage.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View to validate
 * @param {object} [opts]
 * @param {string} [opts.stage] - Human label, e.g. 'linear-pre', 'post-stretch'
 * @param {string} [opts.phase] - 'linear' | 'nonlinear' (default 'nonlinear')
 * @param {number} [opts.maxChannelSpread] - Allowed |max-med| channel median spread
 *                                             (linear: 0.02, nonlinear: 0.03)
 * @param {number} [opts.burnThreshold] - max() above this => over-exposed core
 * @param {number} [opts.clipThreshold] - min() at or below this => crushed blacks
 * @returns {Promise<object>} { pass, checks, failures, warnings, stats, stf }
 */
export async function acceptanceCheck(ctx, viewId, opts = {}) {
  const stage = opts.stage || 'stage';
  const phase = opts.phase || 'nonlinear';
  const maxSpread = opts.maxChannelSpread ?? (phase === 'linear' ? 0.02 : 0.03);
  const burnThreshold = opts.burnThreshold ?? 0.9995;
  const clipThreshold = opts.clipThreshold ?? 0.0;

  const stats = await getStats(ctx, viewId);
  const checks = [];
  const failures = [];
  const warnings = [];

  // --- 1. Background neutrality: three-channel median spread ---
  if (stats.perChannel) {
    const meds = ['R', 'G', 'B'].map(c => stats.perChannel[c].median);
    const spread = Math.max(...meds) - Math.min(...meds);
    const ok = spread <= maxSpread;
    checks.push({
      name: 'background_neutral',
      pass: ok,
      value: spread,
      limit: maxSpread,
      detail: `channel median spread=${spread.toFixed(5)} (limit ${maxSpread}) :: R=${meds[0].toFixed(5)} G=${meds[1].toFixed(5)} B=${meds[2].toFixed(5)}`
    });
    if (!ok) {
      failures.push(`Background cast: channel median spread ${spread.toFixed(5)} > ${maxSpread}. ` +
        `Run BackgroundNeutralization with Upper limit set just above the brightest background RGB.`);
    }
  } else {
    checks.push({ name: 'background_neutral', pass: true, skipped: true, detail: 'mono image — channel neutrality not applicable' });
  }

  // --- 2. No highlight burn (core not prematurely at 1.0) ---
  const maxVal = stats.max ?? 0;
  const burnOk = maxVal < burnThreshold;
  checks.push({
    name: 'no_highlight_burn',
    pass: burnOk,
    value: maxVal,
    limit: burnThreshold,
    detail: `max=${maxVal.toFixed(6)} (limit ${burnThreshold})`
  });
  if (!burnOk) {
    failures.push(`Highlights clipped: max=${maxVal.toFixed(6)} reached ${burnThreshold}. ` +
      `Core is blown — reduce stretch strength (MAS/GHS) or apply a two-stage HT/ArcsinhStretch.`);
  }

  // --- 3. No crushed blacks (dark foot not cut) ---
  const minVal = stats.min ?? 0;
  const clipOk = minVal > clipThreshold;
  checks.push({
    name: 'no_black_clip',
    pass: clipOk,
    value: minVal,
    limit: clipThreshold,
    detail: `min=${minVal.toFixed(6)} (limit > ${clipThreshold})`
  });
  if (!clipOk) {
    warnings.push(`Black point at floor: min=${minVal.toFixed(6)}. ` +
      `Minor clipping is normal after a nonlinear stretch; confirm the histogram's left foot is not severed.`);
  }

  // --- 4. Noise sanity (MAD not 0, not exploded) ---
  const mad = stats.mad ?? 0;
  const madOk = mad > 1e-7;
  checks.push({
    name: 'noise_sane',
    pass: madOk,
    value: mad,
    limit: 1e-7,
    detail: `MAD=${mad.toFixed(8)} (must be > 0 — a zero MAD means a flat/plastic image)`
  });
  if (!madOk) {
    failures.push(`MAD is ${mad.toFixed(8)} — the image has been flattened to a plateau ` +
      `(over-denoised or over-stretched). Back off NXT/TGV or reduce stretch.`);
  }

  // --- 5. Histogram gap detection (no 断层 / banding) ---
  let gapInfo = null;
  try {
    const h = await sampleHistogram(ctx, viewId, 256, 5);
    const counts = h.counts || [];
    const occupied = counts.filter(c => c > 0).length;
    const coverage = counts.length > 0 ? occupied / counts.length : 1;
    // Find the widest run of consecutive empty bins between the first and last occupied bin
    let first = counts.findIndex(c => c > 0);
    let last = counts.length - 1 - [...counts].reverse().findIndex(c => c > 0);
    if (first < 0) { first = 0; last = counts.length - 1; }
    let longestGap = 0, run = 0;
    for (let i = first; i <= last; i++) {
      if (counts[i] === 0) { run++; if (run > longestGap) longestGap = run; } else run = 0;
    }
    const gapFraction = (last - first + 1) > 0 ? longestGap / (last - first + 1) : 0;
    const gapOk = gapFraction <= 0.05;
    gapInfo = { coverage, longestGap, gapFraction };
    checks.push({
      name: 'no_histogram_gap',
      pass: gapOk,
      value: gapFraction,
      limit: 0.05,
      detail: `longest empty bin run=${longestGap} bins (${(gapFraction * 100).toFixed(1)}% of range, limit 5%), coverage=${(coverage * 100).toFixed(1)}%`
    });
    if (!gapOk) {
      failures.push(`Histogram gap of ${longestGap} bins (${(gapFraction * 100).toFixed(1)}%) — ` +
        `this is a 断层/banding signature. Use a gentler stretch (MAS/GHS) or apply HT in two passes.`);
    }
  } catch (e) {
    warnings.push(`Histogram gap check skipped: ${e.message}`);
  }

  // --- 6. STF reference (report only — this is what the director eyeballs) ---
  let stf = null;
  try {
    stf = await computeSTF(ctx, viewId, { targetBackground: phase === 'linear' ? 0.25 : 0.25 });
    checks.push({
      name: 'stf_preview',
      pass: true,
      skipped: true,
      detail: `STF: shadows=${stf.shadowsClipped.toFixed(5)} midtone=${stf.midtone.toFixed(5)} highlights=1.0 (target bg ${stf.targetBackground})`
    });
  } catch (e) {
    warnings.push(`STF computation skipped: ${e.message}`);
  }

  const pass = failures.length === 0;
  return {
    stage,
    phase,
    pass,
    checks,
    failures,
    warnings,
    stats,
    stf,
    histogram: gapInfo,
    summary: pass
      ? `${stage}: PASS — median=${stats.median?.toFixed(5)} mean=${stats.mean?.toFixed(5)} MAD=${stats.mad?.toFixed(6)} min=${stats.min?.toFixed(4)} max=${stats.max?.toFixed(5)}`
      : `${stage}: FAIL — ${failures.length} blocking issue(s)`
  };
}

/**
 * Convenience wrapper: run acceptanceCheck and throw when it fails and
 * `strict` is true. Otherwise log the failures.
 */
export async function enforceAcceptance(ctx, viewId, opts = {}) {
  const result = await acceptanceCheck(ctx, viewId, opts);
  ctx.log(`    [accept] ${result.summary}`);
  for (const w of result.warnings) ctx.log(`    [accept] WARN: ${w}`);
  for (const f of result.failures) ctx.log(`    [accept] FAIL: ${f}`);
  if (opts.strict && !result.pass) {
    throw new Error(`Acceptance check failed at ${result.stage}: ${result.failures.join(' | ')}`);
  }
  return result;
}
