/**
 * Model discovery — produces the list of selectable Claude model identifiers
 * for the OctoAlly UI.
 *
 * Sources (merged):
 *   1. Stable aliases (`opus`, `sonnet`, `haiku`) — the Claude CLI resolves
 *      these to the current flagship of each family, so a user picking
 *      "opus" today automatically rides future releases.
 *   2. Concrete model IDs harvested from ~/.claude.json `lastModelUsage`
 *      entries across all projects. Anything the user has actually invoked
 *      is guaranteed reachable with their current auth/tier.
 *
 * Users can also enter a free-form model ID ("Custom...") in the picker —
 * that value is passed straight to `claude --model <x>`.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface ModelEntry {
  id: string;
  kind: 'alias' | 'discovered';
  family?: 'opus' | 'sonnet' | 'haiku';
  has1m?: boolean;
}

const ALIASES: ModelEntry[] = [
  { id: 'opus', kind: 'alias', family: 'opus' },
  { id: 'sonnet', kind: 'alias', family: 'sonnet' },
  { id: 'haiku', kind: 'alias', family: 'haiku' },
];

function familyOf(id: string): 'opus' | 'sonnet' | 'haiku' | undefined {
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return undefined;
}

/**
 * Walk ~/.claude.json → projects.*.lastModelUsage keys. Returns unique model
 * IDs sorted: opus first, then sonnet, then haiku; within a family newest
 * (1m-variant preferred) first.
 */
function discoverFromClaudeJson(): ModelEntry[] {
  const p = join(homedir(), '.claude.json');
  let raw: string;
  try { raw = readFileSync(p, 'utf-8'); } catch { return []; }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }

  const projects = (parsed as { projects?: Record<string, { lastModelUsage?: Record<string, unknown> }> })?.projects;
  if (!projects || typeof projects !== 'object') return [];

  const seen = new Set<string>();
  for (const proj of Object.values(projects)) {
    const usage = proj?.lastModelUsage;
    if (!usage || typeof usage !== 'object') continue;
    for (const id of Object.keys(usage)) {
      if (typeof id === 'string' && id.startsWith('claude-')) seen.add(id);
    }
  }

  const list: ModelEntry[] = [];
  for (const id of seen) {
    list.push({
      id,
      kind: 'discovered',
      family: familyOf(id),
      has1m: id.includes('[1m]'),
    });
  }

  const familyOrder = { opus: 0, sonnet: 1, haiku: 2 } as const;
  list.sort((a, b) => {
    const fa = a.family ? familyOrder[a.family] : 99;
    const fb = b.family ? familyOrder[b.family] : 99;
    if (fa !== fb) return fa - fb;
    // Prefer 1m variants first within a family
    if (!!a.has1m !== !!b.has1m) return a.has1m ? -1 : 1;
    return b.id.localeCompare(a.id); // newer-looking ID first (lexicographic desc)
  });
  return list;
}

/** Simple in-process cache — refreshed on demand from the routes layer. */
let cached: { entries: ModelEntry[]; at: number } | null = null;
const CACHE_MS = 30_000;

export function listModels(opts?: { refresh?: boolean }): ModelEntry[] {
  if (!opts?.refresh && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.entries;
  }
  const discovered = discoverFromClaudeJson();
  const entries = [...ALIASES, ...discovered];
  cached = { entries, at: Date.now() };
  return entries;
}

/** Resolve picker input → CLI flag arg, or empty string to skip `--model`. */
export function normalizeModelForCli(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed;
}
