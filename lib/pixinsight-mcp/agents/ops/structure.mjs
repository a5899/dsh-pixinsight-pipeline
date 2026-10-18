// ============================================================================
// Applied structure enhancement
//
// Two operations the director prompt names explicitly and that the pipeline
// previously did not expose as commands:
//
//   - DarkStructureEnhance (Flow A: deepen dust lanes on the starless image)
//   - RangeSelection-masked saturation (Flow B: local saturation on the galaxy
//     body only, via a mask derived from a luminance range — never a global
//     saturation push that also amplifies background colour noise)
//
// Both operate on non-linear data. Neither touches the linear stage; the
// linear-stage guard in the dispatcher rejects them on linear views unless
// the caller explicitly overrides it.
//
// PJSR constraint: ECMAScript 5 only — no let/const/arrow inside ctx.pjsr code.
// ============================================================================

function failed(r) {
  return r && r.status === 'error';
}

function errText(r, fallback) {
  return (r && r.error && (r.error.message || r.error.toString())) || fallback;
}

/**
 * DarkStructureEnhance: deepen dark dust structures without crushing the
 * background. The script is a PixInsight script (not a process), so it is
 * invoked through Script.run with parameters pushed onto the core parameters.
 *
 * The script auto-derives its own luminance mask; amount/scale are the two
 * knobs that matter.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} [opts] {
 *   amount?: number,   // 0..1 (default 0.2) — strength
 *   scale?:  number,   // 0..1 (default 0.5) — structure scale
 *   smooth?: number    // 0..1 (default 0.25) — mask smoothness
 * }
 * @returns {Promise<object>} { view_id, amount, scale, smooth, before, after }
 */
