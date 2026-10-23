// ============================================================================
// Narrowband color handling
//
// Implements the director prompt's SHO workflow:
//   - ChannelCombination S/H/O → R/G/B
//   - PixelMath dynamic blend (R=SII, G=0.8*Ha+0.2*OIII, B=OIII)
//   - HaRGB / HaLRGB injection with tunable Q (extraction) and B (injection)
//   - Parameter search helpers so Q/B are tuned from measurements, not guessed
//
// All PixelMath expressions follow PJSR semantics: there is no pow(), use
// exp(k*ln(x)). Symbols are declared via P.symbols.
// ============================================================================

import { getStats } from './stats.mjs';

/**
 * Combine S/H/O mono channels into an RGB image via ChannelCombination.
 * @param {object} ctx
 * @param {object} opts { sii_id, ha_id, oiii_id, target_id }
 * @returns {Promise<string>} the new view id
 */
export async function combineSho(ctx, opts) {
  const { sii_id, ha_id, oiii_id, target_id } = opts;
  const r = await ctx.pjsr(`
    var ids = ['${sii_id}', '${ha_id}', '${oiii_id}'];
    for (var i = 0; i < ids.length; i++) {
      var w = ImageWindow.windowById(ids[i]);
      if (w.isNull) throw new Error('SHO channel not found: ' + ids[i]);
      if (w.mainView.image.isColor) throw new Error('SHO channel must be mono: ' + ids[i]);
    }
    var P = new ChannelCombination;
    P.colorSpace = ChannelCombination.prototype.RGB;
    // Assign the channels table in one go: assigning an empty array first
    // raises "ChannelCombination.channels(): table length out of range (0)".
    P.channels = [[true, '${sii_id}'], [true, '${ha_id}'], [true, '${oiii_id}']];
    var nw = new ImageWindow(
      ImageWindow.windowById('${ha_id}').mainView.image.width,
      ImageWindow.windowById('${ha_id}').mainView.image.height,
      3, 32, true, true, '${target_id}');
    nw.show();
    P.executeOn(nw.mainView);
    '${target_id}';
  `);
  if (r.status === 'error') throw new Error('ChannelCombination failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [narrowband] SHO composite → ${target_id} (R=SII, G=Ha, B=OIII)`);
  return target_id;
}

/**
 * Dynamic narrowband blend via per-channel PixelMath.
 *
 * Director prompt's "进阶动态混色":
 *   R: SII
 *   G: gHa*Ha + gO3*OIII      (default 0.8 / 0.2 — a touch of OIII pushes green cyan)
 *   B: OIII
 *
 * Runs in-place on `rgb_id`, reading the three mono channels by view id.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   rgb_id, sii_id, ha_id, oiii_id,
 *   weights: { rSii, rHa, rO3, gSii, gHa, gO3, bSii, bHa, bO3 },
 *   normalize: boolean
 * }
 * @returns {Promise<object>} stats after the blend
 */
export async function dynamicBlend(ctx, opts) {
  const { rgb_id, sii_id, ha_id, oiii_id } = opts;
  const w = Object.assign({
    rSii: 1, rHa: 0, rO3: 0,
    gSii: 0, gHa: 0.8, gO3: 0.2,
    bSii: 0, bHa: 0, bO3: 1
  }, opts.weights || {});

  // Normalize each channel so the weights are pure mixing fractions.
  const rSum = w.rSii + w.rHa + w.rO3 || 1;
  const gSum = w.gSii + w.gHa + w.gO3 || 1;
  const bSum = w.bSii + w.bHa + w.bO3 || 1;

  const expr = (a, b, c) => {
    const parts = [];
    if (a > 0) parts.push(`${(a / rSum).toFixed(6)}*${sii_id}`);
    if (b > 0) parts.push(`${(b / rSum).toFixed(6)}*${ha_id}`);
    if (c > 0) parts.push(`${(c / rSum).toFixed(6)}*${oiii_id}`);
    return parts.length ? parts.join(' + ') : '0';
  };
  const exprG = () => {
    const parts = [];
    if (w.gSii > 0) parts.push(`${(w.gSii / gSum).toFixed(6)}*${sii_id}`);
    if (w.gHa > 0) parts.push(`${(w.gHa / gSum).toFixed(6)}*${ha_id}`);
    if (w.gO3 > 0) parts.push(`${(w.gO3 / gSum).toFixed(6)}*${oiii_id}`);
    return parts.length ? parts.join(' + ') : '0';
  };
  const exprB = () => {
    const parts = [];
    if (w.bSii > 0) parts.push(`${(w.bSii / bSum).toFixed(6)}*${sii_id}`);
    if (w.bHa > 0) parts.push(`${(w.bHa / bSum).toFixed(6)}*${ha_id}`);
    if (w.bO3 > 0) parts.push(`${(w.bO3 / bSum).toFixed(6)}*${oiii_id}`);
    return parts.length ? parts.join(' + ') : '0';
  };

  const r = await ctx.pjsr(`
    var ids = ['${sii_id}', '${ha_id}', '${oiii_id}'];
    for (var i = 0; i < ids.length; i++) {
      if (ImageWindow.windowById(ids[i]).isNull) throw new Error('channel not found: ' + ids[i]);
    }
    var P = new PixelMath;
    P.expression  = "${expr(w.rSii, w.rHa, w.rO3).replace(/"/g, '\\"')}";
    P.expression1 = "${exprG().replace(/"/g, '\\"')}";
    P.expression2 = "${exprB().replace(/"/g, '\\"')}";
    P.useSingleExpression = false;
    P.use64BitWorkingImage = true;
    P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
    P.createNewImage = false;
    P.executeOn(ImageWindow.windowById('${rgb_id}').mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('Dynamic blend failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [narrowband] dynamic blend applied to ${rgb_id} (R=${w.rSii}/${w.rHa}/${w.rO3}, G=${w.gSii}/${w.gHa}/${w.gO3}, B=${w.bSii}/${w.bHa}/${w.bO3})`);
  const stats = await getStats(ctx, rgb_id);
  return { ok: true, weights: w, stats };
}

/**
 * Extract a clean Ha signal from a broadband red channel, per the director
 * prompt's OSC Ha injection recipe:
 *
 *   Ha_clean = Ha - Q * (RGB_R - med(RGB_R))
 *
 * Writes the result into `out_id` (created if missing).
 *
 * @param {object} ctx
 * @param {object} opts {
 *   ha_id,      // starless Ha (or narrowband Ha) view
 *   red_id,     // starless red channel of the broadband RGB
 *   out_id,     // output view id
 *   q           // contamination factor (default 0.045)
 * }
 * @returns {Promise<object>} { out_id, q, stats }
 */
export async function extractCleanHa(ctx, opts) {
  const { ha_id, red_id, out_id } = opts;
  const q = opts.q ?? 0.045;

  const r = await ctx.pjsr(`
    var haW = ImageWindow.windowById('${ha_id}');
    var rdW = ImageWindow.windowById('${red_id}');
    if (haW.isNull) throw new Error('Ha not found: ${ha_id}');
    if (rdW.isNull) throw new Error('Red channel not found: ${red_id}');
    var old = ImageWindow.windowById('${out_id}');
    if (!old.isNull) old.forceClose();
    var nw = new ImageWindow(haW.mainView.image.width, haW.mainView.image.height, 1, 32, true, false, '${out_id}');
    nw.show();
    var PM = new PixelMath;
    PM.expression = "max(0, ${ha_id} - ${q} * (${red_id} - med(${red_id})))";
    PM.useSingleExpression = true;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = false;
    PM.executeOn(nw.mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('Clean Ha extraction failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [narrowband] Ha_clean = Ha - ${q}*(RGB_R - med(RGB_R)) → ${out_id}`);
  const stats = await getStats(ctx, out_id);
  return { out_id, q, stats };
}

/**
 * Inject clean Ha into a target RGB (or mono L) view.
 *
 * Director prompt's recipe (separate expressions per channel):
 *   R: $T + B*(Ha_clean - med(Ha_clean))
 *   G: $T
 *   B: $T + B*blueRatio*(Ha_clean - med(Ha_clean))
 *
 * `blueRatio` defaults to 0.1 (Hβ sits in blue but is much weaker). The prompt
 * warns both B and the 0.1 coefficient must be tuned per target — e.g. M82
 * should NOT get Ha added to blue or the emission becomes magenta.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   target_id, ha_clean_id, b (default 1.75), blueRatio (default 0.1),
 *   mode: 'rgb' | 'luminance'
 * }
 * @returns {Promise<object>} stats
 */
export async function injectHa(ctx, opts) {
  const { target_id, ha_clean_id } = opts;
  const B = opts.b ?? 1.75;
  const blueRatio = opts.blueRatio ?? 0.1;
  const mode = opts.mode || 'rgb';

  let r;
  if (mode === 'luminance') {
    r = await ctx.pjsr(`
      var PM = new PixelMath;
      PM.expression = "$T + ${B} * (${ha_clean_id} - med(${ha_clean_id}))";
      PM.useSingleExpression = true;
      PM.use64BitWorkingImage = true;
      PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
      PM.createNewImage = false;
      PM.executeOn(ImageWindow.windowById('${target_id}').mainView);
      'OK';
    `);
  } else {
    r = await ctx.pjsr(`
      var PM = new PixelMath;
      PM.expression  = "$T + ${B} * (${ha_clean_id} - med(${ha_clean_id}))";
      PM.expression1 = "$T";
      PM.expression2 = "$T + ${B} * ${blueRatio} * (${ha_clean_id} - med(${ha_clean_id}))";
      PM.useSingleExpression = false;
      PM.use64BitWorkingImage = true;
      PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
      PM.createNewImage = false;
      PM.executeOn(ImageWindow.windowById('${target_id}').mainView);
      'OK';
    `);
  }
  if (r.status === 'error') throw new Error('Ha injection failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [narrowband] Ha injected into ${target_id} (mode=${mode}, B=${B}, blueRatio=${blueRatio})`);
  return await getStats(ctx, target_id);
}

/**
 * Measure how well a Q value separates Ha signal from broadband continuum.
 *
 * The director prompt says Q must be tuned per image: too large and the Ha
 * emission loses its own structure (continuum gets subtracted away), too small
 * and the broadband continuum leaks through. We score candidates by the
 * spatial correlation between the clean-Ha result and the original red
 * channel *outside* the Ha structure — lower correlation means less leak.
 *
 * Returns a candidate list with measured leakage so the caller can pick.
 *
 * @param {object} ctx
 * @param {object} opts { ha_id, red_id, candidates: number[], sampleStep }
 * @returns {Promise<object>} { best, candidates: [{ q, leak, haMean, haMAD }] }
 */
export async function searchCleanHaQ(ctx, opts) {
  const { ha_id, red_id } = opts;
  const candidates = opts.candidates ?? [0.02, 0.03, 0.045, 0.06, 0.08];
  const sampleStep = opts.sampleStep ?? 8;

  const results = [];
  for (const q of candidates) {
    // Evaluate Q by measuring the residual on a sampled grid without touching
    // any real view — this keeps the search side-effect free.
    const r = await ctx.pjsr(`
      var haW = ImageWindow.windowById('${ha_id}');
      var rdW = ImageWindow.windowById('${red_id}');
      if (haW.isNull || rdW.isNull) throw new Error('searchCleanHaQ: view not found');
      var ha = haW.mainView.image;
      var rd = rdW.mainView.image;
      var q = ${q};
      var medR = med(${red_id});
      var step = ${sampleStep};
      var sum = 0, sum2 = 0, n = 0, leakSum = 0, leakN = 0;
      var haSum = 0;
      for (var y = 0; y < ha.height; y += step) {
        for (var x = 0; x < ha.width; x += step) {
          var h = ha.sample(x, y);
          var rv = rd.sample(x, y);
          var clean = h - q * (rv - medR);
          var c = clean < 0 ? 0 : clean;
          sum += c; sum2 += c * c; n++;
          haSum += h;
          // Continuum-only pixels: broadband red below its own median but
          // Ha above background => residue there is leakage.
          if (rv < medR && h > 0.001) { leakSum += Math.abs(c); leakN++; }
        }
      }
      var mean = n > 0 ? sum / n : 0;
      var variance = n > 0 ? sum2 / n - mean * mean : 0;
      var mad = variance > 0 ? Math.sqrt(variance) : 0;
      JSON.stringify({
        q: q,
        mean: mean,
        mad: mad,
        haMean: n > 0 ? haSum / n : 0,
        leak: leakN > 0 ? leakSum / leakN : 0,
        samples: n
      });
    `);
    if (r.status === 'error') {
      ctx.log(`  [narrowband] Q search: q=${q} failed: ${r.error?.message}`);
      continue;
    }
    const d = JSON.parse(r.outputs?.consoleOutput || '{}');
    results.push({ q: d.q, leak: d.leak, haMean: d.haMean, haMAD: d.mad, samples: d.samples });
  }

  // Choose the Q with the smallest leakage that still retains Ha signal
  // (at least 60% of the original Ha mean). If every candidate falls below
  // that retention floor, fall back to the smallest Q that retains 60%.
  let best = null;
  if (results.length > 0) {
    const baselineHa = results[0].haMean || 1e-8;
    const viable = results.filter(x => x.haMean >= 0.60 * baselineHa);
    const pool = viable.length ? viable : results;
    best = pool.reduce((a, b) => (b.leak < a.leak ? b : a), pool[0]);
  }
  ctx.log(`  [narrowband] Q search → best q=${best ? best.q : 'n/a'} (${results.length} candidates)`);
  return { best, candidates: results };
}

/**
 * Measure an appropriate injection strength B by comparing the Ha signal
 * amplitude against the red channel's own structure. Returns candidate B
 * values plus the measured contrast so the director can pick rather than guess.
 *
 * @param {object} ctx
 * @param {object} opts { target_id, ha_clean_id, candidates: number[] }
 * @returns {Promise<object>} { best, candidates: [{ b, gain, contrast }] }
 */
export async function searchInjectionB(ctx, opts) {
  const { target_id, ha_clean_id } = opts;
  const candidates = opts.candidates ?? [1.0, 1.25, 1.5, 1.75, 2.0, 2.5];

  const base = await ctx.pjsr(`
    var w = ImageWindow.windowById('${ha_clean_id}');
    if (w.isNull) throw new Error('Ha_clean not found: ${ha_clean_id}');
    var img = w.mainView.image;
    JSON.stringify({
      median: img.median(),
      mad: img.MAD(),
      max: img.maximum(new Rect(0, 0, img.width, img.height))
    });
  `);
  if (base.status === 'error') throw new Error('searchInjectionB: ' + (base.error?.message || 'PJSR error'));
  const h = JSON.parse(base.outputs?.consoleOutput || '{}');
  const t = await getStats(ctx, target_id);

  // Contrast = how far the Ha structure already sits above the local background.
  const haContrast = (h.median || 0.001) > 0 ? (h.max - h.median) / Math.max(h.median, 1e-8) : 0;
  const results = candidates.map(b => ({
    b,
    gain: b * (h.max - h.median),
    contrast: haContrast
  }));
  // Best B is the largest one whose gain keeps the target's max below 0.95.
  const headroom = Math.max(0, 0.95 - (t.max ?? 0.5));
  const viable = results.filter(x => x.gain <= headroom || x.gain < 1e-6);
  const best = viable.length
    ? viable[viable.length - 1]
    : results.reduce((a, b) => (b.gain < a.gain ? b : a), results[0]);

  ctx.log(`  [narrowband] B search → best b=${best?.b} (Ha max=${(h.max || 0).toFixed(4)}, target max=${(t.max || 0).toFixed(4)})`);
  return { best, candidates: results, haContrast, targetStats: t };
}

/**
 * Build an OIII channel from a dual-band (HO or SO) composite:
 *   OIII_HO = 0.2*G + 0.8*B     (HO filter)
 *   OIII_S  = 0.8*G + 0.2*B     (SO filter)
 *
 * @param {object} ctx
 * @param {object} opts { source_id, out_id, gWeight, bWeight }
 * @returns {Promise<string>} out_id
 */
export async function mixOiii(ctx, opts) {
  const { source_id, out_id } = opts;
  const gw = opts.gWeight ?? 0.2;
  const bw = opts.bWeight ?? 0.8;
  const r = await ctx.pjsr(`
    var src = ImageWindow.windowById('${source_id}');
    if (src.isNull) throw new Error('source not found: ${source_id}');
    var img = src.mainView.image;
    if (img.numberOfChannels < 3) throw new Error('mixOiii: source must be RGB');
    var old = ImageWindow.windowById('${out_id}');
    if (!old.isNull) old.forceClose();
    var nw = new ImageWindow(img.width, img.height, 1, 32, true, false, '${out_id}');
    nw.show();
    var PM = new PixelMath;
    PM.expression = "${gw}*${source_id}[1] + ${bw}*${source_id}[2]";
    PM.useSingleExpression = true;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = false;
    PM.executeOn(nw.mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('OIII mix failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [narrowband] OIII = ${gw}*G + ${bw}*B from ${source_id} → ${out_id}`);
  return out_id;
}

/**
 * Extract a single channel of a color view into a new mono window.
 * @param {object} ctx
 * @param {object} opts { source_id, out_id, channel: 0|1|2 }
 * @returns {Promise<string>} out_id
 */
export async function extractChannel(ctx, opts) {
  const { source_id, out_id } = opts;
  const ch = opts.channel ?? 0;
  const chanName = ['R', 'G', 'B'][ch];
  const r = await ctx.pjsr(`
    var src = ImageWindow.windowById('${source_id}');
    if (src.isNull) throw new Error('source not found: ${source_id}');
    var img = src.mainView.image;
    if (img.numberOfChannels < 3) throw new Error('extractChannel: source must be RGB');
    var old = ImageWindow.windowById('${out_id}');
    if (!old.isNull) old.forceClose();
    var nw = new ImageWindow(img.width, img.height, 1, 32, true, false, '${out_id}');
    nw.show();
    var PM = new PixelMath;
    PM.expression = "${source_id}[${ch}]";
    PM.useSingleExpression = true;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = false;
    PM.executeOn(nw.mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('Channel extraction failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [narrowband] extracted ${chanName} channel from ${source_id} → ${out_id}`);
  return out_id;
}
