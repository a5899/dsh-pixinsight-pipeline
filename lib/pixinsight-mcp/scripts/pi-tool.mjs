#!/usr/bin/env node
// ============================================================================
// CLI wrapper for calling PixInsight agent tools from bash.
// Usage: node scripts/pi-tool.mjs <toolName> [JSON args]
//
// Examples:
//   node scripts/pi-tool.mjs get_image_stats '{"view_id":"M81"}'
//   node scripts/pi-tool.mjs list_open_images '{}'
//   node scripts/pi-tool.mjs run_lhe '{"view_id":"FILTER_L","radius":128,"amount":0.35}'
//   node scripts/pi-tool.mjs pjsr '{"code":"var w=ImageWindow.windowById(\"M81\");w.mainView.image.median();"}'
// ============================================================================
import { createBridgeContext } from '../agents/ops/bridge.mjs';
import {
  getStats, measureUniformity, computeSTF, acceptanceCheck
} from '../agents/ops/stats.mjs';
import { savePreview } from '../agents/ops/preview.mjs';
import { createLumMask, applyMask, removeMask, closeMask } from '../agents/ops/masks.mjs';
import {
  setiStretch, ghsStretch, masStretch, stagedHistogramStretch, arcsinhStretch,
  channelHistogramStretch, linearFit
} from '../agents/ops/stretch.mjs';
import { cloneImage, restoreFromClone, closeImage, purgeUndoHistory } from '../agents/ops/image-mgmt.mjs';
import { checkStarQuality, checkRinging, checkSharpness } from '../agents/ops/quality-gates.mjs';
import { detectTools, resolveTool, capabilityReport, hasTool } from '../agents/ops/tooling.mjs';
import {
  combineSho, dynamicBlend, extractCleanHa, injectHa as injectHaNarrowband, searchCleanHaQ,
  searchInjectionB, mixOiii, extractChannel
} from '../agents/ops/narrowband.mjs';
import {
  separateStars, fixStarColor, removeGreen, shrinkStars, recombineStars, denoiseChroma
} from '../agents/ops/star-handling.mjs';
import { measureNoise, planDenoise, applyDenoise, autoDenoise } from '../agents/ops/denoise-policy.mjs';
import { starAlign, dynamicCrop, imageIntegration, checkRegistration } from '../agents/ops/preprocess.mjs';
import {
  gradientCorrect, gradientCorrectChannels, backgroundNeutralize, measureBackground
} from '../agents/ops/background.mjs';
import {
  workspaceDir, workspaceRoot, workspaceStatus, saveWorkspaceConfig,
  interpretWorkspaceChoice, DEFAULT_WORKSPACE, CONFIG_PATH
} from '../agents/ops/workspace.mjs';
import {
  darkStructureEnhance, rangeMask, maskedSaturation
} from '../agents/ops/structure.mjs';
import {
  oiiiSynthesis, integrateOiii, estimateContinuumQ, haCleanRefine,
  injectHa as injectHaRGB, channelWeightBlend
} from '../agents/ops/color-mix.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ctx = createBridgeContext({ log: (msg) => process.stderr.write(`[pi] ${msg}\n`) });

const toolName = process.argv[2];
let argsJson = process.argv[3] || '{}';

// Support "@<path>" — read the JSON args from a file. This avoids shell quoting
// / double-quote mangling when the agent calls pi-tool from PowerShell or a
// wrapper (a DSH/Windows robustness improvement).
if (argsJson.startsWith('@')) {
  argsJson = fs.readFileSync(argsJson.slice(1), 'utf-8');
}

if (!toolName) {
  console.error('Usage: node scripts/pi-tool.mjs <toolName> [JSON args | @args.json]');
  process.exit(1);
}

let args;
try { args = JSON.parse(argsJson); } catch (e) {
  console.error('Invalid JSON args:', e.message);
  process.exit(1);
}

// Working directory for every process artefact (previews, variants, run logs).
// Resolved once per invocation from config, env or the default; see
// agents/ops/workspace.mjs. Nothing is created until a command needs it.
const VARIANT_DIR = workspaceDir('variants');