export async function darkStructureEnhance(ctx, viewId, opts = {}) {
  if (!viewId) throw new Error('darkStructureEnhance: view_id is required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  const amount = Number.isFinite(opts.amount) ? opts.amount : 0.2;
  const scale = Number.isFinite(opts.scale) ? opts.scale : 0.5;
  const smooth = Number.isFinite(opts.smooth) ? opts.smooth : 0.25;

  const beforeR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    JSON.stringify({ median: w.mainView.image.median(), mad: w.mainView.image.MAD() });
  `);
  if (failed(beforeR)) throw new Error('darkStructureEnhance: ' + errText(beforeR, 'view not found'));
  const before = JSON.parse(beforeR.outputs?.consoleOutput?.trim() || '{}');

  // The script operates on the active view; activate it, then run with the
  // three parameters it reads from core parameters.
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    w.mainView.activate();
    var DSE = CoreApplication.scripts.filter(function (s) {
      return /DarkStructureEnhance/i.test(s.filePath || '');
    });
    if (DSE.length === 0) throw new Error('DarkStructureEnhance script not installed');
    Parameters.set('amount', ${amount});
    Parameters.set('scale', ${scale});
    Parameters.set('smooth', ${smooth});
    DSE[0].run();
    'OK';
  `);
  if (failed(r)) throw new Error('darkStructureEnhance: ' + errText(r, 'script failed'));

  const afterR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    JSON.stringify({ median: w.mainView.image.median(), mad: w.mainView.image.MAD() });
  `);
  const after = JSON.parse(afterR.outputs?.consoleOutput?.trim() || '{}');

  // A sane DSE lowers the median slightly (dark structures deepen) but must
  // not halve it — that would mean the background itself got crushed.
  const ratio = before.median > 0 ? after.median / before.median : 1;
  const suspicious = ratio < 0.8;
  if (suspicious) {
    log(`  [structure] DarkStructureEnhance WARN: median dropped to ${(ratio * 100).toFixed(1)}% — check the result`);
  } else {
    log(`  [structure] DarkStructureEnhance amount=${amount} scale=${scale} → median ${before.median?.toExponential(3)} → ${after.median?.toExponential(3)}`);
  }

  return { view_id: viewId, amount, scale, smooth, before, after, median_ratio: ratio, suspicious };
}

/**
 * Build a RangeSelection mask that selects mid-tones (the galaxy body or a
 * nebula's bright structures) and excludes both the background floor and the
 * blown core.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} [opts] {
 *   lower_limit?: number,  // default 0.02
 *   upper_limit?: number,  // default 0.85
 *   smoothness?: number,   // default 0.35
 *   fuzziness?: number,    // default 0.0
 *   use_luminance?: boolean // default true
 *   target_id?: string     // output mask id (default `<view>_rangemask`)
 * }
 * @returns {Promise<object>} { mask_id, params, coverage }
 */
export async function rangeMask(ctx, viewId, opts = {}) {
  if (!viewId) throw new Error('rangeMask: view_id is required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  const lower = Number.isFinite(opts.lower_limit) ? opts.lower_limit : 0.02;
  const upper = Number.isFinite(opts.upper_limit) ? opts.upper_limit : 0.85;
  const smoothness = Number.isFinite(opts.smoothness) ? opts.smoothness : 0.35;
  const fuzziness = Number.isFinite(opts.fuzziness) ? opts.fuzziness : 0.0;
  const useLum = opts.use_luminance === false ? false : true;
  const maskId = opts.target_id || `${viewId}_rangemask`;

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    var old = ImageWindow.windowById('${maskId}');
    if (!old.isNull) old.forceClose();

    var P = new RangeSelection;
    P.lowerLimit = ${lower};
    P.upperLimit = ${upper};
    P.smoothness = ${smoothness};
    P.fuzziness = ${fuzziness};
    P.useLuminanceLimits = ${useLum};
    // Run on a clone so the mask has its own window instead of replacing the
    // target's pixels (RangeSelection's default in-place behaviour).
    var M = new ImageWindow(w.mainView.image.width, w.mainView.image.height,
                            w.mainView.image.numberOfChannels, 32, true, false, '${maskId}');
    M.mainView.beginProcess();
    M.mainView.image.assign(w.mainView.image);
    M.mainView.endProcess();
    P.executeOn(M.mainView, false);
    M.show();
    'OK';
  `);
  if (failed(r)) throw new Error('rangeMask: ' + errText(r, 'RangeSelection failed'));

  // Report how much of the frame the mask covers; near 0 or near 1 both mean
  // the limits are useless for a targeted saturation push.
  const covR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${maskId}');
    if (w.isNull) throw new Error('mask not found');
    var img = w.mainView.image;
    var ch = img.numberOfChannels > 1 ? 0 : 0;
    var sum = 0, n = 0;
    var step = Math.max(1, Math.floor(Math.min(img.width, img.height) / 64));
    for (var y = 0; y < img.height; y += step) {
      for (var x = 0; x < img.width; x += step) {
        sum += img.sample(x, y, ch);
        n++;
      }
    }
    JSON.stringify({ coverage: n > 0 ? sum / n : 0 });
  `);
  const coverage = covR.outputs?.consoleOutput
    ? JSON.parse(covR.outputs.consoleOutput.trim() || '{}').coverage
    : 0;

  const warn = coverage < 0.01 || coverage > 0.95
    ? 'mask covers almost nothing or almost everything — adjust lower/upper limits'
    : null;
  log(`  [structure] RangeSelection mask ${maskId} coverage ${(coverage * 100).toFixed(1)}%` +
      (warn ? ` (WARN: ${warn})` : ''));

  return {
    mask_id: maskId,
    params: { lower_limit: lower, upper_limit: upper, smoothness, fuzziness, use_luminance: useLum },
    coverage,
    warning: warn
  };
}

/**
 * Apply a mask to the active view for the duration of a callback.
 * Keeps mask plumbing in one place so no operation silently runs unmasked.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {string|null} maskId
 * @param {Function} fn async () => result
 * @returns {Promise<any>} fn's result
 */
async function withMask(ctx, viewId, maskId, fn) {
  const setR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    ${maskId
      ? `var m = ImageWindow.windowById('${maskId}');
         if (m.isNull) throw new Error('mask not found: ${maskId}');
         w.maskVisible = true;
         w.maskEnabledForRendering = true;
         w.mainView.mask = m.mainView;`
      : `w.mainView.removeMask();
         w.maskVisible = false;`}
    'OK';
  `);
  if (failed(setR)) throw new Error('withMask: ' + errText(setR, 'cannot set mask'));

  try {
    return await fn();
  } finally {
    // Always clear the mask, even if the operation threw — a leaked mask
    // silently corrupts every later operation in the session.
    await ctx.pjsr(`
      var w = ImageWindow.windowById('${viewId}');
      if (!w.isNull) {
        w.mainView.removeMask();
        w.maskVisible = false;
        w.maskEnabledForRendering = false;
      }
      'OK';
    `);
  }
}

