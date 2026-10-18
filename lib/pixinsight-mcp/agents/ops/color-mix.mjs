// ============================================================================
// Narrowband-driven colour extraction and injection (Flows A / C1 / C2)
//
// Everything here is PixelMath over a measured background, never a hand-picked
// constant: the "Q" and "B" coefficients the director prompt asks the operator
// to tune are re-estimated from the data, then reported so the operator can
// override them.
//
//   - oiiiSynthesis   (C2) OIII = wG*G + wB*B from an HO / SO stack, with the
//                          two independent estimates integrated together.
//   - oiiiFromChannel (A/C1) OIII extracted from a GB stack or green channel,
//                          subtracted from the RGB green/blue channels.
//   - haCleanRefine   (C1) `Ha_clean = Ha - Q*(RGB_R - med(RGB_R))` with Q
//                          solved from the background statistics of both frames
//                          (Q that equalises background medians is the neutral
//                          value; the prompt's 0.045 is a typical answer).
//   - injectHa        (C1) R/G/B labels with the `B` gain, B re-estimated as
//                          the ratio that makes the injected signal's peak
//                          reach a target fraction of the host's dynamic range.
//   - channelWeightBlend (A) the dynamic-mix formula, emitted as ready-to-run
//                          PixelMath so the operator can edit the weights.
//
// PJSR constraint: ECMAScript 5 only — no let/const/arrow inside ctx.pjsr code.
// ============================================================================

function failed(r) {
  return r && r.status === 'error';
}

function errText(r, fallback) {
  return (r && r.error && (r.error.message || r.error.toString())) || fallback;
}

function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(6) : '0.000000';
}

/**
 * Read per-channel background median and MAD of a view.
 * @returns {Promise<object>} { channels, median: number[], mad: number[], max }
 */
async function channelStats(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    var img = w.mainView.image;
    var med = [], mad = [];
    for (var c = 0; c < img.numberOfChannels; c++) {
      img.selectedChannel = c;
      med.push(img.median());
      mad.push(img.MAD());
    }
    img.resetChannelSelection();
    JSON.stringify({ channels: img.numberOfChannels, median: med, mad: mad, max: img.maximum(new Rect(0, 0, img.width, img.height)) });
  `);
  if (failed(r)) throw new Error(errText(r, 'cannot read channel statistics'));
  const d = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}');
  // Normalise to arrays: a greyscale frame or an older bridge may answer with a
  // scalar, and every consumer below indexes [0]. Letting a scalar through would
  // throw a TypeError instead of reporting a usable number.
  if (!Array.isArray(d.median)) d.median = [Number(d.median) || 0];
  if (!Array.isArray(d.mad)) d.mad = [Number(d.mad) || 0];
  return d;
}

/** First channel value of a stats array (0 when absent). */
function first(v) {
  return Array.isArray(v) && v.length ? Number(v[0]) || 0 : 0;
}

/**
 * Synthesise an OIII estimate from one bi-narrowband stack.
 *
 * Flow C2: the HO stack's R is Ha, so OIII lives in G/B; the SO stack's R is
 * SII. The weights differ because the filter passbands differ:
 *   OIII_HO = 0.2*G + 0.8*B     (HO: most OIII in blue)
 *   OIII_S  = 0.8*G + 0.2*B     (SO: green-dominated)
 *
 * @param {object} ctx
 * @param {object} opts {
 *   source_id: string,      // e.g. 'HO_starless'
 *   weights: [number, number], // [G, B] weights, default [0.2, 0.8]
 *   target_id: string
 * }
 * @returns {Promise<object>} { target_id, weights, stats }
 */
export async function oiiiSynthesis(ctx, opts = {}) {
  const sourceId = opts.source_id;
  const targetId = opts.target_id || `${sourceId}_OIII`;
  if (!sourceId) throw new Error('oiiiSynthesis: source_id is required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  const w = Array.isArray(opts.weights) && opts.weights.length === 2 ? opts.weights : [0.2, 0.8];
  const wG = Number(w[0]);
  const wB = Number(w[1]);
  const norm = wG + wB;

  const r = await ctx.pjsr(`
    var src = ImageWindow.windowById('${sourceId}');
    if (src.isNull) throw new Error('not found: ${sourceId}');
    var img = src.mainView.image;
    if (!img.isColor) throw new Error('oiiiSynthesis needs a colour source');
    var old = ImageWindow.windowById('${targetId}');
    if (!old.isNull) old.forceClose();

    var P = new PixelMath;
    // Read the G and B channels of the source and merge them.
    P.expression = \`${fmt(wG / norm)}*G + ${fmt(wB / norm)}*B\`;
    P.useSingleExpression = true;
    P.createNewImage = true;
    P.newImageId = '${targetId}';
    P.resizeNewImage = false;
    P.rescale = false;
    P.truncate = true;
    P.symbols = [];
    P.executeOn(src.mainView, false);
    if (ImageWindow.windowById('${targetId}').isNull) throw new Error('PixelMath produced no output window');
    'OK';
  `);
  if (failed(r)) throw new Error('oiiiSynthesis: ' + errText(r, 'PixelMath failed'));

  const stats = await channelStats(ctx, targetId);
  log(`  [narrowband] OIII synthesis from ${sourceId}: ${wG}*G + ${wB}*B (normalised ${fmt(wG / norm)}/${fmt(wB / norm)}) → ${targetId}`);
  return { target_id: targetId, weights: [wG, wB], normalised: [wG / norm, wB / norm], stats };
}

