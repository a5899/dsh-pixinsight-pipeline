// ============================================================================
// Tool availability detection + native fallback resolution
//
// The director prompt (v1) requires: "有则用三件套，无则用原生替代"
//   - BlurXTerminator (BXT)        → Deconvolution
//   - NoiseXTerminator (NXT)       → TGVDenoise + MultiscaleMedianTransform
//   - StarXTerminator (SXT)        → StarNet2 / StarNet++ / StarMask
//   - GradientCorrection (GC)      → MGC → GraXpert → DBE
//   - MAS / GHS                    → HistogramTransformation / ArcsinhStretch
//   - NarrowbandNormalization      → manual PixelMath dynamic blending
//
// Detection strategy: try to instantiate the target PJSR process inside
// try/catch on the PixInsight side. `new BlurXTerminator` throws a
// PJSR "process not found" error when the module is not installed.
// ============================================================================

/**
 * Candidate tool identifiers and their PJSR constructor names.
 * Order within each group is the director's preference order.
 */
export const TOOL_GROUPS = {
  sharpen: ['BlurXTerminator', 'Deconvolution'],
  denoise: ['NoiseXTerminator', 'TGVDenoise'],
  starRemove: ['StarXTerminator', 'StarNet2', 'StarNet'],
  background: ['GradientCorrection', 'MultiscaleGradientCorrection', 'GraXpert', 'DynamicBackgroundExtraction'],
  stretch: ['MultiScaleAdaptiveStretch', 'GeneralizedHyperbolicStretch', 'HistogramTransformation'],
  narrowband: ['NarrowbandNormalization'],
  colorCal: ['SpectrophotometricColorCalibration', 'ColorCalibration']
};

const DETECT_IDS = [
  'BlurXTerminator',
  'NoiseXTerminator',
  'StarXTerminator',
  'StarNet2',
  'StarNet',
  'GradientCorrection',
  'MultiscaleGradientCorrection',
  'GraXpert',
  'DynamicBackgroundExtraction',
  'MultiScaleAdaptiveStretch',
  'GeneralizedHyperbolicStretch',
  'HistogramTransformation',
  'NarrowbandNormalization',
  'SpectrophotometricColorCalibration',
  'ColorCalibration',
  'Deconvolution',
  'TGVDenoise',
  'StarMask',
  'ArcsinhStretch',
  'MaskedStretch',
  'LocalHistogramEqualization',
  'CurvesTransformation',
  'ChannelCombination',
  'ChannelExtraction',
  'ImageIntegration',
  'StarAlignment',
  'DynamicCrop',
  'BackgroundNeutralization',
  'ColorSaturation',
  'SCNR',
  'MorphologicalTransformation',
  'MultiscaleMedianTransform',
  'ACDNR',
  'Mirror',
  'Rotation',
  // Not a process: proves the bridge can run arbitrary PJSR and hand back
  // consoleOutput. The probe is sent as a run_script command, so this is the
  // only way detectTools() can tell "unreached" from "window method reached".
  '__BRIDGE_SANITY__'
];

/** Code for the capability probe. */
function buildProbeScript(ids) {
  const lines = ['var out = {};'];
  for (const id of ids) {
    if (id === '__BRIDGE_SANITY__') {
      // null-safe typeof test: the snippet must stay free of the literal
      // "undefined" (see test/smoke.mjs snippet hygiene).
      lines.push(`out['__windowMethod'] = (typeof Window === 'object' && Window) ? 'defined' : 'missing';`);
      continue;
    }
    lines.push(`try { var _p_${id} = new ${id}(); out['${id}'] = true; } catch (e) { out['${id}'] = false; }`);
  }
  lines.push('JSON.stringify(out);');
  return lines.join('\n');
}

/**
 * Probe PixInsight for every known process. Returns a map of
 * { name: boolean }. Results are cached on the ctx object.
 *
 * @param {object} ctx - Bridge context
 * @param {object} [opts] - { force: boolean } bypass cache
 * @returns {Promise<object>} availability map
 */
