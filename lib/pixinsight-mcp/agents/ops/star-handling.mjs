// ============================================================================
// Star handling
//
// Covers the director prompt's star workflow:
//   - SXT separation into Starless + Stars (with native fallback)
//   - 去紫/去洋红: 反相 → SCNR(去绿) → 反相   (no inverted mask)
//   - 星点缩小 MorphologicalTransformation
//   - 重组 Starless + Stars (PixelMath screen blend or addition)
//   - 彩噪 ACDNR before NXT
// ============================================================================

import { getStats } from './stats.mjs';

/**
 * Split a view into starless + stars using StarXTerminator (preferred) or a
 * native StarMask + morphological fallback.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   source_id, starless_id, stars_id,
 *   unscreen: boolean (SXT "Screen stars" inverse — default true),
 *   tool: 'StarXTerminator' | 'StarNet2' | 'StarNet' | 'native'
 * }
 * @returns {Promise<object>} { tool, native, starless_id, stars_id, starlessStats, starsStats }
 */
export async function separateStars(ctx, opts) {
  const { source_id } = opts;
  const starless_id = opts.starless_id || `${source_id}_starless`;
  const stars_id = opts.stars_id || `${source_id}_stars`;
  const tool = opts.tool || 'StarXTerminator';

  if (tool === 'native') {
    return await separateStarsNative(ctx, { source_id, starless_id, stars_id });
  }

  const ctor = tool;
  const r = await ctx.pjsr(`
    var src = ImageWindow.windowById('${source_id}');
    if (src.isNull) throw new Error('source not found: ${source_id}');
    var img = src.mainView.image;
    var slOld = ImageWindow.windowById('${starless_id}');
    if (!slOld.isNull) slOld.forceClose();
    var stOld = ImageWindow.windowById('${stars_id}');
    if (!stOld.isNull) stOld.forceClose();

    var sl = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, '${starless_id}');
    sl.show();
    var st = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, '${stars_id}');
    st.show();

    var P = new ${ctor};
    P.generateStarMask = true;
    P.unscreenStars = ${opts.unscreen !== false ? 'true' : 'false'};
    P.starlessImageId = '${starless_id}';
    P.starsImageId = '${stars_id}';
    P.executeOn(src.mainView);
    '${ctor}';
  `);
  if (r.status === 'error') {
    ctx.log(`  [stars] ${tool} unavailable or failed (${r.error?.message || 'PJSR error'}) — falling back to native StarMask`);
    return await separateStarsNative(ctx, { source_id, starless_id, stars_id });
  }

  ctx.log(`  [stars] separated ${source_id} → ${starless_id} + ${stars_id} via ${tool}`);
  return {
    tool,
    native: false,
    starless_id,
    stars_id,
    starlessStats: await getStats(ctx, starless_id),
    starsStats: await getStats(ctx, stars_id)
  };
}

/**
 * Native star removal: build a StarMask, subtract the bright core, then
 * leave the residual stars in the difference image.
 *
 * This is deliberately conservative — a stock StarMask + darkness morph does
 * not fully remove stars the way SXT does. It is good enough to let structure
 * enhancement run on the starless plate while keeping the star plate usable.
 */
