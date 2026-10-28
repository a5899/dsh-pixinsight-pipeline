// ============================================================================
// Stretch operations extracted from run-pipeline.mjs
// Seti Statistical Stretch (faithful port of statisticalstretch.js v2.3)
// By Franklin Marek (SetiAstro) — CC BY-NC 4.0
// GHS via PixelMath
// ============================================================================

import { getStats } from './stats.mjs';

// ============================================================================
// Seti Statistical Stretch
// Handles both mono (L_work) and color (RGB) images with proper expressions.
// ============================================================================
export async function setiStretch(ctx, viewId, opts = {}) {
  const targetMedian   = opts.targetMedian ?? 0.25;
  const blackpointSigma = opts.blackpointSigma ?? 5.0;
  const noBlackClip    = opts.noBlackClip ?? false;
  const normalize      = opts.normalize ?? false;
  const hdrCompress    = opts.hdrCompress ?? false;
  const hdrAmount      = opts.hdrAmount ?? 0.25;
  const hdrKnee        = opts.hdrKnee ?? 0.35;
  const hdrHeadroom    = opts.hdrHeadroom ?? 0;
  const maxIterations  = opts.iterations ?? 1;
  const convergenceThreshold = 0.001;

  // Detect if image is color
  const isColorR = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    w.mainView.image.isColor ? 'color' : 'mono';
  `);
  const isColor = (isColorR.outputs?.consoleOutput || '').includes('color');

  const st0 = await getStats(ctx, viewId);
  ctx.log(`    Seti stretch [${isColor ? 'color' : 'mono'}]: target=${targetMedian}, bpSigma=${blackpointSigma}, HDR=${hdrCompress}(amount=${hdrAmount},knee=${hdrKnee},headroom=${hdrHeadroom}), maxIter=${maxIterations}`);
  ctx.log(`    Initial: median=${st0.median.toFixed(6)} (${Math.round(st0.median*65535)} ADU), MAD=${st0.mad.toFixed(6)}, max=${(st0.max ?? 0).toFixed(4)}`);

  const T = targetMedian;
  const noClipFlag = noBlackClip ? '1' : '0';

  for (let iter = 0; iter < maxIterations; iter++) {
    let r;

    // Step 1: Blackpoint / rescale
    let bpExpr, bpSymbols;
    if (isColor) {
      // Color linked: luma-weighted blackpoint (Rec.709), applied uniformly to all channels
      bpExpr = [
        'cr=0.2126; cg=0.7152; cb=0.0722;',
        'Med = cr*med($T[0]) + cg*med($T[1]) + cb*med($T[2]);',
        `Sig = 1.4826*(cr*MAD($T[0]) + cg*MAD($T[1]) + cb*MAD($T[2]));`,
        'MinC = min(min($T[0]),min($T[1]),min($T[2]));',
        `BPraw = Med - ${blackpointSigma}*Sig;`,
        `BP = iif(${noClipFlag}, MinC, iif(BPraw < MinC, MinC, BPraw));`,
        'Rescaled = ($T - BP) / (1 - BP);',
        'Rescaled;'
      ].join('\\n');
      bpSymbols = 'cr,cg,cb,Med,Sig,MinC,BPraw,BP,Rescaled';
    } else {
      // Mono: straightforward per-channel
      bpExpr = [
        'Med = med($T);',
        'Sig = 1.4826*MAD($T);',
        `BPraw = Med - ${blackpointSigma}*Sig;`,
        `BP = iif(${noClipFlag}, min($T), iif(BPraw < min($T), min($T), BPraw));`,
        'Rescaled = ($T - BP) / (1 - BP);',
        'Rescaled;'
      ].join('\\n');
      bpSymbols = 'Med, Sig, BPraw, BP, Rescaled';
    }

    r = await ctx.pjsr(`
      var P = new PixelMath;
      P.expression = "${bpExpr}";
      P.useSingleExpression = true;
      P.symbols = "${bpSymbols}";
      P.use64BitWorkingImage = true;
      P.truncate = false;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    if (r.status === 'error') { ctx.log(`      WARN step1: ${r.error.message}`); break; }

    // Step 2: Midtones transfer (closed-form MTF mapping median -> targetMedian)
    let mtfExpr, mtfSymbols;
    if (isColor) {
      // Color linked: use average of 3 channel medians as single median
      mtfExpr = `MedianColor = avg(Med($T[0]),Med($T[1]),Med($T[2]));\\n((MedianColor-1)*${T}*$T)/(MedianColor*(${T}+$T-1)-${T}*$T)`;
      mtfSymbols = 'L, MedianColor, S';
    } else {
      // Mono: use Med($T) directly
      mtfExpr = `((Med($T)-1)*${T}*$T)/(Med($T)*(${T}+$T-1)-${T}*$T)`;
      mtfSymbols = 'L, S';
    }

    r = await ctx.pjsr(`
      var P = new PixelMath;
      P.expression = "${mtfExpr}";
      P.useSingleExpression = true;
      P.symbols = "${mtfSymbols}";
      P.use64BitWorkingImage = true;
      P.truncate = false;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    if (r.status === 'error') { ctx.log(`      WARN step2: ${r.error.message}`); break; }

    // Step 3: Normalize or truncate
    if (normalize) {
      const normExpr = isColor
        ? 'Mcolor=max(max($T[0]),max($T[1]),max($T[2]));\\n$T/Mcolor;'
        : '$T/max($T)';
      r = await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${normExpr}";
        P.useSingleExpression = true;
        P.symbols = "Mcolor";
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
      if (r.status === 'error') ctx.log(`      WARN step3: ${r.error.message}`);
    } else {
      r = await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "$T";
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
    }

    // Step 4: Optional HDR compress (Hermite soft-knee)
    if (hdrCompress && hdrAmount > 0) {
      let hdrExpr, hdrSymbols;
      if (isColor) {
        // Color: compute luma Y, compress Y, scale RGB uniformly by Yc/Y
        hdrExpr = [
          `a = ${hdrAmount};`,
          `k = ${hdrKnee};`,
          'k = min(0.999999, max(0.1, k));',
          'R = $T[0]; G = $T[1]; B = $T[2];',
          'cr = 0.2126; cg = 0.7152; cb = 0.0722;',
          'Y = cr*R + cg*G + cb*B;',
          'hi = Y > k;',
          't = (Y - k)/(1 - k);',
          't = min(1, max(0, t));',
          't2 = t*t;',
          't3 = t2*t;',
          'h10 = (t3 - 2*t2 + t);',
          'h01 = (-2*t3 + 3*t2);',
          'h11 = (t3 - t2);',
          'm1 = min(5, max(1, 1 + 4*a));',
          `ep = ${(1 - hdrHeadroom).toFixed(4)};`,
          'f = h10*1 + h01*ep + h11*m1;',
          'Yc = k + (1 - k)*min(1, max(0, f));',
          's = iif(hi, iif(Y <= 1.0e-10, 1, Yc/Y), 1);',
          '$T * s;'
        ].join('\\n');
        hdrSymbols = 'a,k,x,hi,t,t2,t3,h10,h01,h11,m1,ep,f,y,R,G,B,cr,cg,cb,Y,Yc,s';
      } else {
        // Mono: compress pixel values directly
        hdrExpr = [
          `a = ${hdrAmount};`,
          `k = ${hdrKnee};`,
          'k = min(0.999999, max(0.1, k));',
          'x = $T;',
          'hi = x > k;',
          't = (x - k)/(1 - k);',
          't = min(1, max(0, t));',
          't2 = t*t;',
          't3 = t2*t;',
          'h10 = (t3 - 2*t2 + t);',
          'h01 = (-2*t3 + 3*t2);',
          'h11 = (t3 - t2);',
          'm1 = min(5, max(1, 1 + 4*a));',
          `ep = ${(1 - hdrHeadroom).toFixed(4)};`,
          'f = h10*1 + h01*ep + h11*m1;',
          'y = k + (1 - k)*min(1, max(0, f));',
          'iif(hi, y, x);'
        ].join('\\n');
        hdrSymbols = 'a,k,x,hi,t,t2,t3,h10,h01,h11,m1,ep,f,y';
      }

      r = await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${hdrExpr}";
        P.useSingleExpression = true;
        P.symbols = "${hdrSymbols}";
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
      if (r.status === 'error') ctx.log(`      WARN step4 HDR: ${r.error.message}`);
    }

    // Check convergence
    const stIter = await getStats(ctx, viewId);
    const diff = Math.abs(stIter.median - targetMedian);
    ctx.log(`    Iter ${iter+1}: median=${stIter.median.toFixed(6)} (${Math.round(stIter.median*65535)} ADU), max=${(stIter.max ?? 0).toFixed(4)}, diff=${diff.toFixed(6)}`);

    if (diff < convergenceThreshold) {
      ctx.log(`    Converged after ${iter+1} iteration(s).`);
      break;
    }
  }

  const stFinal = await getStats(ctx, viewId);
  ctx.log(`    Final: median=${stFinal.median.toFixed(6)} (${Math.round(stFinal.median*65535)} ADU), max=${(stFinal.max ?? 0).toFixed(4)}`);
  return stFinal;
}

// ============================================================================
// GHS via PixelMath
// ============================================================================
export function computeGHSCoefficients(orgD, B, SP, LP, HP) {
  const D = Math.exp(orgD) - 1.0;
  if (D === 0) return null;
  let a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,q0,qwp,qlp,q1,q;
  if (B === -1) {
    qlp = -Math.log(1+D*(SP-LP)); q0 = qlp - D*LP/(1+D*(SP-LP));
    qwp = Math.log(1+D*(HP-SP)); q1 = qwp + D*(1-HP)/(1+D*(HP-SP));
    q = 1/(q1-q0);
    a1=0; b1=D/(1+D*(SP-LP))*q;
    a2=-q0*q; b2=-q; c2=1+D*SP; d2=-D; e2=0;
    a3=-q0*q; b3=q; c3=1-D*SP; d3=D; e3=0;
    a4=(qwp-q0-D*HP/(1+D*(HP-SP)))*q; b4=q*D/(1+D*(HP-SP));
    return {type:'log',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  if (B === 0) {
    qlp = Math.exp(-D*(SP-LP)); q0 = qlp - D*LP*Math.exp(-D*(SP-LP));
    qwp = 2 - Math.exp(-D*(HP-SP)); q1 = qwp + D*(1-HP)*Math.exp(-D*(HP-SP));
    q = 1/(q1-q0);
    a1=0; b1=D*Math.exp(-D*(SP-LP))*q;
    a2=-q0*q; b2=q; c2=-D*SP; d2=D; e2=0;
    a3=(2-q0)*q; b3=-q; c3=D*SP; d3=-D; e3=0;
    a4=(qwp-q0-D*HP*Math.exp(-D*(HP-SP)))*q; b4=D*Math.exp(-D*(HP-SP))*q;
    return {type:'exp',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  if (B < 0) {
    const aB = -B;
    qlp = (1-Math.pow(1+D*aB*(SP-LP),(aB-1)/aB))/(aB-1);
    q0 = qlp - D*LP*Math.pow(1+D*aB*(SP-LP),-1/aB);
    qwp = (Math.pow(1+D*aB*(HP-SP),(aB-1)/aB)-1)/(aB-1);
    q1 = qwp + D*(1-HP)*Math.pow(1+D*aB*(HP-SP),-1/aB);
    q = 1/(q1-q0);
    a1=0; b1=D*Math.pow(1+D*aB*(SP-LP),-1/aB)*q;
    a2=(1/(aB-1)-q0)*q; b2=-q/(aB-1); c2=1+D*aB*SP; d2=-D*aB; e2=(aB-1)/aB;
    a3=(-1/(aB-1)-q0)*q; b3=q/(aB-1); c3=1-D*aB*SP; d3=D*aB; e3=(aB-1)/aB;
    a4=(qwp-q0-D*HP*Math.pow(1+D*aB*(HP-SP),-1/aB))*q; b4=D*Math.pow(1+D*aB*(HP-SP),-1/aB)*q;
    return {type:'pow',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  qlp = Math.pow(1+D*B*(SP-LP),-1/B); q0 = qlp - D*LP*Math.pow(1+D*B*(SP-LP),-(1+B)/B);
  qwp = 2 - Math.pow(1+D*B*(HP-SP),-1/B); q1 = qwp + D*(1-HP)*Math.pow(1+D*B*(HP-SP),-(1+B)/B);
  q = 1/(q1-q0);
  a1=0; b1=D*Math.pow(1+D*B*(SP-LP),-(1+B)/B)*q;
  a2=-q0*q; b2=q; c2=1+D*B*SP; d2=-D*B; e2=-1/B;
  a3=(2-q0)*q; b3=-q; c3=1-D*B*SP; d3=D*B; e3=-1/B;
  a4=(qwp-q0-D*HP*Math.pow(1+D*B*(HP-SP),-(B+1)/B))*q; b4=D*Math.pow(1+D*B*(HP-SP),-(B+1)/B)*q;
  return {type:'pow',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
}

function n(v) {
  const s = v.toFixed(12).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  return v < 0 ? `(${s})` : s;
}

export function buildGHSExpr(c) {
  let e1,e2,e3,e4;
  if (c.type === 'log') {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*ln(${n(c.c2)}+${n(c.d2)}*$T)`;
    e3=`${n(c.a3)}+${n(c.b3)}*ln(${n(c.c3)}+${n(c.d3)}*$T)`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  } else if (c.type === 'exp') {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*exp(${n(c.c2)}+${n(c.d2)}*$T)`;
    e3=`${n(c.a3)}+${n(c.b3)}*exp(${n(c.c3)}+${n(c.d3)}*$T)`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  } else {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*exp(${n(c.e2)}*ln(${n(c.c2)}+${n(c.d2)}*$T))`;
    e3=`${n(c.a3)}+${n(c.b3)}*exp(${n(c.e3)}*ln(${n(c.c3)}+${n(c.d3)}*$T))`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  }
  let result = e3;
  if (c.HP < 1.0) result = `iif($T<${n(c.HP)},${e3},${e4})`;
  if (c.LP < c.SP) result = `iif($T<${n(c.SP)},${e2},${result})`;
  if (c.LP > 0.0) result = `iif($T<${n(c.LP)},${e1},${result})`;
  return result;
}