/**
 * Integrate several OIII estimates into one higher-SNR OIII plane.
 * Thin wrapper over imageIntegration so flow C2 reads as one command.
 *
 * @param {object} ctx
 * @param {object} opts { estimates: string[], target_id, repeats?: number }
 * @returns {Promise<object>} imageIntegration result
 */
export async function integrateOiii(ctx, opts = {}) {
  const estimates = Array.isArray(opts.estimates) ? opts.estimates : [];
  if (estimates.length < 2) throw new Error('integrateOiii: need at least 2 estimates');
  const targetId = opts.target_id || 'OIII';
  // The prompt says "stack at least three copies" — repeating the estimates
  // reaches three inputs without inventing data.
  const repeats = Math.max(1, Number.isFinite(opts.repeats) ? opts.repeats : Math.ceil(3 / estimates.length));
  const inputs = [];
  for (let i = 0; i < repeats; i++) inputs.push(...estimates);

  const { imageIntegration } = await import('./preprocess.mjs');
  return imageIntegration(ctx, { source_ids: inputs, target_id: targetId, combination: 0, rejection: 0 });
}

/**
 * Estimate the contamination coefficient Q for `Ha_clean = Ha - Q*(R - med(R))`.
 *
 * Method: the RGB red channel carries continuum (broadband starlight/dust)
 * that also lands in the Ha frame, plus Ha signal. At the background level both
 * frames should sit on the same floor, so the Q that equalises the background
 * medians is the physically neutral starting point; anything larger strips
 * real Ha, anything smaller leaves continuum haze.
 *
 * @param {object} ctx
 * @param {object} opts { ha_id, rgb_red_id }
 * @returns {Promise<object>} { Q, ha_median, red_median, ha_mad, red_mad }
 */
export async function estimateContinuumQ(ctx, opts = {}) {
  const haId = opts.ha_id;
  const redId = opts.rgb_red_id;
  if (!haId || !redId) throw new Error('estimateContinuumQ: ha_id and rgb_red_id are required');

  const ha = await channelStats(ctx, haId);
  const red = await channelStats(ctx, redId);
  const haMed = first(ha.median);
  const redMed = first(red.median);

  let Q = 1;
  if (redMed > 0) Q = haMed / redMed;
  // Keep Q in a physically sane band: a value far outside 0..1 means the two
  // frames were not background-matched and the subtraction would be nonsense.
  const clamped = Math.min(1, Math.max(0, Q));
  const warned = Math.abs(clamped - Q) > 1e-9 || Q <= 0;

  return {
    Q: clamped,
    raw_Q: Q,
    ha_median: haMed,
    red_median: redMed,
    ha_mad: first(ha.mad),
    red_mad: first(red.mad),
    warning: warned
      ? 'Q clamped to 0..1 — background-match Ha and RGB first (LinearFit or BackgroundNeutralization)'
      : null
  };
}

/**
 * Produce Ha_clean = Ha - Q*(RGB_R - med(RGB_R)).
 *
 * @param {object} ctx
 * @param {object} opts {
 *   ha_id, rgb_red_id, target_id?: string, Q?: number,
 *   mode?: 'starless' | 'keep'   // subtract on the starless frames (recommended)
 * }
 * @returns {Promise<object>} { target_id, Q, estimate }
 */