/**
 * Masked saturation boost via CurvesTransformation's S channel.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} [opts] {
 *   mask_id?: string,        // use an existing mask (else `viewId_rangemask` is built)
 *   auto_mask?: boolean,     // build the mask first (default true when mask_id absent)
 *   lower_limit?, upper_limit?, smoothness?,   // forwarded to rangeMask
 *   saturation_gain?: number, // 1.0 = one unit of saturation curve lift (default 0.25)
 *   hue_shift?: boolean       // also apply a small hue push toward blue/violet
 * }
 * @returns {Promise<object>} { view_id, mask_id, coverage, before, after }
 */
export async function maskedSaturation(ctx, viewId, opts = {}) {
  if (!viewId) throw new Error('maskedSaturation: view_id is required');
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};

  let maskId = opts.mask_id || null;
  let coverage = null;
  const autoMask = opts.auto_mask !== false;
  if (!maskId && autoMask) {
    const m = await rangeMask(ctx, viewId, opts);
    maskId = m.mask_id;
    coverage = m.coverage;
  }

  const gain = Number.isFinite(opts.saturation_gain) ? opts.saturation_gain : 0.25;

  const beforeR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('not found: ${viewId}');
    var img = w.mainView.image;
    JSON.stringify({ channels: img.numberOfChannels, color: img.isColor, mad: img.MAD() });
  `);
  if (failed(beforeR)) throw new Error('maskedSaturation: ' + errText(beforeR, 'view not found'));
  const before = JSON.parse(beforeR.outputs?.consoleOutput?.trim() || '{}');
  if (!before.color) {
    throw new Error('maskedSaturation: view is greyscale — saturation needs a colour image');
  }

  const gainStr = Math.max(0, gain).toFixed(4);

  await withMask(ctx, viewId, maskId, async () => {
    const r = await ctx.pjsr(`
      var w = ImageWindow.windowById('${viewId}');
      if (w.isNull) throw new Error('not found: ${viewId}');
      var P = new CurvesTransformation;
      // Saturation channel curve: pull the mid-point up, pin the corners at
      // the identity points so pure grey and pure colour stay fixed.
      var pts = [ // x0,y0, x1,y1, ...
        0.0, 0.0,
        0.35, ${(0.35 + gain * 0.35).toFixed(4)},
        0.65, ${(0.65 + gain * 0.65).toFixed(4)},
        1.0, 1.0
      ];
      P.S = pts;
      ${opts.hue_shift ? `
      // Optional: push the hue curve slightly toward blue/violet, the classic
      // galaxy-core treatment the director prompt mentions.
      P.H = [0.0, 0.0, 0.5, 0.52, 1.0, 1.0];` : ''}
      P.executeOn(w.mainView, false);
      'OK';
    `);
    if (failed(r)) throw new Error('maskedSaturation: ' + errText(r, 'CurvesTransformation failed'));
  });

  // The mask itself is an artefact of the operation; remove it unless reused.
  if (!opts.mask_id && maskId) {
    await ctx.pjsr(`var m = ImageWindow.windowById('${maskId}'); if (!m.isNull) m.forceClose();`);
  }

  const afterR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    JSON.stringify({ mad: w.mainView.image.MAD(), max: w.mainView.image.maximum() });
  `);
  const after = JSON.parse(afterR.outputs?.consoleOutput?.trim() || '{}');

  log(`  [structure] masked saturation gain=${gainStr} (mask ${maskId || 'none'}) → MAD ${before.mad?.toExponential(3)} → ${after.mad?.toExponential(3)}`);

  return { view_id: viewId, mask_id: maskId || null, coverage, saturation_gain: gain, gain_curve: gainStr, before, after };
}