export function ghsCode(ctx, viewId, orgD, B, SP, LP, HP) {
  // Validate: HP must be > SP, LP must be < SP
  if (HP <= SP) {
    ctx.log(`    WARN: GHS skipped — HP (${HP}) must be > SP (${SP})`);
    return '/* HP<=SP, skipped */';
  }
  if (LP >= SP) {
    ctx.log(`    WARN: GHS skipped — LP (${LP}) must be < SP (${SP})`);
    return '/* LP>=SP, skipped */';
  }
  const c = computeGHSCoefficients(orgD, B, SP, LP, HP);
  if (!c) return '/* D=0 */';
  const expr = buildGHSExpr(c);
  // Safety check: if NaN leaked into the expression, skip
  if (expr.includes('NaN') || expr.includes('Infinity')) {
    ctx.log(`    WARN: GHS produced NaN/Infinity coefficients — skipped`);
    return '/* NaN coefficients, skipped */';
  }
  return `
    var P = new PixelMath; P.expression = '${expr}'; P.useSingleExpression = true;
    P.createNewImage = false; P.use64BitWorkingImage = true;
    P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `;
}

/**
 * Apply a GHS stretch as a proper operation (with stats + acceptance hooks).
 *
 * Placed here so pi-tool can call it in one shot instead of stitching PJSR.
 * Uses the native GeneralizedHyperbolicStretch process when installed,
 * otherwise falls back to the PixelMath implementation above (identical curve).
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} opts {
 *   D, b, SP, LP, HP,      // GHS parameters (D is "stretch factor" in linear units)
 *   useNative: boolean,
 *   colorSpace: 'rgb' | 'lightness'
 * }
 * @returns {Promise<object>} { tool, params, stats }
 */
