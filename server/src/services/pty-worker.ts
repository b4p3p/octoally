/**
 * PTY Worker — runs as a separate child process per session.
 *
 * Handles all blocking PTY/tmux/pipe-pane operations so they don't
 * starve the main Fastify server's event loop.
 *
 * IPC Protocol:
 *   Parent → Worker: spawn, reconnect, input, resize, kill, replay
 *   Worker → Parent: ready, output, exit, error, replay-chunk, replay-end
 */

import * as pty from 'node-pty-prebuilt-multiarch';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, unlinkSync, mkdirSync, createReadStream, readFileSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { ReadStream } from 'fs';

const execFileAsync = promisify(execFile);

/** Build a clean env for user-facing sessions: strip NODE_ENV so the server's
 *  production mode doesn't leak into user terminals / Claude Code / dev servers. */
function sessionEnv(): Record<string, string> {
  const { NODE_ENV, ...rest } = process.env;
  return {
    ...rest,
    TERM: 'xterm-256color',
    OCTOALLY_SESSION: '1',
    HEADLESS_WORKERS_DISABLED: '1',
  };
}

const TIMING_LOG = '/tmp/octoally-timing.log';
function tlog(s: string): void {
  try { appendFileSync(TIMING_LOG, `[${new Date().toISOString()}] ${s}\n`); } catch {}
}

/* ================================================================
   Types
   ================================================================ */

interface SpawnMessage {
  type: 'spawn';
  sessionId: string;
  projectPath: string;
  task: string;
  mode: 'session' | 'terminal' | 'agent';
  agentType?: string;
  sessionCommand?: string;
  cliType?: 'claude' | 'codex';
  model?: string; // resolved model identifier — appended as --model flag
  cols: number;
  rows: number;
  useTmux: boolean;
  useDtach: boolean;
  workingDir?: string;
}

interface ReconnectMessage {
  type: 'reconnect';
  sessionId: string;
  cols: number;
  rows: number;
  useTmux: boolean;
  useDtach: boolean;
}

interface AdoptMessage {
  type: 'adopt';
  sessionId: string;
  socketPath: string;
  projectPath: string;
  cols: number;
  rows: number;
  useTmux: boolean;
}

type ParentMessage =
  | SpawnMessage
  | ReconnectMessage
  | AdoptMessage
  | { type: 'input'; data: string; bracketedPaste?: boolean }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'capture' }
  | { type: 'kill' }
  | { type: 'release' };

/* ================================================================
   tmux helpers (same as session-manager but local to worker)
   ================================================================ */

const TMUX_SERVER = 'octoally';
const LEGACY_TMUX_SERVERS = ['hivecommand', 'openflow'];
const tmuxBaseArgs = ['-L', TMUX_SERVER];

function tmuxSessionName(sessionId: string): string {
  return `of-${sessionId}`;
}

/** Find which tmux server hosts a session (checks legacy servers too) */
function findTmuxServer(sessionId: string): string | null {
  const name = tmuxSessionName(sessionId);
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      execFileSync('tmux', ['-L', server, 'has-session', '-t', name], { stdio: 'ignore' });
      return server;
    } catch { /* try next */ }
  }
  return null;
}

function tmuxExists(sessionId: string): boolean {
  return findTmuxServer(sessionId) !== null;
}

