// ============================================================================
// Working directory (single source of truth)
//
// Every process artefact this plugin writes goes under one workspace root:
//   <workspace>/previews     step previews (save_preview)
//   <workspace>/variants     named image snapshots (save_variant / load_variant)
//   <workspace>/runs         run logs and per-run bookkeeping (optional)
//
// The root is chosen once, on first use, and recorded in
//   ~/.pixinsight-mcp/workspace.json      { "workspace": "<absolute path>" }
// because that file lives next to the bridge (whose location is fixed by the
// PJSR side), not inside the workspace itself. Deleting the config therefore
// never orphans the workspace, and the default keeps working with no config at
// all: not choosing a directory is a valid answer.
//
// Resolution order:
//   1. PIXINSIGHT_WORKSPACE env var      (per-session override, no file written)
//   2. ~/.pixinsight-mcp/workspace.json  (the user's saved choice)
//   3. ~/.pixinsight-mcp                 (default — what older builds used)
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';

export const CONFIG_DIR = path.join(os.homedir(), '.pixinsight-mcp');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'workspace.json');
export const DEFAULT_WORKSPACE = CONFIG_DIR;
export const ENV_OVERRIDE = 'PIXINSIGHT_WORKSPACE';

/** Subdirectories created on demand inside the workspace. */
export const SUBDIRS = ['previews', 'variants', 'runs'];

/**
 * Read the saved workspace choice.
 * @returns {string|null} absolute path, or null when nothing was saved
 */
export function readWorkspaceConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  } catch {
    return null;                       // no config: first use, or user deleted it
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt config must never block processing — fall back to the default
    // and let `workspace_show` report that the file needs re-saving.
    return null;
  }
  const ws = typeof parsed?.workspace === 'string' ? parsed.workspace.trim() : '';
  return ws ? path.resolve(ws) : null;
}

function envWorkspace() {
  const fromEnv = process.env[ENV_OVERRIDE];
  return fromEnv && fromEnv.trim() ? path.resolve(fromEnv.trim()) : null;
}

/**
 * Resolve the workspace root without writing anything.
 * @returns {{ workspace: string, source: 'env'|'config'|'default', configured: boolean }}
 *   source `default` also means "first use": nothing has been chosen yet.
 */
export function resolveWorkspace() {
  const env = envWorkspace();
  if (env) return { workspace: env, source: 'env', configured: true };
  const saved = readWorkspaceConfig();
  if (saved) return { workspace: saved, source: 'config', configured: true };
  return { workspace: DEFAULT_WORKSPACE, source: 'default', configured: false };
}

/** Current workspace root, creating nothing. */
export function workspaceRoot() {
  return resolveWorkspace().workspace;
}

/** Absolute path of a workspace subdirectory, creating it if asked. */
export function workspaceDir(name, { create = true } = {}) {
  if (!SUBDIRS.includes(name)) throw new Error(`workspaceDir: unknown subdirectory '${name}'`);
  const dir = path.join(workspaceRoot(), name);
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist a workspace choice.
 * @param {string} dir - target directory; must be writable
 * @returns {{ workspace: string, config_path: string }}
 */
export function saveWorkspaceConfig(dir) {
  const target = String(dir ?? '').trim();
  if (!target) throw new Error('saveWorkspaceConfig: directory is required');
  const abs = path.resolve(target);
  // Prove it is usable now rather than at the first save_preview, hours in.
  fs.mkdirSync(abs, { recursive: true });
  const probe = path.join(abs, '.pixinsight-mcp-write-test');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  for (const sub of SUBDIRS) fs.mkdirSync(path.join(abs, sub), { recursive: true });

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    workspace: abs,
    saved_at: new Date().toISOString(),
    note: 'PixInsight pipeline working directory. Delete this file to return to the default (~/.pixinsight-mcp).'
  }, null, 2) + '\n');
  return { workspace: abs, config_path: CONFIG_PATH };
}

/**
 * Decode what the user typed for `workspace_set`.
 *
 * Accepts an absolute path, a leading `~`, or one of the shortcuts a first-run
 * prompt offers:
 *   "default" | "d" | ""      -> keep the default (~/.pixinsight-mcp)
 *   "documents"               -> ~/Documents/PixInsightWorkspace
 *   "ask" / "prompt"          -> no change; caller should ask again
 *
 * @returns {{ action: 'set'|'default'|'ask', path: string, raw: string }}
 */
export function interpretWorkspaceChoice(input) {
  const raw = String(input ?? '').trim();
  const lower = raw.toLowerCase();
  if (!raw || ['default', 'd', '0', 'none'].includes(lower)) {
    return { action: 'default', path: DEFAULT_WORKSPACE, raw };
  }
  if (['ask', 'prompt', 'later', '?', 'help'].includes(lower)) {
    return { action: 'ask', path: DEFAULT_WORKSPACE, raw };
  }
  if (lower === 'documents') {
    return { action: 'set', path: path.join(os.homedir(), 'Documents', 'PixInsightWorkspace'), raw };
  }
  const expanded = raw === '~' ? os.homedir()
    : raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(2))
      : raw;
  return { action: 'set', path: path.resolve(expanded), raw };
}

/**
 * Full status report for `workspace_show`, including a writability check.
 */
export function workspaceStatus() {
  const resolved = resolveWorkspace();
  let writable = false;
  let error = null;
  try {
    fs.mkdirSync(resolved.workspace, { recursive: true });
    const probe = path.join(resolved.workspace, '.pixinsight-mcp-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    writable = true;
  } catch (e) {
    error = e.message;
  }
  const dirs = {};
  for (const sub of SUBDIRS) {
    const d = path.join(resolved.workspace, sub);
    let count = 0;
    try { count = fs.readdirSync(d).length; } catch { count = 0; }
    dirs[sub] = { path: d, entries: count };
  }
  return {
    workspace: resolved.workspace,
    source: resolved.source,
    configured: resolved.configured,
    // True on the very first run: nothing saved, no env override. The agent
    // must ask the user once (see ONBOARDING.md) and continue either way.
    first_use: resolved.source === 'default',
    default_workspace: DEFAULT_WORKSPACE,
    config_path: CONFIG_PATH,
    env_override: envWorkspace(),
    writable,
    error,
    subdirs: dirs
  };
}