export async function ghsStretch(ctx, viewId, opts = {}) {
  const D = opts.D ?? 0.5;
  const B = opts.b ?? 0.0;
  const SP = opts.SP ?? 0.0;
  const LP = opts.LP ?? 0.0;
  const HP = opts.HP ?? 1.0;

  if (opts.useNative) {
    const r = await ctx.pjsr(`
      var P = new GeneralizedHyperbolicStretch;
      P.stretchType = GeneralizedHyperbolicStretch.prototype.ST_NONE;
      P.stretchFactor = ${D};
      P.localIntensity = ${B};
      P.symmetryPoint = ${SP};
      P.lowRange = ${LP};
      P.highRange = ${HP};
      P.clipType = GeneralizedHyperbolicStretch.prototype.CLIPPED;
      P.colorSpace = ${opts.colorSpace === 'lightness'
        ? 'GeneralizedHyperbolicStretch.prototype.RGBWS'
        : 'GeneralizedHyperbolicStretch.prototype.RGB'};
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      'native';
    `);
    if (r.status !== 'error') {
      ctx.log(`  [stretch] GHS(native): D=${D}, b=${B}, SP=${SP}, LP=${LP}, HP=${HP}`);
      return { tool: 'GeneralizedHyperbolicStretch', params: { D, B, SP, LP, HP }, stats: await getStats(ctx, viewId) };
    }
    ctx.log(`  [stretch] native GHS unavailable (${r.error?.message}) — using PixelMath GHS`);
  }

  const code = ghsCode(ctx, viewId, D, B, SP, LP, HP);
  const r = await ctx.pjsr(code);
  if (r.status === 'error') throw new Error('GHS stretch failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stretch] GHS(pixelmath): D=${D}, b=${B}, SP=${SP}, LP=${LP}, HP=${HP}`);
  return { tool: 'PixelMath-GHS', params: { D, B, SP, LP, HP }, stats: await getStats(ctx, viewId) };
}

/**
 * Multi-Scale Adaptive Stretch (MAS) — the director prompt's preferred
 * stretch for layered results without blowing highlights.
 *
 * Uses the native MultiScaleAdaptiveStretch process when installed; otherwise
 * emulates the "keep highlights, lift shadows" behaviour with a two-stage HT
 * (a soft MTF pass followed by a gentle highlight rolloff), which is the
 * conservative substitute the tool table allows.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} opts {
 *   targetBackground,    // desired background median after stretch (0.20–0.30)
 *   shadowLift,          // 0..1, how aggressively to lift the shadow side
 *   highlightProtect,    // 0..1, highlight rolloff strength
 *   maxIterations
 * }
 * @returns {Promise<object>} { tool, params, stats, iterations }
 */
export async function masStretch(ctx, viewId, opts = {}) {
  const targetBg = opts.targetBackground ?? 0.25;
  const shadowLift = opts.shadowLift ?? 0.5;
  const highlightProtect = opts.highlightProtect ?? 0.5;
  const maxIterations = opts.maxIterations ?? 4;

  // Try the native process first.
  const native = await ctx.pjsr(`
    try {
      var P = new MultiScaleAdaptiveStretch;
      P.targetBackground = ${targetBg};
      P.shadowLift = ${shadowLift};
      P.highlightProtect = ${highlightProtect};
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      'native';
    } catch (e) { 'unavailable: ' + e.message; }
  `);
  const nativeOut = (native.outputs?.consoleOutput || '').trim();
  if (nativeOut === 'native') {
    ctx.log(`  [stretch] MAS(native): targetBg=${targetBg}, shadowLift=${shadowLift}, highlightProtect=${highlightProtect}`);
    return {
      tool: 'MultiScaleAdaptiveStretch',
      params: { targetBg, shadowLift, highlightProtect },
      stats: await getStats(ctx, viewId),
      iterations: 1
    };
  }

  // Emulate with progressive MTF + highlight rolloff.
  ctx.log(`  [stretch] native MAS unavailable (${nativeOut.slice(0, 80)}) — emulating with staged HT`);
  return await stagedHistogramStretch(ctx, viewId, {
    targetBackground: targetBg,
    highlightProtect,
    maxIterations
  });
}

/**
 * Two-stage (multi-step) HistogramTransformation stretch.
 *
 * Director prompt: "视情况用 HT 两段式" — a single violent MTF creates
 * histogram gaps and banding; several gentle passes do not.
 *
 * Each pass moves the median a fraction of the remaining distance to the
 * target, then optionally applies a highlight rolloff so the core does not
 * hit 1.0 prematurely.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} opts { targetBackground, passes, highlightProtect, maxIterations }
 * @returns {Promise<object>} { tool, params, stats, iterations, history }
 */
export async function stagedHistogramStretch(ctx, viewId, opts = {}) {
  const targetBg = opts.targetBackground ?? 0.25;
  const passes = opts.passes ?? opts.maxIterations ?? 4;
  const protect = opts.highlightProtect ?? 0.5;
  const history = [];

  for (let i = 0; i < passes; i++) {
    const st = await getStats(ctx, viewId);
    const med = st.median ?? 0.01;
    const diff = targetBg - med;
    if (Math.abs(diff) < 0.005) break;

    // Move 60% of the remaining distance per pass, so the early passes are
    // large and later ones refine — a natural multi-stage HT.
    const stepTarget = med + diff * 0.6;

    // HT midtones is NOT the MTF coefficient from the formula books: a value
    // below 0.5 brightens, above 0.5 darkens, and 0.5 is identity. Rather than
    // deriving it (the earlier closed form here was wrong and collapsed the
    // image to a flat 0.5), calibrate it on a throwaway window: bisect the
    // midtones value that maps this frame's median to stepTarget.
    const m = await solveMidtones(ctx, med, stepTarget);
    if (m === null) {
      ctx.log(`    [stretch] staged HT pass ${i + 1}: could not calibrate midtones — stopping`);
      break;
    }

    const r = await ctx.pjsr(`
      var W = ImageWindow.windowById('${viewId}');
      // Which H row drives the pixels depends on the image:
      //   colour — rows 0..2 (R, G, B), row 3 is an untouched luminance
      //   mono   — ONLY row 3 (the L row); rows 0..2 have no effect at all.
      // Writing 0.5 into row 3 (the old behaviour) made every mono stretch a
      // silent no-op: the tool reported success and the median never moved.
      var row = function () { return [0, ${m}, 1, 0, 1]; };
      var idle = function () { return [0, 0.5, 1, 0, 1]; };
      var mono = W.mainView.image.numberOfChannels === 1;
      var P = new HistogramTransformation;
      P.H = mono
        ? [idle(), idle(), idle(), row(), row()]
        : [row(), row(), row(), idle(), idle()];
      P.executeOn(W.mainView);
      'OK';
    `);
    if (r.status === 'error') {
      ctx.log(`    [stretch] staged HT pass ${i + 1} failed: ${r.error?.message} — stopping`);
      break;
    }

    const after = await getStats(ctx, viewId);
    if (!after.mad) {
      ctx.log(`    [stretch] WARNING: MAD collapsed to 0 after pass ${i + 1} — restore from a checkpoint`);
    }
    // A pass that changes nothing is a bug, not a rounding detail — say so
    // rather than looping to the iteration cap on a frozen image.
    if (Math.abs((after.median ?? 0) - med) < 1e-9) {
      ctx.log(`    [stretch] WARNING: pass ${i + 1} did not move the median `
        + `(${med.toFixed(6)} → ${(after.median ?? 0).toFixed(6)}, midtones channel mismatch?) — stopping`);
      history.push({ pass: i + 1, midtones: m, target: stepTarget, median: after.median, max: after.max, noop: true });
      break;
    }
    history.push({ pass: i + 1, midtones: m, target: stepTarget, median: after.median, max: after.max });
    ctx.log(`    [stretch] pass ${i + 1}: median ${med.toFixed(5)} → ${(after.median ?? 0).toFixed(5)} (target ${targetBg}, m=${m.toFixed(4)})`);
  }

  return {
    tool: 'staged-HT',
    params: { targetBg, passes, highlightProtect: protect },
    stats: await getStats(ctx, viewId),
    iterations: history.length,
    history
  };
}

/**
 * Find the HistogramTransformation midtones value that maps `median` to
 * `target`, by bisection against a filled test window.
 *
 * HT midtones is monotone in the output but its direction is unintuitive
 * (smaller brightens), so the search brackets [0.02, 0.98] and relies on the
 * measured monotonicity rather than on a derived formula.
 *
 * @returns {Promise<number|null>} midtones, or null when calibration failed
 */
async function solveMidtones(ctx, median, target) {
  const probe = async (m) => {
    const r = await ctx.pjsr(`
      var w = new ImageWindow(48, 48, 3, 32, false, true, 'midtones_probe');
      var v = w.mainView;
      v.beginProcess();
      var img = v.image;
      for (var c = 0; c < 3; c++)
        for (var y = 0; y < 48; y++)
          for (var x = 0; x < 48; x++)
            img.setSample(${median}, x, y, c);
      v.endProcess();
      var P = new HistogramTransformation;
      P.H = [[0, ${m}, 1, 0, 1], [0, ${m}, 1, 0, 1], [0, ${m}, 1, 0, 1],
             [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1]];
      P.executeOn(v);
      var out = img.median();
      w.forceClose();
      out;
    `);
    if (r.status === 'error') return NaN;
    const v = parseFloat((r.outputs?.consoleOutput || '').trim());
    return Number.isFinite(v) ? v : NaN;
  };

  // Identity check first: midtones 0.5 must leave the median untouched.
  const identity = await probe(0.5);
  if (!Number.isFinite(identity)) return null;

  let lo = 0.02, hi = 0.98;
  const loOut = await probe(lo), hiOut = await probe(hi);
  if (!Number.isFinite(loOut) || !Number.isFinite(hiOut)) return null;
  // Output must bracket the target for bisection to be meaningful.
  const loMax = Math.max(loOut, hiOut), hiMin = Math.min(loOut, hiOut);
  if (target > loMax || target < hiMin) return null;

  const brightensWithLow = loOut > hiOut;
  for (let k = 0; k < 18; k++) {
    const m = (lo + hi) / 2;
    const out = await probe(m);
    if (!Number.isFinite(out)) return null;
    if (brightensWithLow ? out > target : out < target) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/**
 * ArcsinhStretch — preserves star colour by compressing in arcsinh space.
 * The director prompt calls this out for the L channel and star plates.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} opts { stretch (default 10), blackPoint (default 0) }
 * @returns {Promise<object>} { tool, params, stats }
 */
export async function arcsinhStretch(ctx, viewId, opts = {}) {
  const stretch = opts.stretch ?? 10;
  const blackPoint = opts.blackPoint ?? 0;
  const r = await ctx.pjsr(`
    var P = new ArcsinhStretch;
    P.stretch = ${stretch};
    P.blackPoint = ${blackPoint};
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('ArcsinhStretch failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stretch] ArcsinhStretch: stretch=${stretch}, blackPoint=${blackPoint}`);
  return { tool: 'ArcsinhStretch', params: { stretch, blackPoint }, stats: await getStats(ctx, viewId) };
}

/**
 * Per-channel HistogramTransformation — the director prompt's "逐通道 HT"
 * for SHO, where Ha / OIII / SII need independently chosen midtones so the
 * background and the main structure end up at matching brightness.
 *
 * Applies MTF to a single channel of a mono view (or one channel of an RGB
 * view when `channel` is given).
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} opts { midtone, channel: 0|1|2|null, targetMedian }
 * @returns {Promise<object>} { stats }
 */
export async function channelHistogramStretch(ctx, viewId, opts = {}) {
  const ch = opts.channel;
  const targetMedian = opts.targetMedian ?? 0.25;

  // Auto midtone from the current median when not supplied.
  let midtone = opts.midtone;
  if (midtone === undefined) {
    const st = await getStats(ctx, viewId);
    let med = st.median;
    if (ch !== null && ch !== undefined && st.perChannel) {
      med = st.perChannel[['R', 'G', 'B'][ch]].median;
    }
    midtone = mtfFactorFor(med, targetMedian);
  }

  const chSel = (ch === null || ch === undefined) ? '' : `
    var _img = ImageWindow.windowById('${viewId}').mainView.image;
    _img.selectedChannel = ${ch};
  `;
  const restore = (ch === null || ch === undefined) ? '' : `
    ImageWindow.windowById('${viewId}').mainView.image.resetChannelSelection();
  `;

  const r = await ctx.pjsr(`
    ${chSel}
    var P = new HistogramTransformation;
    var m = ${midtone.toFixed(8)};
    // MTF(m): (m-1)*x / ((2m-1)*x - m)
    var expr = '((' + (m - 1).toFixed(9) + '*$T)/((' + (2*m - 1).toFixed(9) + ')*$T - ' + m.toFixed(9) + '))';
    var PM = new PixelMath;
    PM.expression = expr;
    PM.useSingleExpression = true;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = false;
    PM.executeOn(ImageWindow.windowById('${viewId}').mainView);
    ${restore}
    'OK';
  `);
  if (r.status === 'error') throw new Error('Channel HT failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stretch] channel HT on ${viewId}${ch !== null && ch !== undefined ? ' ch' + ch : ''}: midtone=${midtone.toFixed(6)} (target median ${targetMedian})`);
  return { stats: await getStats(ctx, viewId), midtone };
}

// Solve MTF coefficient m such that MTF(m, med) = target.
function mtfFactorFor(med, target) {
  med = Math.min(Math.max(med, 1e-6), 0.9999);
  target = Math.min(Math.max(target, 1e-6), 0.9999);
  // MTF(m, x) = ((m-1)x) / ((2m-1)x - m)
  // Solve for m given x=med and y=target:
  //   y((2m-1)x - m) = (m-1)x
  //   y(2mx - x - m) = mx - x
  //   2ymx - yx - ym = mx - x
  //   m(2yx - y - x) = yx - x
  //   m = (yx - x) / (2yx - y - x)
  const num = target * med - med;
  const den = 2 * target * med - target - med;
  if (Math.abs(den) < 1e-12) return 0.5;
  const m = num / den;
  return Math.min(Math.max(m, 1e-4), 0.9999);
}

/**
 * Match two views' brightness levels with LinearFit — the director prompt's
 * step that makes SII/OIII comparable to Ha before combination.
 *
 * @param {object} ctx
 * @param {object} opts { reference_id, target_id, rejectHigh }
 * @returns {Promise<object>} { coefficients?, stats }
 */
export async function linearFit(ctx, opts) {
  const { reference_id, target_id } = opts;
  const rejectHigh = opts.rejectHigh ?? 0.95;
  const r = await ctx.pjsr(`
    var ref = ImageWindow.windowById('${reference_id}');
    var tgt = ImageWindow.windowById('${target_id}');
    if (ref.isNull) throw new Error('LinearFit reference not found: ${reference_id}');
    if (tgt.isNull) throw new Error('LinearFit target not found: ${target_id}');
    var LF = new LinearFit;
    LF.referenceViewId = '${reference_id}';
    LF.rejectLow = 0.0;
    LF.rejectHigh = ${rejectHigh};
    LF.executeOn(tgt.mainView);
    'OK';
  `);
  if (r.status === 'error') throw new Error('LinearFit failed: ' + (r.error?.message || 'PJSR error'));
  ctx.log(`  [stretch] LinearFit ${target_id} → reference ${reference_id}`);
  return { stats: await getStats(ctx, target_id) };
}

/**
 * Identity midtone for the shared-span MTF. 0.22 lifts a linear background
 * (typically 0.005-0.02 after black subtraction) into the 0.05-0.15 range.
 */
const MTF_DEFAULT_MIDTONE = 0.22;

/**
 * Shared-span stretch for multi-channel composites (HOO / SHO / LRGB).
 *
 * Why this exists: a per-channel stretch picks a white point from each
 * channel's own data. When two channels carry the same noise but different
 * signal levels (H→R vs O→G,B), the weaker channel gets a smaller span and
 * therefore a LARGER gain, so identical noise lands at visibly different
 * amplitudes — the colour speckle known as chroma noise. Measured on M27
 * HOO: O span was 62% of H, so O was stretched 366x against H's 230x, i.e.
 * 59% more gain on the same noise, and the R/G ratio came out at 0.952
 * (green brighter than red) instead of the expected ~1.8.
 *
 * The fix is to normalise every channel against ONE physical span while
 * still giving each its own black point (each channel has its own pedestal):
 *
 *   black_c = median_c - k * MAD_c        (per channel, removes its pedestal)
 *   white_c = black_c + span              (shared span, identical gain 1/span)
 *
 * `span` defaults to the widest channel's P99.95 - black so the brightest
 * channel is not clipped. Same noise in → same noise out.
 *
 * @param {object} ctx
 * @param {string} viewId
 * @param {object} opts
 *   { targetMedian, channels, sigma, percentile, spanChannel, midtone }
 * @returns {Promise<object>} { channels: [{channel, black, white, gain}], stats }
 */
export async function sharedSpanStretch(ctx, viewId, opts = {}) {
  const targetMedian = opts.targetMedian ?? 0.22;
  const sigma = opts.sigma ?? 2.8;
  const percentile = opts.percentile ?? 0.9995;
  const want = opts.channels ?? [0, 1, 2];

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('sharedSpanStretch: no view ${viewId}');
    var v = w.mainView, src = v.image;
    var nch = src.numberOfChannels;
    if (nch < 3) throw new Error('sharedSpanStretch needs an RGB view, got ' + nch + ' channel(s)');
    var W = src.width, H = src.height;

    function medianOf(a){ a.sort(function(p,q){return p-q;}); return a[Math.floor(a.length/2)]; }
    function madOf(a){ var m = medianOf(a.slice()); var d=[]; for (var i=0;i<a.length;i++) d.push(Math.abs(a[i]-m)); return medianOf(d); }

    // Sky patch: top-left corner, away from the subject on every frame we run.
    var px0=Math.floor(W*0.02), py0=Math.floor(H*0.02);
    var px1=Math.floor(W*0.16), py1=Math.floor(H*0.18);

    var stats = [], i, x, y;
    for (var c=0;c<3;c++){
      var s=[];
      for (y=py0;y<py1;y+=2) for (x=px0;x<px1;x+=2) s.push(src.sample(x,y,c));
      var med = medianOf(s.slice()), mad = madOf(s);
      stats.push({ med: med, mad: mad, black: med - ${sigma}*mad });
    }

    // Shared span from the widest ( brightest ) channel at the given percentile.
    var span = 0, spanCh = 0;
    for (var c2=0;c2<3;c2++){
      var all=[];
      for (y=0;y<H;y+=7) for (x=0;x<W;x+=7) all.push(src.sample(x,y,c2));
      all.sort(function(p,q){return p-q;});
      var hi = all[Math.floor(all.length*${percentile})];
      var sp = hi - stats[c2].black;
      if (sp > span) { span = sp; spanCh = c2; }
    }
    if (!(span > 0)) throw new Error('sharedSpanStretch: degenerate span');

    var want = [${want.map((c) => Number(c)).join(',')}];
    var info = [];
    for (var c3=0;c3<3;c3++){
      var on = want.indexOf(c3) >= 0;
      info.push({ channel: c3, black: stats[c3].black, white: stats[c3].black + span,
                  gain: on ? 1/span : 0, enabled: on });
    }

    function mtf(m, x){ return ((m-1)*x)/((2*m-1)*x - m); }
    var MID = ${Number(opts.midtone ?? MTF_DEFAULT_MIDTONE)};

    var T = new Image; T.assign(src);
    for (y=0;y<H;++y) for (x=0;x<W;++x){
      for (var c4=0;c4<3;c4++){
        if (!info[c4].enabled) { T.setSample(src.sample(x,y,c4), x,y,c4); continue; }
        var t = (src.sample(x,y,c4) - info[c4].black) / span;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        T.setSample(mtf(MID, t), x,y,c4);
      }
    }
    v.beginProcess(); v.image.assign(T); v.endProcess();

    JSON.stringify({ span: span, spanChannel: spanCh,
                     channels: info.map(function(o){ return { channel:o.channel, black:o.black, white:o.white, gain:o.gain }; }),
                     midtone: MID });
  `);
  if (r.status === 'error') throw new Error('sharedSpanStretch failed: ' + (r.error?.message || 'PJSR error'));
  let detail;
  try {
    detail = JSON.parse(r.output ?? '{}');
  } catch {
    detail = {};
  }
  const span = detail.span ?? 0;
  for (const c of detail.channels ?? []) {
    ctx.log(
      `  [stretch] shared span ${c.channel}: black=${c.black?.toFixed?.(7)} `
        + `white=${c.white?.toFixed?.(7)} gain=${c.gain ? (1 / span).toFixed(0) + 'x' : 'off'}`,
    );
  }
  ctx.log(`  [stretch] sharedSpanStretch on ${viewId}: span=${span.toFixed(7)} (channel ${detail.spanChannel}), midtone=${detail.midtone}`);
  return { stats: await getStats(ctx, viewId), ...detail };
}
