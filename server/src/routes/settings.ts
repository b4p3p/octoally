import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default values for all settings */
const DEFAULTS: Record<string, string> = {
  session_claude_command: 'claude',
  session_codex_command: 'codex',
  agent_claude_command: 'claude',
  agent_codex_command: 'codex',
  terminal_font_size: '12',
  app_font_size: '16',
  server_port: '42010',
  ruflo_disposition: 'undecided',   // undecided | keep | remove_all | removed
  statusline_prompted: 'false',    // whether we've asked the user about statusline install
  default_model: '',               // '' = let the CLI use its own default (no --model flag)
  shortcut_bindings: '{}',         // JSON: { [actionId]: { combo, fireInEditable } }
};

const STATUSLINE_SCRIPT = 'octoally-statusline.sh';
const STATUSLINE_MARKER = '// octoally-managed-statusline';

function getGlobalSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function getStatuslineScriptPath(): string {
  return join(homedir(), '.claude', STATUSLINE_SCRIPT);
}

function readGlobalSettings(): Record<string, any> {
  const p = getGlobalSettingsPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
}

function writeGlobalSettings(settings: Record<string, any>): void {
  const p = getGlobalSettingsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/** The statusline lives globally in ~/.claude, shared by every OctoAlly
 *  instance (and Claude Code itself). Its real presence — not the per-DB
 *  `statusline_prompted` flag — is the source of truth for "is it set up?". */
function isStatuslineInstalled(): boolean {
  const settings = readGlobalSettings();
  return !!(
    settings.statusLine?.command?.includes(STATUSLINE_SCRIPT) &&
    existsSync(getStatuslineScriptPath())
  );
}

export function getSetting(key: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key] ?? '';
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // Get all settings
  app.get('/settings', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    // The statusline is a global resource (~/.claude). If it's already
    // installed, never report the install prompt as pending — regardless of
    // the per-DB flag, which would otherwise re-fire on a fresh database.
    if (isStatuslineInstalled()) settings.statusline_prompted = 'true';
    return { settings };
  });

  // Update settings
  app.put<{
    Body: { settings: Record<string, string> };
  }>('/settings', async (req, reply) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return reply.status(400).send({ error: 'settings object is required' });
    }

    const db = getDb();
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

    const allowed = new Set(Object.keys(DEFAULTS));
    for (const [key, value] of Object.entries(settings)) {
      if (!allowed.has(key)) continue;
      upsert.run(key, String(value));
    }

    // Return current state
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const current: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) {
      current[row.key] = row.value;
    }
    return { ok: true, settings: current };
  });

  // Check if OctoAlly statusline is installed
  app.get('/settings/statusline', async () => {
    return { installed: isStatuslineInstalled() };
  });

  // Install OctoAlly statusline to global ~/.claude/settings.json
  app.post('/settings/statusline/install', async () => {
    const scriptDest = getStatuslineScriptPath();
    const scriptSrc = join(__dirname, '..', 'data', 'statusline.sh');

    // Copy script
    mkdirSync(dirname(scriptDest), { recursive: true });
    writeFileSync(scriptDest, readFileSync(scriptSrc, 'utf-8'), { mode: 0o755 });

    // Update global settings.json
    const settings = readGlobalSettings();
    settings.statusLine = {
      type: 'command',
      command: scriptDest,
      _comment: STATUSLINE_MARKER,
    };
    writeGlobalSettings(settings);

    return { ok: true, scriptPath: scriptDest };
  });

  // Uninstall OctoAlly statusline from global ~/.claude/settings.json
  app.post('/settings/statusline/uninstall', async () => {
    const scriptPath = getStatuslineScriptPath();
    const removed: string[] = [];

    // Remove script file
    if (existsSync(scriptPath)) {
      try {
        const { unlinkSync } = await import('fs');
        unlinkSync(scriptPath);
        removed.push('removed script');
      } catch { /* non-fatal */ }
    }

    // Remove statusLine from global settings
    const settings = readGlobalSettings();
    if (settings.statusLine) {
      delete settings.statusLine;
      writeGlobalSettings(settings);
      removed.push('removed statusLine config');
    }

    return { ok: true, removed };
  });
};
