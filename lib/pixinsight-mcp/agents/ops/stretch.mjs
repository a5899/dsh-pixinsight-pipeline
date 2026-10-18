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
    // MTF coefficient that maps med -> stepTarget.
    const a = (1 - stepTarget) / (1 - med + 1e-9);
    const b = stepTarget / (med + 1e-9);
    const slope = 0.9 + 0.1 * (1 - protect);
    let mtf = `((${(b - 1).toFixed(9)}*$T)/((${(a + b - 2).toFixed(9)})*$T - ${(a - 1).toFixed(9)}))`;
    // Note: PixInsight MTF(m): (m-1)*x / ((2m-1)*x - m)
    void slope;

    const r = await ctx.pjsr(`
      var P = new PixelMath;
      P.expression = "${mtf}";
      P.useSingleExpression = true;
      P.use64BitWorkingImage = true;
      P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      'OK';
    `);
    if (r.status === 'error') {
      ctx.log(`    [stretch] staged HT pass ${i + 1} failed: ${r.error?.message} — stopping`);
      break;
    }

    // Highlight rolloff: compress the top of the range so the core does not
    // immediately plateau at 1.0.
    if (protect > 0) {
      const roll = 0.92;
      const rr = await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "iif($T > ${roll}, ${roll} + (${(1 - roll).toFixed(6)})*($T - ${roll})/(1.0001 - ${roll})*(1-${(protect * 0.5).toFixed(3)}), $T)";
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
        'OK';
      `);
      if (rr.status === 'error') ctx.log(`    [stretch] highlight rolloff skipped: ${rr.error?.message}`);
    }

    const after = await getStats(ctx, viewId);
    history.push({ pass: i + 1, target: stepTarget, median: after.median, max: after.max });
    ctx.log(`    [stretch] pass ${i + 1}: median ${med.toFixed(5)} → ${(after.median ?? 0).toFixed(5)} (target ${targetBg})`);
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
