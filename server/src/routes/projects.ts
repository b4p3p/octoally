import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { readdir, mkdir, readFile, writeFile, rm, unlink } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from 'fs';
import { promisify } from 'util';
import { getSetting } from './settings.js';
import { installDefaultAgents } from '../data/default-agents.js';

const execFileAsync = promisify(execFile);

/* ================================================================
   Ruflo deprecation helpers
   ================================================================ */

/**
 * Migrate hook paths in .claude/settings.json to absolute paths.
 *
 * Both ruflo init and DevCortex installers write relative or $CLAUDE_PROJECT_DIR
 * paths that break when CWD differs from the project root (e.g. npm scripts change
 * CWD to a subdirectory). $CLAUDE_PROJECT_DIR is not a real Claude Code env var.
 *
 * This runs AFTER any tool writes settings.json and patches all paths to absolute.
 * Idempotent — safe to call multiple times. Returns a log line or null.
 */
function migrateSettingsHookPaths(projectPath: string): string | null {
  const settingsPath = join(projectPath, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    let settings = readFileSync(settingsPath, 'utf-8');
    const oldSettings = settings;
    const pp = projectPath;
    // Fix relative node .claude/ paths → absolute
    settings = settings.replace(/("node )(\.claude\/)/g, `$1${pp}/.claude/`);
    // Fix broken $CLAUDE_PROJECT_DIR references → absolute (unquoted form)
    settings = settings.replace(/("node )\$CLAUDE_PROJECT_DIR\/(\.claude\/)/g, `$1${pp}/.claude/`);
    // Fix broken $CLAUDE_PROJECT_DIR with escaped quotes (ruflo init --force output)
    settings = settings.replace(/(node )(\\"\$CLAUDE_PROJECT_DIR\/)(\.claude\/)/g, `$1${pp}/.claude/`);
    // Clean up trailing escaped quotes left over from the above replacement
    settings = settings.replace(new RegExp(`(${pp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude/helpers/[^"]+)(\\\\")`, 'g'), '$1');
    // Fix relative find/rm .swarm/ paths → absolute
    settings = settings.replace(/(find |rm -f )(\.swarm\/)/g, `$1${pp}/.swarm/`);
    settings = settings.replace(/(find |rm -f )\$CLAUDE_PROJECT_DIR\/(\.swarm\/)/g, `$1${pp}/.swarm/`);
    if (settings !== oldSettings) {
      writeFileSync(settingsPath, settings, 'utf-8');
      return '[migrate] Patched hook paths to absolute: ' + pp;
    }
  } catch {
    // Non-fatal — settings file may be malformed
  }
  return null;
}


/** True if a hook entry matches ruflo/claude-flow (checks matcher + command). */
function isRufloHookEntry(entry: any): boolean {
  const matcherStr = (entry?.matcher || '').toLowerCase();
  if (
    matcherStr.includes('devcortex') ||
    matcherStr.includes('ruflo') ||
    matcherStr.includes('claude-flow') ||
    matcherStr.includes('hive-mind') ||
    matcherStr.includes('hive_mind')
  ) return true;
  const hooks = entry?.hooks || [];
  return hooks.some((h: any) =>
    h?.command && (
      h.command.includes('ruflo') ||
      h.command.includes('claude-flow') ||
      h.command.includes('hook-handler.cjs') ||
      h.command.includes('devcortex') ||
      h.command.includes('.hivecommand') ||
      h.command.includes('sona') ||
      h.command.includes('hive-cleanup') ||
      h.command.includes('memory-sync') ||
      h.command.includes('auto-memory') ||
      h.command.includes('debate-gate') ||
      h.command.includes('graph-state') ||
      h.command.includes('intelligence-hook') ||
      h.command.includes('ranked-context') ||
      h.command.includes('.claude/helpers/')
    )
  );
}

/**
 * Strip ALL ruflo/claude-flow contamination from .claude/settings.json while
 * preserving user config. This is broader than just hooks — ruflo stamps many
 * top-level fields on the settings file:
 *   - `claudeFlow` (entire ruflo config block)
 *   - `attribution` (commit/PR attribution to claude-flow)
 *   - `env.CLAUDE_FLOW_*` and `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
 *   - `statusLine` pointing to `.claude/helpers/` (broken after helpers wipe)
 *   - `permissions.allow` entries referencing claude-flow / ruflo
 *   - `hooks` entries handled by isRufloHookEntry
 *
 * Returns a list of removed fields for logging.
 */
function stripRufloHooks(projectPath: string): string[] {
  const settingsPath = join(projectPath, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return [];
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const removed: string[] = [];

    // 1) Top-level ruflo config block
    if (parsed.claudeFlow !== undefined) {
      delete parsed.claudeFlow;
      removed.push('claudeFlow block');
    }
    if (parsed.claude_flow !== undefined) {
      delete parsed.claude_flow;
      removed.push('claude_flow block');
    }

    // 2) Attribution block — drop if it references claude-flow/ruflo
    if (parsed.attribution && typeof parsed.attribution === 'object') {
      const json = JSON.stringify(parsed.attribution).toLowerCase();
      if (json.includes('claude-flow') || json.includes('ruflo') || json.includes('ruv.net')) {
        delete parsed.attribution;
        removed.push('attribution block');
      }
    }

    // 3) env vars — drop CLAUDE_FLOW_* and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    if (parsed.env && typeof parsed.env === 'object') {
      for (const key of Object.keys(parsed.env)) {
        if (
          key.startsWith('CLAUDE_FLOW_') ||
          key === 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' ||
          key.startsWith('RUFLO_') ||
          key.startsWith('HIVE_MIND_') ||
          key.startsWith('DEVCORTEX_')
        ) {
          delete parsed.env[key];
          removed.push(`env.${key}`);
        }
      }
      if (Object.keys(parsed.env).length === 0) delete parsed.env;
    }

    // 4) statusLine pointing to .claude/helpers/ (broken after helpers wipe)
    if (parsed.statusLine && typeof parsed.statusLine === 'object') {
      const cmd = String(parsed.statusLine.command || '');
      if (cmd.includes('.claude/helpers/') || cmd.includes('statusline.cjs') || cmd.includes('claude-flow') || cmd.includes('ruflo')) {
        delete parsed.statusLine;
        removed.push('statusLine (pointed to ruflo helper)');
      }
    }

    // 5) permissions.allow — strip ruflo-specific entries
    if (parsed.permissions && typeof parsed.permissions === 'object' && Array.isArray(parsed.permissions.allow)) {
      const before = parsed.permissions.allow.length;
      parsed.permissions.allow = parsed.permissions.allow.filter((p: any) => {
        if (typeof p !== 'string') return true;
        const lower = p.toLowerCase();
        return !(
          lower.includes('claude-flow') ||
          lower.includes('claude_flow') ||
          lower.includes('ruflo') ||
          lower.includes('hive-mind') ||
          lower.includes('devcortex') ||
          lower.includes('mcp__claude-flow') ||
          lower.includes('mcp__ruflo') ||
          lower.startsWith('bash(node .claude/') ||
          lower.includes('@claude-flow')
        );
      });
      const after = parsed.permissions.allow.length;
      if (after !== before) {
        removed.push(`${before - after} ruflo permission(s)`);
      }
      if (parsed.permissions.allow.length === 0) {
        delete parsed.permissions.allow;
      }
      if (Object.keys(parsed.permissions).length === 0) {
        delete parsed.permissions;
      }
    }

    // 6) hooks — existing per-entry filter (kept as before)
    if (parsed.hooks && typeof parsed.hooks === 'object') {
      for (const [hookType, entries] of Object.entries(parsed.hooks) as [string, any[]][]) {
        if (!Array.isArray(entries)) continue;
        const before = entries.length;
        parsed.hooks[hookType] = entries.filter((entry: any) => !isRufloHookEntry(entry));
        const after = parsed.hooks[hookType].length;
        if (after !== before) {
          removed.push(`${before - after} hook(s) in ${hookType}`);
        }
        if (parsed.hooks[hookType].length === 0) {
          delete parsed.hooks[hookType];
        }
      }
      if (Object.keys(parsed.hooks).length === 0) {
        delete parsed.hooks;
      }
    }

    if (removed.length > 0) {
      writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    }
    return removed;
  } catch {
    return [];
  }
}

/**
 * Markers that identify ruflo/claude-flow/hive-mind/devcortex content inside a file.
 * Used by the surgical cleanup to tell ruflo files from user files by content.
 * Case-insensitive substring match — prefer long, unambiguous phrases over short
 * tokens to avoid false positives on user code.
 */
const RUFLO_CONTENT_MARKERS = [
  // Core ruflo / claude-flow names
  'claude-flow',
  'claude_flow',
  'claude flow',                              // catches "Claude Flow Agent Router"
  'ruflo',
  'ruvnet',                                   // github.com/ruvnet/ruflo
  'ruv-swarm',                                // legacy alias
  'hive-mind',
  'hive_mind',
  'devcortex',
  '@claude-flow/cli',
  'CLAUDE_FLOW_MODE',
  'CLAUDE_FLOW_HOOKS_ENABLED',
  'agentic-flow',                             // agentic-flow package

  // MCP namespaces unique to ruflo
  'mcp__claude-flow',
  'mcp__ruflo',
  'mcp__claude_flow',
  'mcp__agentic-flow',
  'mcp__ruflo',

  // Ruflo boilerplate phrases (long & unambiguous)
  'RuFlo V3',
  'Claude Flow powered',
  'Multi-agent orchestration framework for agentic coding',
  'Claude Code Configuration - RuFlo',
  'Swarm Orchestration Platform',

  // Ruflo ecosystem sub-projects (long enough to be unambiguous)
  'AgentDB',                                  // agentdb vector db
  'ReasoningBank',                            // reasoningbank learning
  'sublinear solvers',                        // sublinear algorithms
  'flow-nexus',
  'agent-browser',                            // browser-agent ruflo package

  // Ruflo-specific helpers / scripts
  'hook-handler.cjs',
  'sona-bridge',
  'V3 Helper Alias Script',                   // .claude/helpers/v3.sh header
  'HELPERS_DIR=".claude',                     // common pattern in ruflo shell helpers
  'standard-checkpoint-hooks',
  'checkpoint-manager',
  'auto-memory-hook',
  'learning-optimizer',
  'pattern-consolidator',

  // Ruflo-specific agent names and phrases
  'tdd-london-swarm',
  'byzantine-coordinator',
  'consensus-coordinator',
  'gossip-coordinator',
  'crdt-synchronizer',
  'raft-manager',
  'quorum-manager',
  'performance-benchmarker',
  'pagerank-analyzer',
  'trading-predictor',
  'matrix-optimizer',
  'sparc-coder',
  'sparc-coord',
  'hierarchical-coordinator',
  'mesh-coordinator',
  'adaptive-coordinator',
  'collective-intelligence-coordinator',
  'swarm-memory-manager',
  'aidefence-guardian',
  'production-validator',
  'Distributed consensus',                    // common opening in ruflo consensus agents

  // Ruflo default-agent frontmatter markers (structural — very unlikely in
  // user-created agents): the ruflo installer stamps `author: "Claude Code"`
  // on every default agent it ships, and uses ruflo-specific MCP namespaces.
  'author: "Claude Code"',
  "author: 'Claude Code'",
  'mcp__agentic-',
  'mcp__ruflo-',
  'mcp__claude-flow-',

  // Known ruflo default subagent slugs (shipped with every ruflo install).
  // These are listed in the ruflo subagent catalog and users would not
  // recreate them verbatim in their own files.
  'test-long-runner',
];

/** Scan a utf-8 text for ruflo markers. Empty/unreadable → false (safe). */
function isRufloContent(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const m of RUFLO_CONTENT_MARKERS) {
    if (lower.includes(m.toLowerCase())) return true;
  }
  return false;
}

/** Read a file as utf-8, swallow errors, return '' if unreadable or too big. */
function safeReadText(filePath: string): string {
  try {
    const st = lstatSync(filePath);
    if (!st.isFile()) return '';
    // Cap at 2 MB — ruflo helpers are always smaller, and we don't want to slurp
    // huge user binaries by accident.
    if (st.size > 2 * 1024 * 1024) return '';
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Recursively walk `dir` and delete any file whose content matches `isRufloContent`.
 * Empty directories are removed bottom-up afterwards. Symlinks and unreadable
 * files are left untouched. Never follows symlinks into unexpected places.
 * Returns the relative paths of the files that were removed (for logging).
 */
function cleanRufloFilesInDir(projectPath: string, relDir: string, cleaned: string[]): void {
  const fullDir = join(projectPath, relDir);
  if (!existsSync(fullDir)) return;

  const walk = (absDir: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      const abs = join(absDir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue; // never follow/delete symlinks
      if (st.isDirectory()) {
        walk(abs);
        // Remove dir if empty after recursion
        try {
          const remaining = readdirSync(abs);
          if (remaining.length === 0) {
            try { rmdirSync(abs); cleaned.push(`removed empty dir ${abs.slice(projectPath.length + 1)}/`); } catch {}
          }
        } catch {}
        continue;
      }
      if (!st.isFile()) continue;
      const text = safeReadText(abs);
      if (isRufloContent(text)) {
        try {
          unlinkSync(abs);
          cleaned.push(`removed ${abs.slice(projectPath.length + 1)}`);
        } catch { /* non-fatal */ }
      }
    }
  };

  walk(fullDir);

  // Final pass: if the root dir itself ended up empty, remove it too.
  try {
    const remaining = readdirSync(fullDir);
    if (remaining.length === 0) {
      rmdirSync(fullDir);
      cleaned.push(`removed empty dir ${relDir}/`);
    }
  } catch { /* non-fatal */ }
}

/**
 * Strip ruflo/claude-flow entries from .mcp.json without touching user entries.
 * If the resulting mcpServers object is empty, the whole file is removed.
 */
function stripRufloFromMcpJson(projectPath: string): string | null {
  const mcpPath = join(projectPath, '.mcp.json');
  if (!existsSync(mcpPath)) return null;
  try {
    const raw = readFileSync(mcpPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      return null;
    }
    const removed: string[] = [];
    for (const key of Object.keys(parsed.mcpServers)) {
      const kLower = key.toLowerCase();
      if (
        kLower.includes('claude-flow') ||
        kLower.includes('claude_flow') ||
        kLower.includes('ruflo') ||
        kLower.includes('devcortex') ||
        kLower.includes('hive-mind') ||
        kLower.includes('hive_mind')
      ) {
        delete parsed.mcpServers[key];
        removed.push(key);
        continue;
      }
      // Also scan the entry's command/args for ruflo markers — catches
      // entries that are named generically but run ruflo.
      const entryJson = JSON.stringify(parsed.mcpServers[key]);
      if (isRufloContent(entryJson)) {
        delete parsed.mcpServers[key];
        removed.push(`${key} (ruflo-marked)`);
      }
    }
    if (removed.length === 0) return null;
    if (Object.keys(parsed.mcpServers).length === 0) {
      // No user entries left — drop the file.
      unlinkSync(mcpPath);
      return `removed .mcp.json (only contained: ${removed.join(', ')})`;
    }
    writeFileSync(mcpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return `.mcp.json: stripped ${removed.join(', ')}`;
  } catch {
    return null;
  }
}

/**
 * Remove ruflo/devcortex artifacts from a single project — SURGICAL mode.
 *
 * Safety contract:
 *   NEVER touched: CLAUDE.md, AGENTS.md, .codex/, .claude/rules/, .claude/memory/,
 *                  .claude/settings.local.json, or any file without a ruflo marker.
 *   MODIFIED in place (not deleted): .claude/settings.json, .mcp.json
 *   DELETED wholesale (pure ruflo): .claude-flow/, .ruflo/, .hive-mind/, .devcortex-cli/
 *                                   .devcortex, claude-flow.config.json, ruvector.db
 *   SCANNED by content: .claude/commands/, .claude/agents/, .claude/skills/,
 *                       .claude/helpers/ — only files with ruflo markers are removed.
 *
 * Returns a list of cleaned items for logging.
 */
async function cleanRufloFromProject(projectPath: string): Promise<string[]> {
  const cleaned: string[] = [];

  // --- A) Pure-ruflo directories: safe to nuke wholesale -------------------
  // Note: `.claude/helpers/` and `.claude/agents/templates/` are included
  // because Claude Code itself does not populate these by default — any
  // content there was installed by ruflo/claude-flow/devcortex. User content
  // belongs in `.claude/rules/`, `.claude/memory/`, project root, or custom
  // subdirectories the user explicitly created.
  const pureRufloDirs = [
    '.claude-flow',
    '.devcortex-cli',
    '.hive-mind',
    '.ruflo',
    '.claude/helpers',
    '.claude/agents/templates',
  ];
  for (const dir of pureRufloDirs) {
    const fullPath = join(projectPath, dir);
    if (existsSync(fullPath)) {
      try {
        await rm(fullPath, { recursive: true, force: true });
        cleaned.push(`removed ${dir}/`);
      } catch { /* non-fatal */ }
    }
  }

  // --- B) Pure-ruflo files: safe to delete ---------------------------------
  const pureRufloFiles = [
    '.devcortex',
    'claude-flow.config.json',
    'ruvector.db',
  ];
  for (const file of pureRufloFiles) {
    const fullPath = join(projectPath, file);
    if (existsSync(fullPath)) {
      try {
        await unlink(fullPath);
        cleaned.push(`removed ${file}`);
      } catch { /* non-fatal */ }
    }
  }

  // --- C) Surgical modify-in-place -----------------------------------------
  // C.1: .claude/settings.json → strip all ruflo-injected fields in place.
  const strippedFields = stripRufloHooks(projectPath);
  if (strippedFields.length > 0) {
    cleaned.push(`.claude/settings.json: stripped ${strippedFields.join(', ')}`);
    // If the resulting file is now an empty {} object, remove it so
    // Claude Code will recreate a fresh default on next use.
    const settingsPath = join(projectPath, '.claude', 'settings.json');
    try {
      const after = readFileSync(settingsPath, 'utf-8').trim();
      if (after === '{}' || after === '') {
        unlinkSync(settingsPath);
        cleaned.push('.claude/settings.json: removed (empty after strip)');
      }
    } catch { /* non-fatal */ }
  }

  // C.2: .mcp.json → strip ruflo/claude-flow entries
  const mcpResult = stripRufloFromMcpJson(projectPath);
  if (mcpResult) cleaned.push(mcpResult);

  // --- D) Content-scan directories: delete ONLY ruflo-marked files ---------
  //   NOTE: CLAUDE.md and AGENTS.md are NOT in this list. They often contain
  //   mixed user/ruflo content and MUST be cleaned manually by the user.
  //   `.claude/helpers/` is handled by step A (full wipe).
  const scanDirs = [
    '.claude/commands',
    '.claude/agents',
    '.claude/skills',
  ];
  for (const relDir of scanDirs) {
    cleanRufloFilesInDir(projectPath, relDir, cleaned);
  }

  // --- E) MCP deregister (idempotent) --------------------------------------
  for (const server of ['ruflo', 'devcortex', 'claude-flow']) {
    try {
      await execFileAsync('claude', ['mcp', 'remove', server], {
        cwd: projectPath,
        timeout: 15_000,
      });
      cleaned.push(`deregistered ${server} MCP server`);
    } catch { /* already removed or CLI not found */ }
  }

  return cleaned;
}

/** Check if ruflo/claude-flow artifacts exist at a project path. */
function hasRufloArtifacts(projectPath: string): boolean {
  // Pure-ruflo directories
  const rufloDirs = ['.claude-flow', '.ruflo', '.hive-mind', '.devcortex-cli'];
  for (const d of rufloDirs) {
    if (existsSync(join(projectPath, d))) return true;
  }

  // Pure-ruflo top-level files
  const rufloFiles = ['.devcortex', 'claude-flow.config.json', 'ruvector.db'];
  for (const f of rufloFiles) {
    if (existsSync(join(projectPath, f))) return true;
  }

  // Known ruflo helper scripts under .claude/helpers/
  const rufloHelpers = [
    '.claude/helpers/hook-handler.cjs',
    '.claude/helpers/sona-bridge.cjs',
    '.claude/helpers/learning-service.mjs',
    '.claude/helpers/intelligence.cjs',
  ];
  for (const h of rufloHelpers) {
    if (existsSync(join(projectPath, h))) return true;
  }

  // Well-known ruflo commands at the top of .claude/commands/
  const rufloCommands = [
    '.claude/commands/claude-flow-help.md',
    '.claude/commands/claude-flow-memory.md',
    '.claude/commands/claude-flow-swarm.md',
  ];
  for (const c of rufloCommands) {
    if (existsSync(join(projectPath, c))) return true;
  }

  // Content scan: CLAUDE.md — flag if it contains ruflo markers, even if
  // the file also has user content. We won't auto-delete it; we only use
  // this flag to keep the modal visible until the user cleans it.
  if (isRufloContent(safeReadText(join(projectPath, 'CLAUDE.md')))) return true;

  // Content scan: .claude/settings.json for claude-flow references
  if (isRufloContent(safeReadText(join(projectPath, '.claude', 'settings.json')))) return true;

  // Content scan: .mcp.json for claude-flow entries
  if (isRufloContent(safeReadText(join(projectPath, '.mcp.json')))) return true;

  return false;
}


export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  session_prompt: string | null;
  openclaw_prompt: string | null;
  default_web_url: string | null;
  skip_permissions: number;
  color: string;
  created_at: string;
  updated_at: string;
}

/** ~/.octoally/projects.json — portable backup, not the source of truth */
const OCTOALLY_DIR = join(homedir(), '.octoally');
const PROJECTS_FILE = join(OCTOALLY_DIR, 'projects.json');

/** Export current DB projects to the config file (for portability across DB resets) */
async function exportToConfig(): Promise<void> {
  const db = getDb();
  const rows = db.prepare('SELECT name, path, description, session_prompt, openclaw_prompt, default_web_url FROM projects ORDER BY name COLLATE NOCASE').all();
  await mkdir(OCTOALLY_DIR, { recursive: true });
  await writeFile(PROJECTS_FILE, JSON.stringify({ projects: rows }, null, 2), 'utf-8');
}

/**
 * Called once on startup. If the DB has no projects but the config file does,
 * import them (handles DB reset / fresh install with existing config).
 */
export async function initProjects(): Promise<void> {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n;

  if (count > 0) {
    // DB has projects — make sure config file is up to date
    await exportToConfig();
    return;
  }

  // DB is empty — try importing from config file
  try {
    const raw = await readFile(PROJECTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const configs = Array.isArray(data.projects) ? data.projects : [];

    let imported = 0;
    for (const p of configs) {
      if (!p.name || !p.path) continue;
      const id = nanoid(12);
      db.prepare('INSERT INTO projects (id, name, path, description, session_prompt, openclaw_prompt, default_web_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.name, p.path, p.description || null, p.session_prompt || null, p.openclaw_prompt || null, p.default_web_url || null);
      imported++;
    }
    if (imported > 0) {
      console.log(`  Imported ${imported} projects from ~/.octoally/projects.json`);
    }
  } catch {
    // No config file — that's fine, new user starts with empty projects
  }
}

export const projectRoutes: FastifyPluginAsync = async (app) => {
  // List projects
  app.get('/projects', async () => {
    const db = getDb();
    const projects = db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all();
    return { projects };
  });

  // Get single project
  app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return { project };
  });

  // Create project
  app.post<{
    Body: { name: string; path: string; description?: string; session_prompt?: string; openclaw_prompt?: string; default_web_url?: string; color?: string };
  }>('/projects', async (req, reply) => {
    const { name, path, description, session_prompt, openclaw_prompt, default_web_url, color } = req.body;
    if (!name || !path) return reply.status(400).send({ error: 'name and path are required' });

    const db = getDb();
    const id = nanoid(12);

    const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(path);
    if (existing) return reply.status(409).send({ error: 'Project with this path already exists' });

    db.prepare('INSERT INTO projects (id, name, path, description, session_prompt, openclaw_prompt, default_web_url, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, path, description || null, session_prompt || null, openclaw_prompt || null, default_web_url || null, color || '');

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    await exportToConfig();

    // Ensure default agents are installed (no-op if marker exists)
    try { installDefaultAgents(); } catch { /* non-fatal */ }

    return { ok: true, project };
  });

  // Update project
  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; session_prompt?: string | null; openclaw_prompt?: string | null; default_web_url?: string | null; skip_permissions?: number; color?: string };
  }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const updates: string[] = [];
    const params: unknown[] = [];

    if (req.body.name) { updates.push('name = ?'); params.push(req.body.name); }
    if (req.body.description !== undefined) { updates.push('description = ?'); params.push(req.body.description); }
    if (req.body.session_prompt !== undefined) { updates.push('session_prompt = ?'); params.push(req.body.session_prompt); }
    if (req.body.openclaw_prompt !== undefined) { updates.push('openclaw_prompt = ?'); params.push(req.body.openclaw_prompt); }
    if (req.body.default_web_url !== undefined) { updates.push('default_web_url = ?'); params.push(req.body.default_web_url); }
    if (req.body.skip_permissions !== undefined) { updates.push('skip_permissions = ?'); params.push(req.body.skip_permissions ? 1 : 0); }
    if (req.body.color !== undefined) { updates.push('color = ?'); params.push(req.body.color); }

    if (updates.length === 0) return reply.status(400).send({ error: 'Nothing to update' });

    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    const result = db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) return reply.status(404).send({ error: 'Project not found' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    await exportToConfig();

    return { ok: true, project };
  });

  // Delete project
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    // Nullify foreign key references before deleting (sessions/tasks/events may reference this project)
    db.prepare('UPDATE sessions SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    db.prepare('UPDATE events SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return reply.status(404).send({ error: 'Project not found' });

    await exportToConfig();
    return { ok: true };
  });

  // Uninstall ruflo/devcortex from a single project
  app.post<{
    Params: { id: string };
  }>('/projects/:id/ruflo-uninstall', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const cleaned = await cleanRufloFromProject(project.path);
    return { ok: true, cleaned };
  });

  // Bulk uninstall ruflo/devcortex from ALL projects + global cleanup
  app.post('/projects/ruflo-uninstall-all', async () => {
    const db = getDb();
    const projects = db.prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[];

    let projectsCleaned = 0;
    const globalCleaned: string[] = [];

    // Clean each project
    for (const p of projects) {
      const result = await cleanRufloFromProject(p.path);
      if (result.length > 0) projectsCleaned++;
    }

    // Remove broken symlinks in ~/.octoally/ (leftover from hivecommand migration)
    const octoallyDir = join(homedir(), '.octoally');
    try {
      for (const entry of readdirSync(octoallyDir)) {
        const full = join(octoallyDir, entry);
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink() && !existsSync(full)) {
            unlinkSync(full);
            globalCleaned.push(`removed broken symlink ${entry}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }

    // Global cleanup
    const globalDirs = [
      join(homedir(), '.octoally', 'ruflo'),
      join(homedir(), '.hivecommand'),
      join(homedir(), '.config', 'devcortex'),
    ];
    for (const dir of globalDirs) {
      if (existsSync(dir)) {
        try {
          await rm(dir, { recursive: true, force: true });
          globalCleaned.push(`removed ${dir}`);
        } catch { /* non-fatal */ }
      }
    }

    // Global files
    const globalFiles = [
      join(homedir(), '.octoally', 'ruflo-run.sh'),
      join(homedir(), '.hivecommand', 'ruflo-run.sh'),
    ];
    for (const file of globalFiles) {
      if (existsSync(file)) {
        try {
          await unlink(file);
          globalCleaned.push(`removed ${file}`);
        } catch { /* non-fatal */ }
      }
    }

    // Global CLAUDE.md files are intentionally NOT deleted here — they can
    // contain mixed user+ruflo content and require manual cleanup. We only
    // flag them so the user knows where to look.
    const globalClaudeMdFiles = [
      join(homedir(), 'CLAUDE.md'),
      join(homedir(), '.claude', 'CLAUDE.md'),
    ];
    for (const file of globalClaudeMdFiles) {
      if (existsSync(file)) {
        try {
          const content = readFileSync(file, 'utf-8');
          if (isRufloContent(content)) {
            globalCleaned.push(`flagged (manual review needed): ${file}`);
          }
        } catch { /* non-fatal */ }
      }
    }

    // Deregister ruflo/devcortex MCP globally
    try {
      await execFileAsync('claude', ['mcp', 'remove', 'ruflo'], { timeout: 15_000 });
      globalCleaned.push('deregistered ruflo MCP (global)');
    } catch { /* already removed */ }
    try {
      await execFileAsync('claude', ['mcp', 'remove', 'devcortex'], { timeout: 15_000 });
      globalCleaned.push('deregistered devcortex MCP (global)');
    } catch { /* already removed */ }

    // Reset session commands to plain defaults
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    upsert.run('session_claude_command', 'claude');
    upsert.run('session_codex_command', 'codex');
    upsert.run('agent_claude_command', 'claude');
    upsert.run('agent_codex_command', 'codex');
    // Clean any stale old-named keys
    db.prepare('DELETE FROM settings WHERE key IN (?, ?, ?)').run('ruflo_command', 'hivemind_claude_command', 'hivemind_codex_command');

    // Update disposition to 'removed'
    upsert.run('ruflo_disposition', 'removed');

    // Re-install default agents (ruflo cleanup may have deleted .claude/agents/)
    try {
      const { installed } = installDefaultAgents(true);
      if (installed.length > 0) globalCleaned.push(`installed ${installed.length} default agent(s)`);
    } catch { /* non-fatal */ }

    return { ok: true, projectsCleaned, globalCleaned };
  });

  // Set skip_permissions for all projects at once
  app.put<{
    Body: { skip_permissions: boolean };
  }>('/projects/skip-permissions-all', async (req, reply) => {
    const db = getDb();
    const val = req.body.skip_permissions ? 1 : 0;
    const result = db.prepare('UPDATE projects SET skip_permissions = ?, updated_at = datetime(\'now\')').run(val);
    return { ok: true, updated: result.changes };
  });

  // Get ruflo disposition and detection status
  app.get('/projects/ruflo-disposition', async () => {
    const disposition = getSetting('ruflo_disposition');
    const db = getDb();
    const projects = db.prepare('SELECT path FROM projects').all() as { path: string }[];

    let rufloDetected = false;
    for (const p of projects) {
      if (hasRufloArtifacts(p.path)) {
        rufloDetected = true;
        break;
      }
    }

    return { disposition, rufloDetected };
  });

  // Set ruflo disposition
  app.put<{
    Body: { disposition: string };
  }>('/projects/ruflo-disposition', async (req, reply) => {
    const { disposition } = req.body as any;
    if (!['undecided', 'keep', 'remove_all', 'removed'].includes(disposition)) {
      return reply.status(400).send({ error: 'Invalid disposition. Must be: undecided, keep, remove_all, removed' });
    }
    const db = getDb();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('ruflo_disposition', disposition);
    return { ok: true, disposition };
  });

  // List available agent types for a project (reads .claude/agents/*.md from project + global)
  app.get<{
    Params: { id: string };
  }>('/projects/:id/ruflo-agents', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const agents: { name: string; type: string; description: string; category: string }[] = [];

    const walkDir = async (dir: string, category: string) => {
      if (!existsSync(dir)) return;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(fullPath, entry.name);
          } else if (entry.name.endsWith('.md')) {
            try {
              const content = await readFile(fullPath, 'utf-8');
              const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
              if (frontmatterMatch) {
                const fm = frontmatterMatch[1];
                const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
                const type = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '') || '';
                const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '') || '';
                if (name) {
                  agents.push({ name, type, description: desc, category });
                }
              }
            } catch {}
          }
        }
      } catch {}
    };

    // Scan both global and project-level agent directories
    await walkDir(join(homedir(), '.claude', 'agents'), 'global');
    await walkDir(join(project.path, '.claude', 'agents'), 'project');

    // Deduplicate by name (project-level overrides global)
    const seen = new Set<string>();
    const unique = agents.filter(a => {
      if (seen.has(a.name)) return false;
      seen.add(a.name);
      return true;
    });
    unique.sort((a, b) => a.name.localeCompare(b.name));

    return { agents: unique };
  });

  // DevCortex status for all projects
  app.get('/projects/devcortex-status', async () => {
    const db = getDb();
    const projects = db.prepare('SELECT id, name, path FROM projects').all() as { id: string; name: string; path: string }[];

    // Check global DevCortex config
    const globalConfigPath = join(homedir(), '.config', 'devcortex', 'config.json');
    const globalInstalled = existsSync(globalConfigPath);
    let globalConfig: { server_url?: string; api_key?: string } | null = null;
    if (globalInstalled) {
      try {
        globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
      } catch {}
    }

    const statuses: Record<string, { installed: boolean; eligible: boolean; version?: string }> = {};
    for (const p of projects) {
      const devcortexFile = join(p.path, '.devcortex');
      const installed = existsSync(devcortexFile);
      let version: string | undefined;
      if (installed) {
        try {
          const data = JSON.parse(readFileSync(devcortexFile, 'utf-8'));
          version = data.local_version || undefined;
        } catch {}
      }
      statuses[p.id] = {
        installed,
        eligible: globalInstalled,
        version,
      };
    }

    return { globalInstalled, statuses };
  });

  // DEPRECATED: DevCortex install — no longer supported
  app.post<{
    Params: { id: string };
  }>('/projects/:id/devcortex-install', async (_req, reply) => {
    return reply.status(410).send({ error: 'DevCortex installation has been deprecated.' });
  });

  // Uninstall DevCortex from a project (removes .devcortex file)
  app.delete<{
    Params: { id: string };
  }>('/projects/:id/devcortex', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const devcortexFile = join(project.path, '.devcortex');
    if (!existsSync(devcortexFile)) {
      return reply.status(404).send({ error: 'DevCortex not installed on this project' });
    }

    const { unlink } = await import('fs/promises');
    await unlink(devcortexFile);
    return { ok: true };
  });

  // Browse directories (for folder picker UI)
  app.get<{
    Querystring: { path?: string };
  }>('/browse', async (req, reply) => {
    const dirPath = resolve(req.query.path || homedir());

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const dirs: { name: string; path: string; hasChildren: boolean }[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;

        const fullPath = join(dirPath, entry.name);
        let hasChildren = false;
        try {
          const sub = await readdir(fullPath, { withFileTypes: true });
          hasChildren = sub.some(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
        } catch {
          // Can't read subdirectory
        }

        dirs.push({ name: entry.name, path: fullPath, hasChildren });
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name));

      return {
        path: dirPath,
        parent: dirPath === '/' ? null : resolve(dirPath, '..'),
        folderName: basename(dirPath),
        dirs,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'Directory not found' });
      if (err.code === 'EACCES') return reply.status(403).send({ error: 'Permission denied' });
      return reply.status(500).send({ error: 'Failed to browse directory' });
    }
  });

};