async function tmuxCreate(
  sessionId: string,
  projectPath: string,
  cols: number,
  rows: number,
  command?: string,
): Promise<void> {
  const name = tmuxSessionName(sessionId);
  if (tmuxExists(sessionId)) {
    try { execFileSync('tmux', [...tmuxBaseArgs, 'kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* ignore */ }
  }

  const shell = process.env.SHELL || '/bin/bash';
  // Wrap the shell invocation with env -u NODE_ENV to strip it before the shell starts,
  // since tmux new-session -d inherits from the tmux server's env, not the client's.
  const envCmd = 'env';
  const envArgs = ['-u', 'NODE_ENV'];
  const runArgs = command
    ? [envCmd, ...envArgs, shell, '-i', '-c', command]
    : [envCmd, ...envArgs, shell, '-i'];

  await execFileAsync('tmux', [
    ...tmuxBaseArgs, 'new-session', '-d', '-s', name,
    '-x', String(cols), '-y', String(rows),
    ...runArgs,
  ], {
    cwd: projectPath,
    env: sessionEnv(),
  });

  try {
    // Also strip NODE_ENV from the tmux server's global env for any future windows/panes
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-environment', '-g', '-u', 'NODE_ENV']);
  } catch { /* best effort */ }

  try {
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-s', 'terminal-overrides', 'xterm-256color:smcup@:rmcup@']);
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-t', name, 'status', 'off']);
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-t', name, 'history-limit', '50000']);
  } catch { /* best effort */ }
}

async function tmuxKill(sessionId: string): Promise<void> {
  const name = tmuxSessionName(sessionId);
  // Kill on whichever server hosts it (may be legacy)
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      await execFileAsync('tmux', ['-L', server, 'kill-session', '-t', name]);
      return;
    } catch { /* try next */ }
  }
}

/* ================================================================
   dtach helpers
   ================================================================ */

function dtachSocket(sessionId: string): string {
  // Check legacy prefixes for existing sessions
  for (const prefix of ['octoally-', 'hivecommand-', 'openflow-']) {
    const sock = `/tmp/${prefix}${sessionId}.sock`;
    if (existsSync(sock)) return sock;
  }
  return `/tmp/octoally-${sessionId}.sock`;
}

function dtachExists(sessionId: string): boolean {
  const sock = dtachSocket(sessionId);
  if (!existsSync(sock)) return false;
  try {
    const stdout = execFileSync('fuser', [sock], { encoding: 'utf8' });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function dtachCreate(sessionId: string, projectPath: string, command: string): Promise<void> {
  const sock = dtachSocket(sessionId);
  if (existsSync(sock)) {
    try { unlinkSync(sock); } catch { /* ignore */ }
  }
  const shell = process.env.SHELL || '/bin/bash';
  await execFileAsync('dtach', [
    '-n', sock, '-Ez', shell, '-i', '-c', command,
  ], {
    cwd: projectPath,
    env: sessionEnv(),
  });
}

async function dtachKill(sessionId: string): Promise<void> {
  const sock = dtachSocket(sessionId);
  try {
    const { stdout } = await execFileAsync('fuser', [sock]);
    const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* dead */ }
    }
    setTimeout(() => {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* dead */ }
      }
    }, 2000);
  } catch { /* fuser failed */ }
  try { unlinkSync(sock); } catch { /* ignore */ }
}

/* ================================================================
   pipe-pane: capture raw application output via FIFO
   ================================================================ */

const PIPE_PANE_DIR = join(tmpdir(), 'octoally-pipes');
mkdirSync(PIPE_PANE_DIR, { recursive: true });

function setupPipePane(sessionId: string, server?: string): { stream: ReadStream; fifoPath: string } | null {
  const name = tmuxSessionName(sessionId);
  const serverArgs = ['-L', server || TMUX_SERVER];
  const fifoPath = join(PIPE_PANE_DIR, `${sessionId}.fifo`);

  try {
    try { unlinkSync(fifoPath); } catch { /* doesn't exist */ }
    execFileSync('mkfifo', [fifoPath]);
    const stream = createReadStream(fifoPath, { encoding: 'utf8' });
    execFileSync('tmux', [...serverArgs, 'pipe-pane', '-O', '-t', name, `cat > ${fifoPath}`]);
    return { stream, fifoPath };
  } catch (err) {
    console.error(`[PTY-WORKER] pipe-pane setup failed for ${sessionId}:`, err);
    try { unlinkSync(fifoPath); } catch { /* ignore */ }
    return null;
  }
}

function cleanupPipePane(sessionId: string, fifoPath?: string): void {
  const name = tmuxSessionName(sessionId);
  const server = findTmuxServer(sessionId) || TMUX_SERVER;
  try { execFileSync('tmux', ['-L', server, 'pipe-pane', '-t', name]); } catch { /* ignore */ }
  const path = fifoPath || join(PIPE_PANE_DIR, `${sessionId}.fifo`);
  try { unlinkSync(path); } catch { /* ignore */ }
}

/* ================================================================
   session command builder
   ================================================================ */

