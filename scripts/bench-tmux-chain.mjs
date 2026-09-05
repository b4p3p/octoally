#!/usr/bin/env node
/**
 * bench-tmux-chain.mjs — measures OctoAlly's terminal round-trip WITHOUT the UI.
 *
 * It replicates the exact server-side chain a keystroke travels through:
 *
 *   node-pty(tmux attach-session)  ->  tmux server  ->  pane pty (tty echo)
 *     ->  tmux server  ->  pipe-pane -O  ->  `cat > fifo`  ->  fifo reader
 *
 * The pane runs `cat`, so the only "application" in the loop is the tty line
 * discipline echoing the byte back: whatever this reports is pure transport
 * cost of tmux + pipe-pane + fifo, with no Claude Code, no browser, no
 * WebSocket, no display server.  That makes it directly comparable between two
 * machines with different tmux versions.
 *
 * It uses its own tmux socket and its own fifo, so it never touches a live
 * OctoAlly session (attaching a measurement to an OctoAlly pane with pipe-pane
 * would replace OctoAlly's own pipe and mute the session).
 *
 * Usage:  node scripts/bench-tmux-chain.mjs [iterations]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '../server/'));
let pty;
try {
  pty = require('node-pty-prebuilt-multiarch');
} catch {
  console.error('node-pty-prebuilt-multiarch not found. Run `npm install` in server/ first.');
  process.exit(1);
}

const ITER = Number(process.argv[2] || 200);
const SOCKET = 'oa-bench';
const SESSION = 'bench';
const DIR = join(tmpdir(), 'octoally-bench');
mkdirSync(DIR, { recursive: true });
const FIFO = join(DIR, 'bench.fifo');

const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
const quiet = (...args) => { try { tmux(...args); } catch { /* ignore */ } };

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  const version = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout.trim();
  console.log(`tmux:   ${version}`);
  console.log(`node:   ${process.version}`);
  console.log(`iter:   ${ITER}`);

  quiet('kill-session', '-t', SESSION);
  try { unlinkSync(FIFO); } catch { /* ignore */ }
  execFileSync('mkfifo', [FIFO]);

  // Same geometry OctoAlly uses for a full-window terminal, so the redraw cost
  // per byte is in the same ballpark on both machines.
  tmux('new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50', 'cat');

  const reader = createReadStream(FIFO, { encoding: 'utf8' });
  const arrivals = [];
  reader.on('data', (chunk) => {
    const t = process.hrtime.bigint();
    for (const ch of chunk) arrivals.push({ ch, t });
  });
  reader.on('error', (e) => console.error('fifo error:', e.message));

  // Exactly the invocation in pty-worker.ts:250
  tmux('pipe-pane', '-O', '-t', SESSION, `cat > ${FIFO}`);

  // The PTY OctoAlly holds is a tmux *client*, not the pane itself.
  const term = pty.spawn('tmux', ['-L', SOCKET, 'attach-session', '-t', SESSION], {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: process.cwd(),
    env: process.env,
  });
  let clientBytes = 0;
  term.onData((d) => { clientBytes += d.length; });

  await new Promise((r) => setTimeout(r, 800)); // let attach settle and drain

  const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
  const samples = [];
  const missed = [];

  for (let i = 0; i < ITER; i++) {
    const ch = ALPHA[i % ALPHA.length];
    arrivals.length = 0;
    const sent = process.hrtime.bigint();
    term.write(ch);

    const hit = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(null), 1000);
      const poll = setInterval(() => {
        const found = arrivals.find((a) => a.ch === ch);
        if (found) { clearInterval(poll); clearTimeout(deadline); resolve(found.t); }
      }, 0);
    });

    if (hit === null) missed.push(i);
    else samples.push(Number(hit - sent) / 1e6);

    await new Promise((r) => setTimeout(r, 15)); // don't coalesce consecutive keys
  }

  term.write('\x03');
  await new Promise((r) => setTimeout(r, 150));
  term.kill();
  reader.destroy();
  quiet('pipe-pane', '-t', SESSION);
  quiet('kill-session', '-t', SESSION);
  quiet('kill-server');
  try { unlinkSync(FIFO); } catch { /* ignore */ }
  try { unlinkSync(join(tmpdir(), `tmux-${process.getuid()}`, SOCKET)); } catch { /* ignore */ }

  const s = samples.slice().sort((a, b) => a - b);
  const f = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
  console.log('');
  console.log('round-trip  write(pty) -> tmux -> tty echo -> pipe-pane -> fifo   [ms]');
  console.log(`  samples : ${s.length}   lost: ${missed.length}`);
  console.log(`  min     : ${f(s[0])}`);
  console.log(`  p50     : ${f(pct(s, 0.5))}`);
  console.log(`  p90     : ${f(pct(s, 0.9))}`);
  console.log(`  p99     : ${f(pct(s, 0.99))}`);
  console.log(`  max     : ${f(s[s.length - 1])}`);
  console.log(`  mean    : ${f(s.reduce((a, b) => a + b, 0) / (s.length || 1))}`);
  console.log('');
  console.log(`client redraw bytes on the attach pty: ${clientBytes}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