async function run() {
  switch (toolName) {
    // --- Raw PJSR ---
    case 'pjsr': {
      const r = await ctx.pjsr(args.code);
      console.log(JSON.stringify(r));
      break;
    }

    // --- Measurement ---
    case 'get_image_stats': {
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify(stats, null, 2));
      break;
    }
    case 'get_fits_keywords': {
      const r = await ctx.pjsr(`
        var w = ImageWindow.windowById('${args.view_id}');
        if (w.isNull) throw new Error('View not found: ${args.view_id}');
        var ks = w.keywords ? w.keywords : [];
        var out = [];
        for (var i = 0; i < ks.length; i++) out.push(ks[i].name + '=' + ks[i].value);
        JSON.stringify({ view_id: '${args.view_id}', count: out.length, keywords: out });
      `);
      console.log(r.outputs?.consoleOutput || JSON.stringify({ ok: false, error: r.error?.message }));
      break;
    }
    case 'measure_uniformity': {
      const uni = await measureUniformity(ctx, args.view_id, args.sample_size || 200);
      console.log(JSON.stringify(uni, null, 2));
      break;
    }
    case 'list_open_images': {
      const imgs = await ctx.listImages();
      console.log(JSON.stringify(imgs, null, 2));
      break;
    }

    // --- Image management ---
    case 'clone_image': {
      await cloneImage(ctx, args.source_id, args.clone_id);
      console.log(JSON.stringify({ ok: true, msg: `Cloned ${args.source_id} → ${args.clone_id}` }));
      break;
    }
    case 'restore_from_clone': {
      await restoreFromClone(ctx, args.target_id, args.clone_id);
      console.log(JSON.stringify({ ok: true, msg: `Restored ${args.target_id} from ${args.clone_id}` }));
      break;
    }
    case 'close_image': {
      await closeImage(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, msg: `Closed ${args.view_id}` }));
      break;
    }
    case 'purge_undo': {
      await purgeUndoHistory(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true }));
      break;
    }

    // --- Masks ---
    case 'create_luminance_mask': {
      const result = await createLumMask(ctx, args.source_id, args.mask_id,
        args.blur ?? 5, args.clip_low ?? 0.10, args.gamma ?? 1.0);
      console.log(JSON.stringify({ ok: true, mask_id: result }));
      break;
    }
    case 'apply_mask': {
      await applyMask(ctx, args.target_id, args.mask_id, args.inverted || false);
      console.log(JSON.stringify({ ok: true }));
      break;
    }
    case 'remove_mask': {
      await removeMask(ctx, args.target_id);
      console.log(JSON.stringify({ ok: true }));
      break;
    }
    case 'close_mask': {
      await closeMask(ctx, args.mask_id);
      console.log(JSON.stringify({ ok: true }));
      break;
    }

    // --- LHE ---
    case 'run_lhe': {
      await ctx.pjsr(`
        var P = new LocalHistogramEqualization;
        P.radius = ${args.radius};
        P.slopeLimit = ${args.slope_limit ?? 1.5};
        P.amount = ${args.amount};
        P.circularKernel = true;
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- HDRMT ---
    case 'run_hdrmt': {
      const inverted = args.inverted ? 'true' : 'false';
      const toLightness = (args.to_lightness !== false) ? 'true' : 'false';
      const preserveHue = (args.preserve_hue !== false) ? 'true' : 'false';
      await ctx.pjsr(`
        var P = new HDRMultiscaleTransform;
        P.numberOfLayers = ${args.layers};
        P.numberOfIterations = ${args.iterations ?? 1};
        P.invertedIterations = ${inverted};
        P.overdrive = 0;
        P.medianTransform = false;
        P.scalingFunctionData = [
          0.003906,0.015625,0.023438,0.015625,0.003906,
          0.015625,0.0625,0.09375,0.0625,0.015625,
          0.023438,0.09375,0.140625,0.09375,0.023438,
          0.015625,0.0625,0.09375,0.0625,0.015625,
          0.003906,0.015625,0.023438,0.015625,0.003906
        ];
        P.scalingFunctionRowFilter = [0.0625,0.25,0.375,0.25,0.0625];
        P.scalingFunctionColFilter = [0.0625,0.25,0.375,0.25,0.0625];
        P.scalingFunctionNoiseLayers = 1;
        P.scalingFunctionName = "B3 Spline (5)";
        P.deringing = true;
        P.smallScaleDeringing = 0.000;
        P.largeScaleDeringing = 0.500;
        P.outputDeringingMaps = false;
        P.toLightness = ${toLightness};
        P.preserveHue = ${preserveHue};
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- NXT (with native fallback) ---
    case 'run_nxt': {
      const res = await resolveTool(ctx, 'denoise');
      if (!res.tool) {
        console.log(JSON.stringify({ ok: false, error: 'No denoise tool available (tried NXT, TGVDenoise)' }));
        process.exitCode = 1;
        break;
      }
      if (res.tool === 'NoiseXTerminator') {
        await ctx.pjsr(`
          var P = new NoiseXTerminator;
          P.denoise = ${args.denoise};
          P.detail = ${args.detail ?? 0.15};
          P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
        `);
      } else {
        // TGVDenoise accepts a NXT-scaled strength; 0..1 maps to 0..5.
        const tgv = (Number(args.denoise ?? 0.5) * 5.0).toFixed(3);
        await ctx.pjsr(`
          var P = new TGVDenoise;
          P.strength = ${tgv};
          P.edgeProtection = ${(0.2 + (args.detail ?? 0.15) * 2).toFixed(3)};
          P.smoothness = 2;
          P.iterations = 250;
          P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
        `);
        ctx.log(`  [nxt] NXT absent → TGVDenoise strength=${tgv} (native fallback)`);
      }
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, tool: res.tool, native: res.native, stats }));
      break;
    }

    // --- BXT / deconvolution (with native fallback) ---
    case 'run_bxt': {
      const res = await resolveTool(ctx, 'sharpen');
      if (!res.tool) {
        console.log(JSON.stringify({ ok: false, error: 'No sharpen tool available (tried BXT, Deconvolution)' }));
        process.exitCode = 1;
        break;
      }
      if (res.tool === 'BlurXTerminator') {
        const correctOnly = args.correct_only ? 'true' : 'false';
        const autoPsi = args.auto_psf !== false ? 'true' : 'false';
        await ctx.pjsr(`
          var P = new BlurXTerminator;
          P.correctOnly = ${correctOnly};
          P.sharpening = ${args.non_stellar ?? 0.5};
          P.starAdjust = ${args.stellar ?? 0.0};
          P.autoPSF = ${autoPsi};
          ${args.psf_fwhm ? `P.psfFwhm = ${args.psf_fwhm};` : ''}
          P.adjustHalos = ${args.adjust_halos ?? 0.0};
          P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
        `);
      } else {
        // Native Deconvolution needs a PSF; build one from the brightest star.
        const fwhm = args.psf_fwhm ?? 3.5;
        await ctx.pjsr(`
          var P = new Deconvolution;
          P.algorithm = Deconvolution.prototype.RichardsonLucy;
          P.numberOfIterations = ${args.iterations ?? 25};
          P.psfMode = Deconvolution.prototype.Parametric;
          P.psfSigma = ${(fwhm / 2.3548).toFixed(4)};
          P.psfShape = 2;
          P.protectDarkLimits = true; P.protectDark = 0.0008;
          P.protectBrightLimits = true; P.protectBright = 0.95;
          P.dwaveLayers = 2; P.dwaveNoiseThreshold = 0.0005;
          P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
        `);
        ctx.log(`  [bxt] BXT absent → Deconvolution (RL, fwhm=${fwhm}) — watch for ringing`);
      }
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, tool: res.tool, native: res.native, stats }));
      break;
    }

    // --- Curves ---
    case 'run_curves': {
      const channelProp = { R: 'R', G: 'G', B: 'B', RGB: 'K', L: 'L', S: 'S' };
      const prop = channelProp[args.channel] || 'K';
      const pts = args.points.map(p => `[${p[0]},${p[1]}]`).join(',');
      await ctx.pjsr(`
        var P = new CurvesTransformation;
        P.${prop} = [${pts}];
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- PixelMath ---
    case 'run_pixelmath': {
      const useSingle = (args.single_expression !== false) ? 'true' : 'false';
      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${args.expression.replace(/"/g, '\\"')}";
        P.useSingleExpression = ${useSingle};
        ${args.symbols ? `P.symbols = "${args.symbols}";` : ''}
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- PixelMath with per-channel expressions ---
    case 'run_pixelmath_rgb': {
      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${args.expression_r.replace(/"/g, '\\"')}";
        P.expression1 = "${args.expression_g.replace(/"/g, '\\"')}";
        P.expression2 = "${args.expression_b.replace(/"/g, '\\"')}";
        P.useSingleExpression = false;
        ${args.symbols ? `P.symbols = "${args.symbols}";` : ''}
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Star screen blend ---
    case 'star_screen_blend': {
      const str = args.strength ?? 0.85;
      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "~(~${args.target_id} * ~(${args.stars_id} * ${str}))";
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${args.target_id}').mainView);
      `);
      const stats = await getStats(ctx, args.target_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Star stretch ---
    case 'stretch_stars': {
      const midtone = args.midtone ?? 0.20;
      const iterations = args.iterations ?? 5;
      const r = await ctx.pjsr(`
        var w = ImageWindow.windowById('${args.view_id}');
        if (w.isNull) throw new Error('View not found: ${args.view_id}');
        var v = w.mainView;
        var med = v.image.median();
        if (med > 0.00001) {
          var P = new PixelMath;
          P.expression = 'max(0, ($T - ' + med + ') / (1 - ' + med + '))';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(v);
        }
        var m = ${midtone};
        var a = (1 - m).toFixed(6);
        var b = (1 - 2*m).toFixed(6);
        var mtfExpr = '(' + a + '*$T)/((' + b + ')*$T+' + m.toFixed(6) + ')';
        for (var i = 0; i < ${iterations}; i++) {
          var P2 = new PixelMath;
          P2.expression = mtfExpr;
          P2.useSingleExpression = true;
          P2.createNewImage = false;
          P2.use64BitWorkingImage = true;
          P2.truncate = true; P2.truncateLower = 0; P2.truncateUpper = 1;
          P2.executeOn(v);
          processEvents();
        }
        var finalMed = v.image.median();
        var finalMax = v.image.maximum();
        JSON.stringify({ bgClip: med, midtone: m, iterations: ${iterations}, finalMedian: finalMed, finalMax: finalMax });
      `);
      console.log(JSON.stringify({ ok: true, result: r.outputs?.consoleOutput }));
      break;
    }

    // --- Seti stretch ---
    case 'seti_stretch': {
      const stats = await setiStretch(ctx, args.view_id, {
        targetMedian: args.target_median ?? 0.25,
        hdrCompress: args.hdr_compress ?? true,
        hdrAmount: args.hdr_amount ?? 0.25,
        hdrKnee: 0.35,
        hdrHeadroom: args.hdr_headroom ?? 0.05
      });
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- LRGB combine ---
    case 'lrgb_combine': {
      const lightness = args.lightness ?? 0.55;
      const saturation = args.saturation ?? 0.80;
      const tgt = args.rgb_id;
      // Step 1: LinearFit L to RGB luminance
      await ctx.pjsr(`
        var rgbW = ImageWindow.windowById('${args.rgb_id}');
        var lW = ImageWindow.windowById('${args.l_id}');
        if (rgbW.isNull) throw new Error('RGB not found: ${args.rgb_id}');
        if (lW.isNull) throw new Error('L not found: ${args.l_id}');
        var img = rgbW.mainView.image;
        var w = img.width, h = img.height;
        var lumRef = new ImageWindow(w, h, 1, 32, true, false, 'lrgb_lum_ref');
        lumRef.show();
        var PM = new PixelMath;
        PM.expression = '0.2126*${args.rgb_id}[0] + 0.7152*${args.rgb_id}[1] + 0.0722*${args.rgb_id}[2]';
        PM.useSingleExpression = true;
        PM.createNewImage = false;
        PM.executeOn(lumRef.mainView);
        var LF = new LinearFit;
        LF.referenceViewId = 'lrgb_lum_ref';
        LF.rejectHigh = 0.92;
        LF.executeOn(lW.mainView);
        lumRef.forceClose();
        'LinearFit done';
      `);
      // Step 2: Extract channels, clone L, run LRGBCombination
      await ctx.pjsr(`
        var CE = new ChannelExtraction;
        CE.channelEnabled = [true, true, true];
        CE.channelId = ['${tgt}_R', '${tgt}_G', '${tgt}_B'];
        CE.colorSpace = ChannelExtraction.prototype.RGB;
        CE.sampleFormat = ChannelExtraction.prototype.SameAsSource;
        CE.executeOn(ImageWindow.windowById('${tgt}').mainView);
      `);
      await ctx.pjsr(`
        var src = ImageWindow.windowById('${args.l_id}');
        var img = src.mainView.image;
        var dst = new ImageWindow(img.width, img.height, 1, 32, true, false, '${tgt}_L');
        dst.show();
        var PM = new PixelMath;
        PM.expression = '${args.l_id}';
        PM.useSingleExpression = true;
        PM.createNewImage = false;
        PM.executeOn(dst.mainView);
      `);
      const r = await ctx.pjsr(`
        var P = new LRGBCombination;
        P.channelL = [true, '${tgt}_L'];
        P.channelR = [true, '${tgt}_R'];
        P.channelG = [true, '${tgt}_G'];
        P.channelB = [true, '${tgt}_B'];
        P.lightness = ${lightness};
        P.saturation = ${saturation};
        P.noiseReduction = false;
        var ret = P.executeOn(ImageWindow.windowById('${tgt}').mainView);
        ret ? 'LRGB_OK' : 'LRGB_FAILED';
      `);
      // Cleanup
      await ctx.pjsr(`
        var ids = ['${tgt}_R','${tgt}_G','${tgt}_B','${tgt}_L'];
        for (var i = 0; i < ids.length; i++) {
          var w = ImageWindow.windowById(ids[i]);
          if (!w.isNull) w.forceClose();
        }
      `);
      const lrgbOut = r.outputs?.consoleOutput?.trim() || '';
      if (r.status === 'error' || lrgbOut.includes('LRGB_FAILED')) {
        // Fallback PixelMath
        await ctx.pjsr(`
          var PM = new PixelMath;
          PM.expression = "Yo = 0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]; Yb = (1-${lightness})*Yo + ${lightness}*${args.l_id}; ratio = min(max(Yb, 0.00001) / max(Yo, 0.00001), 3.0); $T * ratio";
          PM.symbols = "Yo, Yb, ratio";
          PM.useSingleExpression = true;
          PM.use64BitWorkingImage = true;
          PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
          PM.createNewImage = false;
          PM.executeOn(ImageWindow.windowById('${args.rgb_id}').mainView);
        `);
      }
      const stats = await getStats(ctx, args.rgb_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Ha injection ---
    case 'ha_inject_red': {
      const str = args.strength ?? 0.30;
      const limit = args.brightness_limit ?? 0.25;
      await ctx.pjsr(`
        var PM = new PixelMath;
        PM.expression = "iif(${args.ha_id} > ${args.target_id}[0] * (1 + ${limit}), ${args.target_id}[0] + ${str} * (${args.ha_id} - ${args.target_id}[0]), ${args.target_id}[0])";
        PM.expression1 = "${args.target_id}[1]";
        PM.expression2 = "${args.target_id}[2]";
        PM.useSingleExpression = false;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        PM.executeOn(ImageWindow.windowById('${args.target_id}').mainView);
      `);
      const stats = await getStats(ctx, args.target_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }
    case 'ha_inject_luminance': {
      const str = args.strength ?? 0.20;
      await ctx.pjsr(`
        var PM = new PixelMath;
        PM.expression = "$T + ${str} * max(${args.ha_id} - (0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]), 0) * $T / max(0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2], 0.00001)";
        PM.useSingleExpression = true;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        PM.executeOn(ImageWindow.windowById('${args.target_id}').mainView);
      `);
      const stats = await getStats(ctx, args.target_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Quality gates ---
    case 'check_star_quality': {
      const result = await checkStarQuality(ctx, args.view_id);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'check_ringing': {
      const result = await checkRinging(ctx, args.view_id);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'check_sharpness': {
      const result = await checkSharpness(ctx, args.view_id);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // --- Save preview ---
    case 'save_preview': {
      const previewDir = workspaceDir('previews');
      // Delegate to the shared helper so linear auto-stretch lives in one place.
      // Explicit is_linear wins; otherwise the helper infers from the label.
      await savePreview(ctx, args.view_id, args.label, {
        previewDir,
        isLinear: args.is_linear
      });
      const previewPath = path.join(previewDir, `${args.label}.jpg`);
      const saved = fs.existsSync(previewPath);
      console.log(JSON.stringify({ ok: saved, path: previewPath }));
      if (!saved) process.exitCode = 1;
      break;
    }

    // --- Save variant (XISF to disk) ---
    case 'save_variant': {
      const variantPath = path.join(VARIANT_DIR, `${args.name}.xisf`);
      await ctx.pjsr(`
        var w = ImageWindow.windowById('${args.view_id}');
        if (w.isNull) throw new Error('View not found: ${args.view_id}');
        var p = '${variantPath.replace(/'/g, "\\'")}';
        if (File.exists(p)) File.remove(p);
        w.saveAs(p, false, false, false, false);
        'OK';
      `);
      const stats = await getStats(ctx, args.view_id);
      // Save metadata
      const metaPath = path.join(VARIANT_DIR, `${args.name}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({ name: args.name, view_id: args.view_id, notes: args.notes || '', stats, timestamp: new Date().toISOString() }, null, 2));
      console.log(JSON.stringify({ ok: true, path: variantPath, stats }));
      break;
    }

    // --- Load variant ---
    case 'load_variant': {
      const variantPath = path.join(VARIANT_DIR, `${args.name}.xisf`);
      const targetId = args.target_id || args.name;
      const r = await ctx.pjsr(`
        var wins = ImageWindow.open('${variantPath.replace(/'/g, "\\'")}');
        if (!wins || wins.length === 0) throw new Error('Cannot open variant');
        var w = wins[0];
        w.mainView.id = '${targetId}';
        // Close crop masks
        var allW = ImageWindow.windows;
        for (var i = 0; i < allW.length; i++) {
          if (allW[i].mainView.id.indexOf('crop_mask') >= 0) allW[i].forceClose();
        }
        '${targetId}';
      `);
      console.log(JSON.stringify({ ok: true, view_id: targetId }));
      break;
    }

    // --- List variants ---
    case 'list_variants': {
      const files = fs.readdirSync(VARIANT_DIR).filter(f => f.endsWith('.json'));
      const variants = files.map(f => {
        const meta = JSON.parse(fs.readFileSync(path.join(VARIANT_DIR, f), 'utf-8'));
        return meta;
      });
      console.log(JSON.stringify(variants, null, 2));
      break;
    }

    // ========================================================================
    // --- Working directory (first-run onboarding) ---
    // ========================================================================
    case 'workspace_show': {
      const status = workspaceStatus();
      if (status.first_use) {
        // The agent must ask once before the first file lands somewhere the
        // user did not choose. Wording is mirrored in ONBOARDING.md.
        status.prompt = [
          'This is the first run: no working directory has been chosen yet.',
          `Default: ${DEFAULT_WORKSPACE}`,
          'Ask the user where previews and intermediate images should go, then run',
          '  workspace_set {"path":"<dir>"}          (their folder)',
          '  workspace_set {"path":"default"}        (keep the default)',
          'Processing continues in the default directory if they do not choose.'
        ].join('\n');
      }
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case 'workspace_set': {
      const choice = interpretWorkspaceChoice(args.path ?? args.dir ?? args.value);
      if (choice.action === 'ask') {
        console.log(JSON.stringify({
          ok: false, action: 'ask', prompt: 'Ask the user for a directory, or "default".',
          default_workspace: DEFAULT_WORKSPACE
        }, null, 2));
        process.exitCode = 2;
        break;
      }
      if (choice.action === 'default') {
        // "Default" is a choice like any other: forget a previous one and use
        // the fixed default location without writing a config file at all.
        if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
        const status = workspaceStatus();
        console.log(JSON.stringify({
          ok: true, action: 'default', workspace: status.workspace,
          config_path: null, writable: status.writable, subdirs: status.subdirs
        }, null, 2));
        break;
      }
      const saved = saveWorkspaceConfig(choice.path);
      const status = workspaceStatus();
      console.log(JSON.stringify({
        ok: true, action: 'set', ...saved, writable: status.writable,
        first_use: status.first_use, subdirs: status.subdirs
      }, null, 2));
      break;
    }

    // ========================================================================
    // --- Tooling / capability detection ---
    // ========================================================================
    case 'detect_tools': {
      const availability = await detectTools(ctx, { force: args.force === true });
      console.log(JSON.stringify({ ok: true, availability }, null, 2));
      break;
    }
    case 'capability_report': {
      const rep = await capabilityReport(ctx, { force: args.force === true });
      console.log(JSON.stringify({ ok: true, suite: rep.suite, report: rep.report }, null, 2));
      break;
    }
    case 'resolve_tool': {
      const res = await resolveTool(ctx, args.group, { force: args.force === true });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'has_tool': {
      const present = await hasTool(ctx, args.name);
      console.log(JSON.stringify({ ok: true, name: args.name, present }));
      break;
    }

    // ========================================================================
    // --- STF / acceptance ---
    // ========================================================================
    case 'compute_stf': {
      const stf = await computeSTF(ctx, args.view_id, {
        targetBackground: args.target_background ?? 0.25,
        shadowClip: args.shadow_clip ?? -2.8
      });
      console.log(JSON.stringify(stf, null, 2));
      break;
    }
    case 'acceptance_check': {
      const result = await acceptanceCheck(ctx, args.view_id, {
        stage: args.stage,
        phase: args.phase,
        maxChannelSpread: args.max_channel_spread,
        burnThreshold: args.burn_threshold,
        clipThreshold: args.clip_threshold
      });
      console.log(JSON.stringify(result, null, 2));
      // Non-zero exit in strict mode so a calling script can gate on it.
      if (args.strict && !result.pass) process.exitCode = 2;
      break;
    }

    // ========================================================================
    // --- Stretch family ---
    // ========================================================================
    case 'ghs_stretch': {
      const out = await ghsStretch(ctx, args.view_id, {
        D: args.D ?? 0.5,
        b: args.b ?? 0.0,
        SP: args.SP ?? 0.0,
        LP: args.LP ?? 0.0,
        HP: args.HP ?? 1.0,
        useNative: args.use_native === true,
        colorSpace: args.color_space
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'mas_stretch': {
      const out = await masStretch(ctx, args.view_id, {
        targetBackground: args.target_background ?? 0.25,
        shadowLift: args.shadow_lift ?? 0.5,
        highlightProtect: args.highlight_protect ?? 0.5,
        maxIterations: args.max_iterations ?? 4
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'staged_ht_stretch': {
      const out = await stagedHistogramStretch(ctx, args.view_id, {
        targetBackground: args.target_background ?? 0.25,
        passes: args.passes ?? 4,
        highlightProtect: args.highlight_protect ?? 0.5
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'arcsinh_stretch': {
      const out = await arcsinhStretch(ctx, args.view_id, {
        stretch: args.stretch ?? 10,
        blackPoint: args.black_point ?? 0
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'channel_ht_stretch': {
      const out = await channelHistogramStretch(ctx, args.view_id, {
        midtone: args.midtone,
        channel: args.channel === undefined ? null : args.channel,
        targetMedian: args.target_median ?? 0.25
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'linear_fit': {
      const out = await linearFit(ctx, {
        reference_id: args.reference_id,
        target_id: args.target_id,
        rejectHigh: args.reject_high ?? 0.95
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }

    // ========================================================================
    // --- Narrowband ---
    // ========================================================================
    case 'combine_sho': {
      const id = await combineSho(ctx, {
        sii_id: args.sii_id, ha_id: args.ha_id, oiii_id: args.oiii_id,
        target_id: args.target_id
      });
      const stats = await getStats(ctx, id);
      console.log(JSON.stringify({ ok: true, view_id: id, stats }));
      break;
    }
    case 'dynamic_blend': {
      const out = await dynamicBlend(ctx, {
        rgb_id: args.rgb_id,
        sii_id: args.sii_id, ha_id: args.ha_id, oiii_id: args.oiii_id,
        weights: args.weights
      });
      console.log(JSON.stringify(out));
      break;
    }
    case 'extract_clean_ha': {
      const out = await extractCleanHa(ctx, {
        ha_id: args.ha_id, red_id: args.red_id,
        out_id: args.out_id, q: args.q
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'search_clean_ha_q': {
      const out = await searchCleanHaQ(ctx, {
        ha_id: args.ha_id, red_id: args.red_id,
        candidates: args.candidates, sampleStep: args.sample_step
      });
      console.log(JSON.stringify({ ok: true, ...out }, null, 2));
      break;
    }
    case 'inject_ha': {
      const stats = await injectHaNarrowband(ctx, {
        target_id: args.target_id, ha_clean_id: args.ha_clean_id,
        b: args.b, blueRatio: args.blue_ratio, mode: args.mode
      });
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }
    case 'search_injection_b': {
      const out = await searchInjectionB(ctx, {
        target_id: args.target_id, ha_clean_id: args.ha_clean_id,
        candidates: args.candidates
      });
      console.log(JSON.stringify({ ok: true, ...out }, null, 2));
      break;
    }
    case 'mix_oiii': {
      const id = await mixOiii(ctx, {
        source_id: args.source_id, out_id: args.out_id,
        gWeight: args.g_weight, bWeight: args.b_weight
      });
      console.log(JSON.stringify({ ok: true, out_id: id }));
      break;
    }
    case 'extract_channel': {
      const id = await extractChannel(ctx, {
        source_id: args.source_id, out_id: args.out_id, channel: args.channel
      });
      console.log(JSON.stringify({ ok: true, out_id: id }));
      break;
    }

    case 'ha_clean_refine': {
      const out = await haCleanRefine(ctx, {
        ha_id: args.ha_id, rgb_red_id: args.rgb_red_id,
        target_id: args.target_id, Q: args.q
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'estimate_continuum_q': {
      const out = await estimateContinuumQ(ctx, {
        ha_id: args.ha_id, rgb_red_id: args.rgb_red_id
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'inject_ha_rgb': {
      const out = await injectHaRGB(ctx, {
        target_id: args.target_id, ha_clean_id: args.ha_clean_id,
        B: args.b, blue_scale: args.blue_scale,
        target_peak: args.target_peak, use_blue: args.use_blue
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'oiii_synthesis': {
      const out = await oiiiSynthesis(ctx, {
        source_id: args.source_id, target_id: args.target_id,
        weights: args.weights
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'integrate_oiii': {
      const out = await integrateOiii(ctx, {
        estimates: args.estimates, target_id: args.target_id, repeats: args.repeats
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'channel_weight_blend': {
      const out = await channelWeightBlend(ctx, {
        sii_id: args.sii_id, ha_id: args.ha_id, oiii_id: args.oiii_id,
        weights: args.weights, target_id: args.target_id, run: args.run
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }

    // ========================================================================
    // --- Preprocess (align / crop / integrate) ---
    // ========================================================================
    case 'star_align': {
      const out = await starAlign(ctx, {
        reference_id: args.reference_id, source_ids: args.source_ids,
        target_ids: args.target_ids, output_dir: args.output_dir,
        pixel_interpolation: args.pixel_interpolation,
        ransac_tolerance: args.ransac_tolerance, max_stars: args.max_stars
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'dynamic_crop': {
      const out = await dynamicCrop(ctx, {
        view_ids: args.view_ids,
        x: args.x, y: args.y, width: args.width, height: args.height,
        margin: args.margin
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'image_integration': {
      const out = await imageIntegration(ctx, {
        source_ids: args.source_ids, target_id: args.target_id,
        combination: args.combination, rejection: args.rejection,
        weighting: args.weighting
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'check_registration': {
      const out = await checkRegistration(ctx, args.view_ids);
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }

    // ========================================================================
    // --- Background (GC → MGC → GraXpert → DBE evaluation chain) ---
    // ========================================================================
    case 'gradient_correct': {
      const out = await gradientCorrect(ctx, args.view_id, {
        methods: args.methods, poly_degree: args.poly_degree,
        tolerance: args.tolerance, max_degradation: args.max_degradation
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'gradient_correct_channels': {
      const out = await gradientCorrectChannels(ctx, args.view_ids, {
        methods: args.methods, poly_degree: args.poly_degree,
        tolerance: args.tolerance, max_degradation: args.max_degradation
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'measure_background': {
      const out = await measureBackground(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'background_neutralize': {
      const out = await backgroundNeutralize(ctx, args.view_id, {
        upper_limit: args.upper_limit, target_bg: args.target_bg,
        shadows: args.shadows
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }

    // ========================================================================
    // --- Applied structure (dark structures, masked saturation) ---
    // ========================================================================
    case 'dark_structure_enhance': {
      const out = await darkStructureEnhance(ctx, args.view_id, {
        amount: args.amount, scale: args.scale, smooth: args.smooth
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'range_mask': {
      const out = await rangeMask(ctx, args.view_id, {
        lower_limit: args.lower_limit, upper_limit: args.upper_limit,
        smoothness: args.smoothness, fuzziness: args.fuzziness,
        use_luminance: args.use_luminance, target_id: args.target_id
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'masked_saturation': {
      const out = await maskedSaturation(ctx, args.view_id, {
        mask_id: args.mask_id, auto_mask: args.auto_mask,
        lower_limit: args.lower_limit, upper_limit: args.upper_limit,
        smoothness: args.smoothness,
        saturation_gain: args.saturation_gain, hue_shift: args.hue_shift
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }

    // ========================================================================
    // --- Stars ---
    // ========================================================================
    case 'separate_stars': {
      const out = await separateStars(ctx, {
        source_id: args.source_id,
        starless_id: args.starless_id,
        stars_id: args.stars_id,
        unscreen: args.unscreen,
        tool: args.tool
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'fix_star_color': {
      const stats = await fixStarColor(ctx, {
        view_id: args.view_id, amount: args.amount, mode: args.mode
      });
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }
    case 'remove_green': {
      const stats = await removeGreen(ctx, {
        view_id: args.view_id, amount: args.amount,
        preserveLuminance: args.preserve_luminance
      });
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }
    case 'shrink_stars': {
      const stats = await shrinkStars(ctx, {
        view_id: args.view_id, iterations: args.iterations,
        size: args.size, amount: args.amount
      });
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }
    case 'recombine_stars': {
      const out = await recombineStars(ctx, {
        starless_id: args.starless_id, stars_id: args.stars_id,
        out_id: args.out_id, strength: args.strength, method: args.method
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'denoise_chroma': {
      const stats = await denoiseChroma(ctx, {
        view_id: args.view_id, chromaAmount: args.chroma_amount,
        iterations: args.iterations, layers: args.layers, threshold: args.threshold
      });
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // ========================================================================
    // --- Denoise policy ---
    // ========================================================================
    case 'measure_noise': {
      const out = await measureNoise(ctx, args.view_id, { sampleStep: args.sample_step });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'auto_denoise': {
      const toolRes = await resolveTool(ctx, 'denoise');
      const out = await autoDenoise(ctx, args.view_id, {
        phase: args.phase, purpose: args.purpose, starred: args.starred,
        toolResolution: toolRes
      });
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }
    case 'plan_denoise': {
      const noise = await measureNoise(ctx, args.view_id);
      const plan = planDenoise(noise, {
        phase: args.phase, purpose: args.purpose, starred: args.starred
      });
      console.log(JSON.stringify({ ok: true, noise, plan }, null, 2));
      break;
    }
    case 'apply_denoise': {
      const plan = {
        needed: true,
        denoise: args.denoise,
        detail: args.detail ?? 0.15,
        reason: 'explicit'
      };
      const toolRes = await resolveTool(ctx, 'denoise');
      const out = await applyDenoise(ctx, args.view_id, plan, toolRes);
      console.log(JSON.stringify({ ok: true, ...out }));
      break;
    }

    default:
      console.error(`Unknown tool: ${toolName}`);
      process.exit(1);
  }
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