/** Shell-quote a model identifier so brackets / exotic chars in e.g. `opus[1m]`
 *  survive the outer sh -c / tmux quoting layers unmangled. */
function modelFlag(model: string | undefined, cliType: 'claude' | 'codex'): string {
  if (!model || cliType !== 'claude') return '';
  const escaped = model.replace(/'/g, "'\\''");
  return ` --model '${escaped}'`;
}

function buildSessionCommand(task: string, direct = false, sessionCmd = '', cliType: 'claude' | 'codex' = 'claude', model = ''): string {
  const escaped = task.replace(/'/g, "'\\''");
  if (cliType === 'codex') {
    // --no-alt-screen prevents Codex from using the alternate screen buffer,
    // which fixes resize/reflow issues in tmux and embedded terminals
    const baseCmd = sessionCmd || 'codex';
    const cmd = `${baseCmd} --no-alt-screen '${escaped}'`;
    if (direct) {
      return `command bash -c '${cmd.replace(/'/g, "'\\''")}'`;
    }
    return cmd;
  }
  // Claude: launch with configured command (may include flags like --dangerously-skip-permissions)
  const baseCmd = sessionCmd || 'claude';
  const cmd = `${baseCmd}${modelFlag(model, cliType)} '${escaped}'`;
  if (direct) {
    return `command ${cmd}`;
  }
  return cmd;
}

/* ================================================================
   Agent .md parser — extracts portable role/expertise/capabilities
   from .claude/agents/<name>.md so Codex (which has no native
   --agent support) can be given a richer persona prompt than just
   "You are a <name> agent". Claude continues to use --agent natively.
   ================================================================
   Convention follows the lst97 / wshobson sub-agent template:
     **Role**: <inline>
     **Expertise**: <inline>
     **Key Capabilities**:
       - bullet
       - bullet
     **MCP Integration**:    ← skipped (Claude-only)
   Sections referencing mcp__* tools or "Use PROACTIVELY..." meta
   are pruned — they're noise for Codex.

   Optional frontmatter overrides for users who want fine control:
     description_codex: <single-line description override>
     prompt_codex:      <single-line full prompt override; supports {{task}}>
*/

interface ParsedAgent {
  description?: string;
  descriptionCodex?: string;
  promptCodex?: string;
  role?: string;
  expertise?: string;
  capabilities: string[];
}

function findAgentMdPath(agentType: string, projectPath: string): string | null {
  const candidates = [
    join(projectPath, '.claude', 'agents', `${agentType}.md`),
    join(homedir(), '.claude', 'agents', `${agentType}.md`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function parseAgentMd(mdPath: string): ParsedAgent | null {
  let content: string;
  try { content = readFileSync(mdPath, 'utf-8'); } catch { return null; }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const [, fmBlock, body] = fmMatch;

  const result: ParsedAgent = { capabilities: [] };

  // Frontmatter — simple key: value (matches the existing parser in projects.ts:914)
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'description') result.description = value;
    else if (key === 'description_codex') result.descriptionCodex = value;
    else if (key === 'prompt_codex') result.promptCodex = value;
  }

  result.role = extractInlineSection(body, 'Role');
  result.expertise = extractInlineSection(body, 'Expertise');
  result.capabilities = extractBulletSection(body, 'Key Capabilities');

  return result;
}

/** Match `**Label**: <text>` continuing on subsequent indented lines until a blank line or new bold/heading. */
function extractInlineSection(body: string, label: string): string | undefined {
  const re = new RegExp(`\\*\\*${label}\\*\\*:\\s*([^\\n]+)`, 'm');
  const m = body.match(re);
  if (!m) return undefined;
  const value = m[1].trim();
  // Drop the section if it references mcp__ tools (Claude-specific noise).
  if (value.includes('mcp__')) return undefined;
  return value;
}

/** Match `**Label**:` followed by `- bullet` lines until next bold/heading. */
function extractBulletSection(body: string, label: string): string[] {
  const startRe = new RegExp(`\\*\\*${label}\\*\\*:`, 'm');
  const startMatch = body.match(startRe);
  if (!startMatch || startMatch.index == null) return [];
  const after = body.slice(startMatch.index + startMatch[0].length);
  const bullets: string[] = [];
  let started = false;
  for (const raw of after.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*-\s+/.test(line)) {
      const text = line.replace(/^\s*-\s+/, '').trim();
      if (text.includes('mcp__')) continue; // skip MCP-tool bullets
      bullets.push(text);
      started = true;
    } else if (started && line.trim() === '') {
      continue; // tolerate intra-list blank lines
    } else if (started) {
      break; // hit non-bullet content — section ended
    }
    // before first bullet: skip blank/intro lines
  }
  return bullets;
}

/** Strip the Claude-specific "Use PROACTIVELY ..." meta-instruction from a description. */
function cleanDescriptionForCodex(desc: string): string {
  return desc.replace(/\s*Use\s+PROACTIVELY[^.]*\.?/gi, '').trim();
}

function buildCodexAgentPrompt(agentType: string, task: string, projectPath: string): string {
  const fallbackTask = task || 'Ask me what I want you to do and NOTHING ELSE.';
  const fallback = task
    ? `You are a ${agentType} agent. ${task}`
    : `You are a ${agentType} agent. Ask me what I want you to do.`;

  const mdPath = findAgentMdPath(agentType, projectPath);
  if (!mdPath) return fallback;
  const parsed = parseAgentMd(mdPath);
  if (!parsed) return fallback;

  // Explicit override beats convention-based extraction.
  if (parsed.promptCodex) {
    return parsed.promptCodex.includes('{{task}}')
      ? parsed.promptCodex.replace(/\{\{task\}\}/g, fallbackTask)
      : `${parsed.promptCodex}\n\nUser request: ${fallbackTask}`;
  }

  const roleLine = parsed.role
    ?? parsed.descriptionCodex
    ?? (parsed.description ? cleanDescriptionForCodex(parsed.description) : '');

  const lines: string[] = [`You are the ${agentType} agent.`];
  if (roleLine) lines.push('', `Role: ${roleLine}`);
  if (parsed.expertise) lines.push('', `Expertise: ${parsed.expertise}`);
  if (parsed.capabilities.length > 0) {
    lines.push('', 'Key capabilities:');
    for (const c of parsed.capabilities) lines.push(`- ${c}`);
  }

  // Nothing extracted beyond the name? Return the simple fallback to avoid an awkward header-only prompt.
  if (lines.length === 1) return fallback;

  lines.push('', '---', '', `User request: ${fallbackTask}`);
  return lines.join('\n');
}

function buildAgentCommand(agentType: string, task: string, direct = false, sessionCmd = '', cliType: 'claude' | 'codex' = 'claude', projectPath = '', model = ''): string {
  const escapedType = agentType.replace(/'/g, "'\\''");
  const escapedTask = task.replace(/'/g, "'\\''");

  let cmd: string;
  if (cliType === 'codex') {
    const baseCmd = sessionCmd || 'codex';
    // Codex CLI has no --agent flag. Build a richer persona prompt by
    // extracting portable sections from the .claude/agents/<name>.md file
    // (skipping Claude-specific MCP / "Use PROACTIVELY" content).
    const prompt = buildCodexAgentPrompt(agentType, task, projectPath);
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    cmd = `${baseCmd} --no-alt-screen '${escapedPrompt}'`;
  } else {
    const baseCmd = sessionCmd || 'claude';
    const mf = modelFlag(model, cliType);
    // Claude CLI uses --agent to load agent definitions from .claude/agents/
    cmd = task
      ? `${baseCmd}${mf} --agent '${escapedType}' '${escapedTask}'`
      : `${baseCmd}${mf} --agent '${escapedType}'`;
  }

  if (direct) {
    return `command bash -c '${cmd.replace(/'/g, "'\\''")}'`;
  }
  return cmd;
}

/* ================================================================
   Terminal response filter
   ================================================================ */

const TERMINAL_RESPONSE_RE = /\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\d+n|\x1b\[\d+;\d+R/g;

// Focus reporting sequences — strip from PTY output so TUI programs (Codex)
// can't enable focus reporting on xterm.js.  When focus reporting is active,
// xterm.js sends \x1b[I / \x1b[O on focus/blur, which causes rendering
// corruption when switching terminal tabs or toggling grid/single view.
const FOCUS_REPORT_RE = /\x1b\[\?1004[hl]/g;

/* ================================================================
   Worker state
   ================================================================ */

let ptyProcess: pty.IPty | null = null;
let pipePaneStream: ReadStream | null = null;
let pipePaneFifo: string | null = null;
let currentSessionId: string | null = null;
let hasPipePane = false;
let useTmux = false;
let useDtach = false;

function send(msg: Record<string, unknown>): void {
  if (process.send) {
    process.send(msg);
  }
}

function wireOutput(): void {
  if (!ptyProcess) return;

  ptyProcess.onData((data: string) => {
    // Always send PTY output for state tracking in the parent
    send({ type: 'pty-data', data });

    if (!hasPipePane) {
      // No pipe-pane: PTY output IS the display output.
      // Strip focus reporting sequences so TUIs can't enable focus events on the client xterm.
      const filtered = data.replace(FOCUS_REPORT_RE, '');
      if (filtered) send({ type: 'output', data: filtered });
    }
  });

  if (pipePaneStream) {
    pipePaneStream.on('data', (chunk: string | Buffer) => {
      const raw = typeof chunk === 'string' ? chunk : chunk.toString();
      const data = raw.replace(FOCUS_REPORT_RE, '');
      if (data) send({ type: 'output', data });
    });

    pipePaneStream.on('error', (err) => {
      console.error(`[PTY-WORKER] pipe-pane stream error:`, err.message);
    });

    pipePaneStream.on('end', () => {
      // pipe-pane writer disconnected — the tmux session may have ended
    });
  }

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (pipePaneStream) {
      pipePaneStream.destroy();
      if (currentSessionId) cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
    send({ type: 'exit', exitCode, signal });
    // Give parent time to process the exit message before dying
    setTimeout(() => process.exit(0), 500);
  });
}

/* ================================================================
   Spawn handlers
   ================================================================ */

async function handleSpawn(msg: SpawnMessage): Promise<void> {
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;
  useDtach = msg.useDtach;
  const shell = process.env.SHELL || '/bin/bash';
  const sessionCmd = msg.sessionCommand || 'claude';
  const cliType = msg.cliType || 'claude';
  const model = msg.model || '';

  try {
    if (msg.mode === 'terminal') {
      if (msg.useTmux) {
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else if (msg.useDtach) {
        await dtachCreate(msg.sessionId, msg.projectPath, shell);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else {
        ptyProcess = pty.spawn(shell, ['-i'], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      }
    } else if (msg.mode === 'agent' && msg.agentType) {
      // agent mode — launch CLI with --agent flag
      const command = buildAgentCommand(msg.agentType, msg.task, msg.useTmux, sessionCmd, cliType, msg.projectPath, model);
      if (msg.useTmux) {
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, command);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else if (msg.useDtach) {
        await dtachCreate(msg.sessionId, msg.projectPath, command);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else {
        ptyProcess = pty.spawn(shell, ['-i', '-c', command], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      }
    } else {
      // session mode
      if (msg.useTmux) {
        const command = buildSessionCommand(msg.task, true, sessionCmd, cliType, model);
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, command);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else if (msg.useDtach) {
        const command = buildSessionCommand(msg.task, false, sessionCmd, cliType, model);
        await dtachCreate(msg.sessionId, msg.projectPath, command);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else {
        const command = buildSessionCommand(msg.task, false, sessionCmd, cliType, model);
        ptyProcess = pty.spawn(shell, ['-i', '-c', command], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      }
    }

    wireOutput();
    send({ type: 'ready', pid: ptyProcess.pid });
  } catch (err: any) {
    send({ type: 'error', message: `Spawn failed: ${err.message}` });
    process.exit(1);
  }
}

async function handleReconnect(msg: ReconnectMessage): Promise<void> {
  const t0 = Date.now();
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;
  useDtach = msg.useDtach;

  try {
    const hasTmuxSession = msg.useTmux && tmuxExists(msg.sessionId);
    const hasDtachSession = msg.useDtach && dtachExists(msg.sessionId);
    const log = (s: string) => appendFileSync('/tmp/octoally-timing.log', s + '\n');
    log(`[PTY-WORKER] ${msg.sessionId}: exists_check=${Date.now()-t0}ms`);

    if (!hasTmuxSession && !hasDtachSession) {
      send({ type: 'error', message: 'No tmux or dtach session found to reconnect' });
      process.exit(1);
      return;
    }

    if (hasTmuxSession) {
      const t2 = Date.now();
      const actualServer = findTmuxServer(msg.sessionId) || TMUX_SERVER;
      const serverArgs = ['-L', actualServer];
      const pp = setupPipePane(msg.sessionId, actualServer);
      log(`[PTY-WORKER] ${msg.sessionId}: pipe_pane=${Date.now()-t2}ms (server=${actualServer})`);
      if (pp) {
        pipePaneStream = pp.stream;
        pipePaneFifo = pp.fifoPath;
        hasPipePane = true;
      }
      const t3 = Date.now();
      ptyProcess = pty.spawn('tmux', [...serverArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows,
        env: sessionEnv(),
      });
      log(`[PTY-WORKER] ${msg.sessionId}: pty_spawn=${Date.now()-t3}ms`);
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows,
        env: sessionEnv(),
      });
    }

    wireOutput();
    console.log(`[PTY-WORKER] ${msg.sessionId}: total_reconnect=${Date.now()-t0}ms`);
    send({ type: 'ready', pid: ptyProcess.pid, tmux: hasTmuxSession });
  } catch (err: any) {
    console.log(`[PTY-WORKER] ${msg.sessionId}: reconnect_failed=${Date.now()-t0}ms err=${err.message}`);
    send({ type: 'error', message: `Reconnect failed: ${err.message}` });
    process.exit(1);
  }
}

async function handleAdopt(msg: AdoptMessage): Promise<void> {
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;

  try {
    // Use -r none on initial attach — the browser's resize will trigger SIGWINCH
    // naturally through tmux, causing the app to redraw at the correct size.
    if (msg.useTmux) {
      await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, `dtach -a ${msg.socketPath} -r none -Ez`);
      await new Promise(r => setTimeout(r, 100));
      const pp = setupPipePane(msg.sessionId);
      if (pp) {
        pipePaneStream = pp.stream;
        pipePaneFifo = pp.fifoPath;
        hasPipePane = true;
      }
      ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
        env: sessionEnv(),
      });
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${msg.socketPath} -r none -Ez`], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
        env: sessionEnv(),
      });
    }

    wireOutput();
    send({ type: 'ready', pid: ptyProcess.pid });

    // Force a redraw: -r none starts blank, so do a cols-1→cols resize trick
    // to trigger SIGWINCH through dtach, making the app re-render its screen.
    // Delay to let pipe-pane fully initialize and start capturing.
    setTimeout(() => {
      if (ptyProcess && msg.useTmux) {
        try {
          execFileSync('tmux', [
            ...tmuxBaseArgs, 'resize-pane', '-t', tmuxSessionName(msg.sessionId), '-x', String(msg.cols - 1),
          ], { stdio: 'ignore' });
          setTimeout(() => {
            try {
              execFileSync('tmux', [
                ...tmuxBaseArgs, 'resize-pane', '-t', tmuxSessionName(msg.sessionId), '-x', String(msg.cols),
              ], { stdio: 'ignore' });
            } catch { /* ignore */ }
          }, 50);
        } catch { /* ignore */ }
      } else if (ptyProcess) {
        // Non-tmux: resize the PTY directly
        try {
          ptyProcess.resize(msg.cols - 1, msg.rows);
          setTimeout(() => {
            try { ptyProcess!.resize(msg.cols, msg.rows); } catch { /* ignore */ }
          }, 50);
        } catch { /* ignore */ }
      }
    }, 300);
  } catch (err: any) {
    send({ type: 'error', message: `Adopt failed: ${err.message}` });
    process.exit(1);
  }
}

function handleInput(data: string, isBracketedPaste = false): void {
  if (!ptyProcess) return;
  const cleaned = data.replace(TERMINAL_RESPONSE_RE, '');
  if (!cleaned) return;
  if (isBracketedPaste) {
    // Wrap in bracketed paste escape sequences so the shell/readline treats
    // the entire block as pasted text rather than executing each line
    ptyProcess.write(`\x1b[200~${cleaned}\x1b[201~`);
  } else {
    ptyProcess.write(cleaned);
  }
}

function handleResize(cols: number, rows: number): void {
  if (!ptyProcess) return;
  ptyProcess.resize(cols, rows);
}

/** Capture the current tmux pane content (with escape sequences) and send via IPC.
 *  This runs in the worker process so the blocking execFileSync doesn't affect
 *  the main server event loop. */
function handleCapture(): void {
  const t0 = Date.now();
  tlog(`[WORKER-CAPTURE] ${currentSessionId}: start`);
  if (!currentSessionId || !useTmux) {
    send({ type: 'capture', data: null });
    return;
  }

  // Pause pipe-pane stream to stop new output messages from entering IPC.
  if (pipePaneStream) pipePaneStream.pause();

  // Wait for any already-queued IPC writes to flush, then send capture.
  // Without this, the parent receives capture ~2.5s late due to output message flood.
  setImmediate(() => {
    const name = tmuxSessionName(currentSessionId!);
    try {
      const output = execFileSync('tmux', [
        ...tmuxBaseArgs, 'capture-pane', '-t', name, '-p', '-e', '-T',
      ], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: tmux=${Date.now()-t0}ms, bytes=${output.length}`);
      send({ type: 'capture', data: output });
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: sent, total=${Date.now()-t0}ms`);
    } catch {
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: failed, total=${Date.now()-t0}ms`);
      send({ type: 'capture', data: null });
    }

    // Resume pipe-pane after capture is queued
    setImmediate(() => {
      if (pipePaneStream) pipePaneStream.resume();
    });
  });
}

async function handleKill(): Promise<void> {
  // Kill PTY process tree
  if (ptyProcess) {
    const pid = ptyProcess.pid;
    try {
      // Kill descendants first
      try {
        const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)]);
        const children = stdout.trim().split('\n').filter(Boolean).map(Number);
        for (const child of children) {
          try { process.kill(child, 'SIGTERM'); } catch { /* dead */ }
        }
      } catch { /* no children */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* dead */ }
      try { process.kill(-pid, 'SIGTERM'); } catch { /* dead */ }
    } catch { /* already dead */ }
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }

  // Kill tmux/dtach sessions
  if (currentSessionId) {
    if (useTmux) {
      await tmuxKill(currentSessionId).catch(() => {});
    }
    if (useDtach) {
      await dtachKill(currentSessionId).catch(() => {});
    }
    // Clean up pipe-pane
    if (pipePaneStream) {
      pipePaneStream.destroy();
      cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
  }

  send({ type: 'killed' });
  setTimeout(() => process.exit(0), 300);
}

/**
 * Release: detach the worker from the tmux/dtach session without killing it.
 * Used by pop-out so an external terminal can attach to the still-running session.
 */
async function handleRelease(): Promise<void> {
  // Kill the PTY process (our tmux attach client / dtach -a client) — this just detaches,
  // the tmux session / dtach master keeps running
  if (ptyProcess) {
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }

  // Clean up pipe-pane (external terminal doesn't need it)
  if (currentSessionId && pipePaneStream) {
    pipePaneStream.destroy();
    cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
  }

  send({ type: 'killed' });
  setTimeout(() => process.exit(0), 300);
}

/* ================================================================
   Main IPC message handler
   ================================================================ */

process.on('message', async (msg: ParentMessage) => {
  switch (msg.type) {
    case 'spawn':
      await handleSpawn(msg);
      break;
    case 'reconnect':
      await handleReconnect(msg);
      break;
    case 'adopt':
      await handleAdopt(msg as AdoptMessage);
      break;
    case 'input':
      handleInput(msg.data, msg.bracketedPaste);
      break;
    case 'resize':
      handleResize(msg.cols, msg.rows);
      break;
    case 'capture':
      handleCapture();
      break;
    case 'kill':
      await handleKill();
      break;
    case 'release':
      await handleRelease();
      break;
  }
});

// If the parent dies, clean up and exit
process.on('disconnect', () => {
  if (ptyProcess) {
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }
  if (currentSessionId) {
    if (pipePaneStream) {
      pipePaneStream.destroy();
      cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
  }
  process.exit(0);
});

// Signal the parent that this worker is ready for messages
send({ type: 'worker-ready' });