async function separateStarsNative(ctx, opts) {
  const { source_id } = opts;
  const starless_id = opts.starless_id || `${source_id}_starless`;
  const stars_id = opts.stars_id || `${source_id}_stars`;

  const r = await ctx.pjsr(`
    var src = ImageWindow.windowById('${source_id}');
    if (src.isNull) throw new Error('source not found: ${source_id}');
    var img = src.mainView.image;

    var slOld = ImageWindow.windowById('${starless_id}');
    if (!slOld.isNull) slOld.forceClose();
    var stOld = ImageWindow.windowById('${stars_id}');
    if (!stOld.isNull) stOld.forceClose();

    // Starless = copy of source
    var sl = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, '${starless_id}');
    sl.show();
    sl.mainView.beginProcess();
    sl.mainView.image.assign(img);
    sl.mainView.endProcess();

    // Star mask from the source
    var maskId = '${source_id}_starmask_tmp';
    var mo = ImageWindow.windowById(maskId);
    if (!mo.isNull) mo.forceClose();
    var mw = new ImageWindow(img.width, img.height, 1, 32, true, false, maskId);
    mw.show();
    var SM = new StarMask;
    SM.executeOn(src.mainView);
    // StarMask writes to a new window — grab it by scanning new windows.
    var got = null;
    var all = ImageWindow.windows;
    for (var i = 0; i < all.length; i++) {
      if (all[i].mainView.id !== '${source_id}' && all[i].mainView.id !== '${starless_id}'
          && all[i].mainView.id.indexOf('starmask') < 0 && all[i].mainView.id !== maskId
          && all[i].mainView.image.numberOfChannels === 1) {
        got = all[i];
      }
    }
    if (got) {
      // Darken stars in the starless plate proportionally to the mask.
      var PM = new PixelMath;
      PM.expression = "\$T * (1 - 0.92*" + got.mainView.id + ")";
      PM.useSingleExpression = true;
      PM.use64BitWorkingImage = true;
      PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
      PM.createNewImage = false;
      PM.executeOn(sl.mainView);
      got.forceClose();
    }
    mw.forceClose();

    // Stars = source - starless (clamped)
    var st = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, '${stars_id}');
    st.show();
    var PM2 = new PixelMath;
    PM2.expression = "max(0, ${source_id} - ${starless_id})";
    PM2.useSingleExpression = true;
    PM2.use64BitWorkingImage = true;
    PM2.truncate = true; PM2.truncateLower = 0; PM2.truncateUpper = 1;
    PM2.createNewImage = false;
    PM2.executeOn(st.mainView);
    'native';
  `);
  if (r.status === 'error') throw new Error('Native star separation failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stars] native separation ${source_id} → ${starless_id} + ${stars_id} (approximate)`);
  return {
    tool: 'StarMask(native)',
    native: true,
    approximate: true,
    starless_id,
    stars_id,
    starlessStats: await getStats(ctx, starless_id),
    starsStats: await getStats(ctx, stars_id)
  };
}

/**
 * 去紫/去洋红 on a STARS image.
 *
 * Director prompt: "反相 → SCNR 去绿 → 反相（不要套蒙版反相）"
 *
 * Inverting turns magenta (R+B high, G low) into green (G high, R+B low);
 * SCNR then removes that green; inverting back leaves R+B without the
 * green cast that made it magenta.
 *
 * @param {object} ctx
 * @param {object} opts { view_id, amount (0..1, default 1.0), mode: 'magenta'|'green' }
 * @returns {Promise<object>} stats
 */
export async function fixStarColor(ctx, opts) {
  const { view_id } = opts;
  const amount = opts.amount ?? 1.0;
  const mode = opts.mode || 'magenta';

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${view_id}');
    if (w.isNull) throw new Error('view not found: ${view_id}');
    if (!w.mainView.image.isColor) throw new Error('fixStarColor requires a color image: ${view_id}');

    // Step 1: invert
    var inv = new Invert;
    inv.executeOn(w.mainView);

    // Step 2: SCNR remove green
    var P = new SCNR;
    P.amount = ${amount};
    P.protectionMethod = SCNR.prototype.MaximumMasking;
    P.preserveLuminance = true;
    P.executeOn(w.mainView);

    // Step 3: invert back
    var inv2 = new Invert;
    inv2.executeOn(w.mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('Star color fix failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stars] removed ${mode} cast from ${view_id} via invert → SCNR(${amount}) → invert`);
  return await getStats(ctx, view_id);
}

/**
 * Standard green removal on a composite (universe has no green stars).
 * @param {object} ctx
 * @param {object} opts { view_id, amount, preserveLuminance }
 * @returns {Promise<object>} stats
 */
export async function removeGreen(ctx, opts) {
  const { view_id } = opts;
  const amount = opts.amount ?? 0.85;
  const preserveLum = opts.preserveLuminance !== false;
  const r = await ctx.pjsr(`
    var P = new SCNR;
    P.amount = ${amount};
    P.protectionMethod = SCNR.prototype.MaximumMasking;
    P.preserveLuminance = ${preserveLum ? 'true' : 'false'};
    P.executeOn(ImageWindow.windowById('${view_id}').mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('SCNR failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stars] SCNR green removed from ${view_id} (amount=${amount})`);
  return await getStats(ctx, view_id);
}

/**
 * Shrink stars via MorphologicalTransformation (erosion, circular structure).
 * @param {object} ctx
 * @param {object} opts { view_id, iterations (default 1), size (3|5|7), amount }
 * @returns {Promise<object>} stats
 */
export async function shrinkStars(ctx, opts) {
  const { view_id } = opts;
  const iterations = opts.iterations ?? 1;
  const size = opts.size ?? 5;
  const r = await ctx.pjsr(`
    var P = new MorphologicalTransformation;
    P.operator = MorphologicalTransformation.prototype.Erosion;
    P.amount = ${opts.amount ?? 0.5};
    P.iterations = ${iterations};
    P.structureName = 'Circular';
    P.structureSize = ${size};
    P.lowThreshold = 0.010;
    P.highThreshold = 0.900;
    P.forceSeed = false;
    P.executeOn(ImageWindow.windowById('${view_id}').mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('Star shrink failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stars] shrunk stars in ${view_id} (iterations=${iterations}, size=${size})`);
  return await getStats(ctx, view_id);
}

/**
 * Recompose Starless + Stars.
 *
 * Director prompt: "Toolbox → CombineImages / PixelMath 相加（Create new image）".
 * Screened addition is used by default because it avoids clipping the
 * Starless highlights where the star halo overlaps them.
 *
 * @param {object} ctx
 * @param {object} opts {
 *   starless_id, stars_id, out_id,
 *   strength (default 0.85), method: 'screen' | 'add' | 'max'
 * }
 * @returns {Promise<object>} { out_id, stats }
 */
export async function recombineStars(ctx, opts) {
  const { starless_id, stars_id } = opts;
  const out_id = opts.out_id || `${starless_id}_final`;
  const strength = opts.strength ?? 0.85;
  const method = opts.method || 'screen';

  let expr;
  if (method === 'add') {
    expr = `min(1, ${starless_id} + ${strength}*${stars_id})`;
  } else if (method === 'max') {
    expr = `max(${starless_id}, ${strength}*${stars_id})`;
  } else {
    expr = `~(~${starless_id} * ~(${strength}*${stars_id}))`;
  }

  const r = await ctx.pjsr(`
    var sl = ImageWindow.windowById('${starless_id}');
    var st = ImageWindow.windowById('${stars_id}');
    if (sl.isNull) throw new Error('starless not found: ${starless_id}');
    if (st.isNull) throw new Error('stars not found: ${stars_id}');
    var img = sl.mainView.image;
    var old = ImageWindow.windowById('${out_id}');
    if (!old.isNull) old.forceClose();
    var nw = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, '${out_id}');
    nw.show();
    var PM = new PixelMath;
    PM.expression = "${expr}";
    PM.useSingleExpression = true;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = false;
    PM.executeOn(nw.mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('Star recombination failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stars] recomposed ${out_id} = ${method}(${starless_id}, ${strength}*${stars_id})`);
  return { out_id, stats: await getStats(ctx, out_id) };
}

/**
 * Chroma-only denoise (ACDNR) — director prompt says use it before NXT when
 * color noise is heavy. ACDNR with luminance disabled touches only chrominance.
 *
 * @param {object} ctx
 * @param {object} opts { view_id, chromaAmount, luminance (false), sigma }
 * @returns {Promise<object>} stats
 */
export async function denoiseChroma(ctx, opts) {
  const { view_id } = opts;
  const chromaAmount = opts.chromaAmount ?? 0.6;
  const r = await ctx.pjsr(`
    var P = new ACDNR;
    P.amountL = 0;
    P.amountC = ${chromaAmount};
    P.iterationsL = 0;
    P.iterationsC = ${opts.iterations ?? 3};
    P.layersL = 4;
    P.layersC = ${opts.layers ?? 3};
    P.thresholdL = 1.2;
    P.thresholdC = ${opts.threshold ?? 2.0};
    P.executeOn(ImageWindow.windowById('${view_id}').mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('ACDNR failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stars] ACDNR chroma-only denoise on ${view_id} (amountC=${chromaAmount})`);
  return await getStats(ctx, view_id);
}