export async function haCleanRefine(ctx, opts = {}) {
  const haId = opts.ha_id;
  const redId = opts.rgb_red_id;
  const targetId = opts.target_id || `${haId}_clean`;
  if (!haId || !redId) throw new Error('haCleanRefine: ha_id and rgb_red_id are required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  let estimate = null;
  let Q = Number.isFinite(opts.Q) ? opts.Q : null;
  if (Q === null) {
    estimate = await estimateContinuumQ(ctx, { ha_id: haId, rgb_red_id: redId });
    Q = estimate.Q;
  }
  if (!(Q >= 0)) throw new Error(`haCleanRefine: invalid Q (${Q})`);

  const r = await ctx.pjsr(`
    var ha = ImageWindow.windowById('${haId}');
    if (ha.isNull) throw new Error('not found: ${haId}');
    var red = ImageWindow.windowById('${redId}');
    if (red.isNull) throw new Error('not found: ${redId}');
    if (ha.mainView.image.width !== red.mainView.image.width ||
        ha.mainView.image.height !== red.mainView.image.height) {
      throw new Error('Ha and RGB_R dimensions differ — align and crop them to the same grid first');
    }
    var old = ImageWindow.windowById('${targetId}');
    if (!old.isNull) old.forceClose();

    var P = new PixelMath;
    // Two-image expression: $T is the Ha frame, $T2 the RGB red channel.
    P.expression = \`$T - ${Q.toFixed(6)}*($T2 - med($T2))\`;
    P.useSingleExpression = true;
    P.symbols.push(\`$T2=${redId}\`);
    P.createNewImage = true;
    P.newImageId = '${targetId}';
    P.truncate = true;
    P.rescale = false;
    P.executeOn(ha.mainView, false);
    if (ImageWindow.windowById('${targetId}').isNull) throw new Error('PixelMath produced no output window');
    'OK';
  `);
  if (failed(r)) throw new Error('haCleanRefine: ' + errText(r, 'PixelMath failed'));

  const stats = await channelStats(ctx, targetId);
  log(`  [narrowband] Ha clean: Ha - ${Q.toFixed(4)}*(R - med(R)) → ${targetId} ` +
      `(Q ${estimate ? 'estimated' : 'supplied'})`);

  return { target_id: targetId, Q, estimate, stats };
}

/**
 * Inject Ha_clean into an RGB image.
 *
 *   R: $T + B*(Ha - med(Ha))
 *   G: $T
 *   B: $T + B*blue_scale*(Ha - med(Ha))     blue_scale default 0.1 (Hβ proxy)
 *
 * B is estimated so the injected Ha's peak lands at `target_peak` of the host
 * range; the prompt's 1.75 is a typical result. Set `B` explicitly to override.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   target_id, ha_clean_id, B?: number, blue_scale?: number,
 *   target_peak?: number (default 0.35), use_blue?: boolean (default true)
 * }
 * @returns {Promise<object>} { source_id, B, blue_scale, injected_peak }
 */
export async function injectHa(ctx, opts = {}) {
  const hostId = opts.target_id;
  const cleanId = opts.ha_clean_id;
  if (!hostId || !cleanId) throw new Error('injectHa: target_id and ha_clean_id are required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  const blueScale = Number.isFinite(opts.blue_scale) ? opts.blue_scale : 0.1;
  const useBlue = opts.use_blue !== false;
  const targetPeak = Number.isFinite(opts.target_peak) ? opts.target_peak : 0.35;

  let B = Number.isFinite(opts.B) ? opts.B : null;
  let estimated = null;
  if (B === null) {
    const st = await channelStats(ctx, cleanId);
    var haMax = st.max ?? 0;
    // Peak of (Ha - med) is roughly max - median; B scales that peak to targetPeak.
    const peak = Math.max(1e-9, (st.max ?? 0) - (st.median[0] ?? 0));
    B = targetPeak / peak;
    estimated = { ha_max: st.max, ha_median: st.median[0], peak, target_peak: targetPeak };
  }

  const r = await ctx.pjsr(`
    var host = ImageWindow.windowById('${hostId}');
    if (host.isNull) throw new Error('not found: ${hostId}');
    if (!host.mainView.image.isColor) throw new Error('injectHa needs a colour host image');
    var ha = ImageWindow.windowById('${cleanId}');
    if (ha.isNull) throw new Error('not found: ${cleanId}');
    if (ha.mainView.image.width !== host.mainView.image.width ||
        ha.mainView.image.height !== host.mainView.image.height) {
      throw new Error('Ha and RGB dimensions differ — align and crop them to the same grid first');
    }
    var old = ImageWindow.windowById('${hostId}_HaRGB');
    if (!old.isNull) old.forceClose();

    var P = new PixelMath;
    // Per-channel expressions. PJSR names these expression0/1/2 (= R/G/B);
    // there is no expressionR/expressionG/expressionB, and assigning to a
    // non-existent property fails silently — the whole injection used to be
    // a no-op because of that.
    P.expression0 = \`$T + ${B.toFixed(6)}*($T2 - med($T2))\`;
    P.expression1 = '$T';
    P.expression2 = ${useBlue ? `\`$T + ${(B * blueScale).toFixed(6)}*($T2 - med($T2))\`` : `'$T'`};
    P.useSingleExpression = false;
    P.symbols.push(\`$T2=${cleanId}\`);
    P.createNewImage = true;
    P.newImageId = '${hostId}_HaRGB';
    P.truncate = true;
    P.rescale = false;
    P.executeOn(host.mainView, false);
    if (ImageWindow.windowById('${hostId}_HaRGB').isNull) throw new Error('PixelMath produced no output window');
    'OK';
  `);
  if (failed(r)) throw new Error('injectHa: ' + errText(r, 'PixelMath failed'));

  const outId = `${hostId}_HaRGB`;
  const stats = await channelStats(ctx, outId);
  log(`  [narrowband] Ha injected into ${hostId} → ${outId} (B=${B.toFixed(3)}${useBlue ? `, blue×${blueScale}` : ', no blue injection'})`);

  return {
    source_id: hostId,
    target_id: outId,
    B,
    blue_scale: useBlue ? blueScale : 0,
    estimated,
    stats
  };
}

/**
 * Emit (and optionally run) the dynamic-mix formula for Flow A.
 *
 * R: SII
 * G: 0.8*Ha + 0.2*OIII
 * B: OIII
 *
 * The weights are arguments, not constants, so the operator can push green
 * toward teal (more OIII) or keep it Ha-dominant.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   sii_id, ha_id, oiii_id,
 *   weights?: { g_ha, g_oiii, r_sii, b_oiii },
 *   target_id?: string, run?: boolean (default true)
 * }
 * @returns {Promise<object>} { formula, target_id, stats }
 */
export async function channelWeightBlend(ctx, opts = {}) {
  const { sii_id: siiId, ha_id: haId, oiii_id: oiiiId } = opts;
  if (!siiId || !haId || !oiiiId) {
    throw new Error('channelWeightBlend: sii_id, ha_id and oiii_id are required');
  }
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};
  const w = opts.weights || {};
  const gHa = Number.isFinite(w.g_ha) ? w.g_ha : 0.8;
  const gOiii = Number.isFinite(w.g_oiii) ? w.g_oiii : 0.2;
  const rSii = Number.isFinite(w.r_sii) ? w.r_sii : 1.0;
  const bOiii = Number.isFinite(w.b_oiii) ? w.b_oiii : 1.0;

  const formula = {
    R: `${fmt(rSii)}*SII`,
    G: `${fmt(gHa)}*Ha + ${fmt(gOiii)}*OIII`,
    B: `${fmt(bOiii)}*OIII`
  };
  const targetId = opts.target_id || 'SHO';
  const run = opts.run !== false;

  if (!run) {
    log(`  [narrowband] blend formula prepared (not run): ${JSON.stringify(formula)}`);
    return { formula, target_id: null, executed: false };
  }

  const r = await ctx.pjsr(`
    var sii = ImageWindow.windowById('${siiId}');
    if (sii.isNull) throw new Error('not found: ${siiId}');
    var ha = ImageWindow.windowById('${haId}');
    if (ha.isNull) throw new Error('not found: ${haId}');
    var oiii = ImageWindow.windowById('${oiiiId}');
    if (oiii.isNull) throw new Error('not found: ${oiiiId}');
    var old = ImageWindow.windowById('${targetId}');
    if (!old.isNull) old.forceClose();

    var P = new PixelMath;
    // expression0/1/2 are the R/G/B slots (not expressionR/G/B).
    P.expression0 = \`${formula.R}\`;
    P.expression1 = \`${formula.G}\`;
    P.expression2 = \`${formula.B}\`;
    P.useSingleExpression = false;
    P.symbols.push(\`SII=${siiId}\`);
    P.symbols.push(\`Ha=${haId}\`);
    P.symbols.push(\`OIII=${oiiiId}\`);
    P.createNewImage = true;
    P.newImageId = '${targetId}';
    P.truncate = true;
    P.rescale = false;
    P.executeOn(sii.mainView, false);
    if (ImageWindow.windowById('${targetId}').isNull) throw new Error('PixelMath produced no output window');
    'OK';
  `);
  if (failed(r)) throw new Error('channelWeightBlend: ' + errText(r, 'PixelMath failed'));

  const stats = await channelStats(ctx, targetId);
  log(`  [narrowband] dynamic mix → ${targetId}: R=${formula.R} G=${formula.G} B=${formula.B}`);
  return { formula, target_id: targetId, executed: true, stats };
}