export async function detectTools(ctx, opts = {}) {
  if (ctx.__toolAvailability && !opts.force) return ctx.__toolAvailability;
  let availability = {};
  try {
    const r = await ctx.pjsr(buildProbeScript(DETECT_IDS));
    if (r.status === 'error') {
      ctx.log(`  [tooling] WARN: detection failed: ${r.error?.message || 'unknown'}`);
    } else {
      const raw = r.outputs?.consoleOutput?.trim() || '{}';
      availability = JSON.parse(raw);
    }
  } catch (e) {
    ctx.log(`  [tooling] WARN: detection threw: ${e.message}`);
  } finally {
    // Kept for diagnostics only: false for every id means the probe never ran
    // in a window-enabled script scope (the watcher executes commands through
    // the window method). capability_report surfaces it as a warning.
    availability.__windowMethod = availability.__windowMethod || 'unknown';
  }
  ctx.__toolAvailability = availability;
  return availability;
}

/**
 * Resolve the best available tool for a capability group.
 *
 * @param {object} ctx - Bridge context
 * @param {string} group - one of TOOL_GROUPS keys
 * @param {object} [opts] - { force: boolean }
 * @returns {Promise<object>} { tool, native, available, chain, missing }
 *   tool  — the selected constructor name
 *   native — true when the selection is a stock PixInsight process
 *   available — full availability map
 *   chain — preference-ordered [{ name, present }]
 *   missing — names not installed
 */
export async function resolveTool(ctx, group, opts = {}) {
  const candidates = TOOL_GROUPS[group];
  if (!candidates) throw new Error(`resolveTool: unknown group '${group}'`);
  // Accept either a bridge ctx (probe PixInsight) or a pre-built availability
  // map ({ available: {...} } or a plain name->bool map) — used by tests.
  const preavailable = opts.available || (ctx && ctx.available) ||
    (ctx && !ctx.pjsr ? ctx : null);
  const available = preavailable || await detectTools(ctx, opts);
  const log = typeof ctx?.log === 'function' ? ctx.log.bind(ctx) : () => {};
  const chain = candidates.map(name => ({ name, present: available[name] === true }));
  const picked = chain.find(c => c.present);
  const native = ['Deconvolution', 'TGVDenoise', 'HistogramTransformation', 'StarMask',
    'DynamicBackgroundExtraction', 'ColorCalibration', 'MultiscaleMedianTransform',
    'SCNR', 'CurvesTransformation', 'ArcsinhStretch', 'MaskedStretch'].includes(picked?.name);
  const result = {
    group,
    tool: picked ? picked.name : null,
    native: !!native,
    chain,
    missing: chain.filter(c => !c.present).map(c => c.name),
    available
  };
  if (!picked) {
    log(`  [tooling] WARN: no tool available for '${group}' (tried: ${candidates.join(', ')})`);
  } else {
    log(`  [tooling] ${group} → ${picked.name}${native ? ' (native)' : ' (plugin)'}`);
  }
  return result;
}

/**
 * Return a compact capability report for the session, grouped by capability.
 * This is what the director should print at the start of a run so the user
 * knows which path (three-piece-suite vs native) will be taken.
 *
 * @param {object} ctx - Bridge context
 * @param {object} [opts] - { force: boolean }
 * @returns {Promise<object>} { suite: {...}, report: string }
 */
export async function capabilityReport(ctx, opts = {}) {
  const groups = {};
  for (const g of Object.keys(TOOL_GROUPS)) {
    groups[g] = await resolveTool(ctx, g, opts);
  }
  const lines = [];
  lines.push('PixInsight capability report:');
  for (const [g, r] of Object.entries(groups)) {
    const fallback = r.tool ? '' : '  → no fallback in group; use a manual alternative';
    lines.push(`  ${g.padEnd(11)} → ${r.tool || 'NONE'}${r.native ? ' [native]' : ''}` +
      (r.missing.length ? `  (missing: ${r.missing.join(', ')})` : '') + fallback);
  }
  const report = lines.join('\n');
  if (typeof ctx?.log === 'function') ctx.log(report);
  return {
    suite: {
      bxt: groups.sharpen.tool,
      nxt: groups.denoise.tool,
      sxt: groups.starRemove.tool,
      gradient: groups.background.tool,
      stretch: groups.stretch.tool,
      narrowband: groups.narrowband.tool,
      color: groups.colorCal.tool
    },
    groups,
    report
  };
}

/**
 * Check whether a specific named process exists.
 * @param {object} ctx
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function hasTool(ctx, name) {
  const available = await detectTools(ctx);
  if (available[name] !== undefined) return available[name] === true;
  // Not in the cached probe set — probe it directly.
  const r = await ctx.pjsr(`
    try { var _p = new ${name}(); 'true'; } catch (e) { 'false'; }
  `);
  return (r.outputs?.consoleOutput || '').trim() === 'true';
}
