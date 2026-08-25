/**
 * Agent definitions bundled with OctoAlly.
 * Sourced from:
 *   - https://github.com/lst97/claude-code-sub-agents (MIT License)
 *   - https://github.com/wshobson/agents (MIT License)
 *
 * These are deliberately NOT copied into `~/.claude/agents/`. That folder is
 * global: Claude Code injects the name, description and tool list of every
 * definition it finds there into the prompt of *every* session on the machine,
 * OctoAlly-related or not (~5.4k tokens for the 36 files we used to install).
 * A feature driven from one place must not bill every place.
 *
 * Instead the .md files stay here, and only the agent actually being launched
 * is handed to the CLI — via `--agents <json>` for Claude, or the persona
 * prompt builder for Codex / inherit-MCP (see pty-worker.ts).
 *
 * `cleanupInstalledAgents()` removes the copies older versions installed.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where versions up to 1.1.3 installed the bundle. */
const LEGACY_AGENTS_DIR = join(homedir(), '.claude', 'agents');
const LEGACY_MARKER = join(LEGACY_AGENTS_DIR, '.octoally-installed');

export interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  model?: string;
}

export interface BundledAgent {
  /** File name including extension, e.g. `code-reviewer.md`. */
  filename: string;
  /** Frontmatter `name` — what `--agent` is called with. May differ from the
   *  filename (`code-reviewer.md` declares `code-reviewer-pro`). */
  name: string;
  description: string;
  path: string;
  content: string;
}

/**
 * Parse an agent .md into frontmatter + body.
 * Deliberately minimal: only the single-line `key: value` form the bundle uses.
 * User-authored agents may use richer YAML, which is why they are still handed
 * to the CLI by name and resolved natively rather than parsed here.
 */
export function parseAgentFrontmatter(content: string): { fm: AgentFrontmatter; body: string } | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const [, block, rawBody] = m;

  const fm: AgentFrontmatter = {};
  for (const line of block.split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    if (key === 'name') fm.name = value;
    else if (key === 'description') fm.description = value;
    else if (key === 'model') fm.model = value;
    else if (key === 'tools') fm.tools = value.split(',').map(t => t.trim()).filter(Boolean);
  }

  return { fm, body: rawBody.trim() };
}

let cache: BundledAgent[] | null = null;

/** Read every bundled agent .md. Cached — the bundle can't change at runtime. */
export function getBundledAgents(): BundledAgent[] {
  if (cache) return cache;

  const dirs = [
    join(__dirname, 'agents'),                // dist/data/agents/ (prod), src/data/agents/ (dev)
    join(__dirname, '..', 'data', 'agents'),  // fallback
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir).filter(f => f.endsWith('.md')); } catch { continue; }
    if (files.length === 0) continue;

    const agents: BundledAgent[] = [];
    for (const filename of files) {
      const path = join(dir, filename);
      let content: string;
      try { content = readFileSync(path, 'utf-8'); } catch { continue; }
      const parsed = parseAgentFrontmatter(content);
      agents.push({
        filename,
        name: parsed?.fm.name || filename.replace(/\.md$/, ''),
        description: parsed?.fm.description || '',
        path,
        content,
      });
    }
    cache = agents;
    return agents;
  }

  cache = [];
  return cache;
}

/**
 * Resolve `<name>.md` inside a directory, falling back to a scan for a file
 * whose frontmatter declares that name — which is how Claude Code resolves
 * agents, and how the four bundled files whose name differs from their
 * filename are found.
 */
export function findAgentMdIn(dir: string, agentName: string): string | null {
  const direct = join(dir, `${agentName}.md`);
  if (existsSync(direct)) return direct;

  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return null; }
  for (const f of files) {
    try {
      const parsed = parseAgentFrontmatter(readFileSync(join(dir, f), 'utf-8'));
      if (parsed?.fm.name === agentName) return join(dir, f);
    } catch { /* unreadable — skip */ }
  }
  return null;
}

/** Path of a bundled agent, by frontmatter name or file name. */
export function findBundledAgentPath(agentName: string): string | null {
  const agents = getBundledAgents();
  const byName = agents.find(a => a.name === agentName);
  if (byName) return byName.path;
  const byFile = agents.find(a => a.filename === `${agentName}.md`);
  return byFile ? byFile.path : null;
}

/**
 * One-shot migration: delete the copies an older OctoAlly wrote into
 * `~/.claude/agents/`, so they stop costing context in every Claude Code
 * session on this machine.
 *
 * Only runs when our marker file is there (proof we installed them), and only
 * removes files that are still byte-for-byte identical to the bundle —
 * anything the user edited, renamed or added themselves is left alone.
 */
export function cleanupInstalledAgents(): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];

  if (!existsSync(LEGACY_MARKER)) return { removed, kept };

  for (const { filename, content } of getBundledAgents()) {
    const dest = join(LEGACY_AGENTS_DIR, filename);
    if (!existsSync(dest)) continue;
    try {
      if (readFileSync(dest, 'utf-8') !== content) { kept.push(filename); continue; }
      rmSync(dest);
      removed.push(filename);
    } catch {
      kept.push(filename);
    }
  }

  try { rmSync(LEGACY_MARKER); } catch { /* non-fatal */ }

  return { removed, kept };
}
