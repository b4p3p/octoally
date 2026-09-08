#!/usr/bin/env node
/**
 * bench-claude-redraw.mjs: how long a keystroke takes to come back as a redraw
 * when the pane runs Claude Code, measured on the tmux + pipe-pane + FIFO chain
 * that every OctoAlly session's output goes through.
 *
 *   keystroke -> tmux -> Claude Code redraw -> pipe-pane -> <copier> -> FIFO
 *
 * The copier is the point of this bench. tmux's pipe-pane needs a command to
 * pipe into, and OctoAlly passes one (`pty-worker.ts`, setupPipePane). Which
 * program that is turns out to matter enormously: on a distribution shipping
 * uutils coreutils instead of GNU (Ubuntu 26.04 makes it the default
 * /usr/bin/cat) `cat` holds pane output back and releases it in bursts, and
 * half the keystrokes wait seconds for their redraw. Measured on one machine,
 * same tmux, same geometry, only this command changed:
 *
 *   cat (uutils 0.8.0)      p50 2245.8 ms   20 of 40 keys over 3 s
 *   cat (GNU coreutils 9.7) p50    2.9 ms   0 over 50 ms
 *   dd bs=65536             p50    2.8 ms   0 over 50 ms   <- what we ship
 *
 * A plain shell does NOT show this: its echo comes back promptly whatever the
 * copier, which is why the defect survived a round of latency work. It takes a
 * TUI that redraws on every keystroke to bring it out, hence Claude Code here.
 *
 * The bench types isolated letters into Claude Code's input box and NEVER
 * presses Enter, so nothing is ever submitted to the model and the run costs
 * nothing. It uses its own tmux socket and its own FIFO, so it cannot disturb a
 * live OctoAlly session (attaching pipe-pane to a session OctoAlly owns would
 * replace the pipe it reads from and mute that session in the UI).
 *
 * Claude Code must already trust the directory the bench runs in, otherwise it
 * opens on the "do you trust this folder?" prompt, where letters do nothing and
 * every sample times out. Run it from a project you have used claude in.
 *
 * Usage:  node scripts/bench-claude-redraw.mjs ["<copier>"] [iterations]
 *   node scripts/bench-claude-redraw.mjs                     # what we ship
 *   node scripts/bench-claude-redraw.mjs cat                 # the slow one
 *   node scripts/bench-claude-redraw.mjs "gnucat" 60
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

// Keep this in sync with setupPipePane() in server/src/services/pty-worker.ts.
const SHIPPED_COPIER = 'dd bs=65536 2>/dev/null';

const COPIER = process.argv[2] || SHIPPED_COPIER;
const ITER = Number(process.argv[3] || 40);
const COLS = 222, ROWS = 48;      // a full-window terminal on a 4K screen
const STARTUP_MS = 25000;         // Claude Code needs a while to draw its box
const KEY_GAP_MS = 250;           // human typing rhythm, not a flood
const TIMEOUT_MS = 3000;          // past this a keystroke is simply lost

const SOCKET = 'oa-claude-bench';
const SESSION = 'bench';
const DIR = join(tmpdir(), 'octoally-bench');
mkdirSync(DIR, { recursive: true });
const FIFO = join(DIR, 'claude-redraw.fifo');

const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
const quiet = (...args) => { try { tmux(...args); } catch { /* ignore */ } };

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  if (!spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout) {
    console.error('claude not on PATH: this bench needs the Claude Code CLI.');
    process.exit(1);
  }
  console.log(`tmux:    ${spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout.trim()}`);
  console.log(`copier:  ${COPIER}`);
  console.log(`cwd:     ${process.cwd()}   (must be a folder claude already trusts)`);
  console.log(`iter:    ${ITER}   geometry: ${COLS}x${ROWS}`);

  quiet('kill-session', '-t', SESSION);
  try { unlinkSync(FIFO); } catch { /* doesn't exist */ }
  execFileSync('mkfifo', [FIFO]);
  tmux('new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', String(ROWS), 'claude');

  const arrivals = [];
  let startupBytes = 0;
  const reader = createReadStream(FIFO, { encoding: 'utf8' });
  reader.on('data', (chunk) => {
    startupBytes += chunk.length;
    arrivals.push({ t: process.hrtime.bigint(), n: chunk.length });
  });
  reader.on('error', (e) => console.error('fifo error:', e.message));

  // Exactly the invocation in pty-worker.ts, with the copier under test.
  tmux('pipe-pane', '-O', '-t', SESSION, `${COPIER} > ${FIFO}`);

  // The PTY OctoAlly holds is a tmux *client*, not the pane itself.
  const term = pty.spawn('tmux', ['-L', SOCKET, 'attach-session', '-t', SESSION], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(), env: process.env,
  });

  console.log(`\nwaiting ${STARTUP_MS / 1000}s for Claude Code to draw its input box...`);
  await new Promise((r) => setTimeout(r, STARTUP_MS));
  const paneCmd = (() => {
    try { return tmux('list-panes', '-t', SESSION, '-F', '#{pane_current_command}').trim(); }
    catch { return '?'; }
  })();
  console.log(`pane runs: ${paneCmd}   bytes drawn during startup: ${startupBytes}`);
  if (paneCmd !== 'claude') console.log('WARNING: the pane is not running claude, samples will be meaningless.');

  const samples = [];
  const lost = [];
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < ITER; i++) {
    arrivals.length = 0;
    const sent = process.hrtime.bigint();
    term.write(ALPHA[i % ALPHA.length]);   // a letter, never Enter

    const hit = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(null), TIMEOUT_MS);
      const poll = setInterval(() => {
        if (arrivals.length) { clearInterval(poll); clearTimeout(deadline); resolve(arrivals[0]); }
      }, 0);
    });

    if (hit === null) { lost.push(i); samples.push(TIMEOUT_MS); }
    else samples.push(Number(hit.t - sent) / 1e6);

    await new Promise((r) => setTimeout(r, KEY_GAP_MS));
  }

  term.write('\x03');                       // clear the typed letters
  await new Promise((r) => setTimeout(r, 200));
  term.kill();
  reader.destroy();
  quiet('pipe-pane', '-t', SESSION);
  quiet('kill-session', '-t', SESSION);
  quiet('kill-server');
  try { unlinkSync(FIFO); } catch { /* ignore */ }

  const s = samples.slice().sort((a, b) => a - b);
  const f = (n) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');
  console.log('\nkeystroke -> first byte of Claude Code redraw out of the FIFO   [ms]');
  console.log(`  samples : ${s.length}   timed out (${TIMEOUT_MS} ms): ${lost.length}`);
  console.log(`  p50     : ${f(pct(s, 0.5))}`);
  console.log(`  p90     : ${f(pct(s, 0.9))}`);
  console.log(`  p99     : ${f(pct(s, 0.99))}`);
  console.log(`  max     : ${f(s[s.length - 1])}`);
  console.log(`  over 50 ms: ${s.filter((x) => x > 50).length}   over 200 ms: ${s.filter((x) => x > 200).length}`);
  console.log('\nHealthy is a p50 of a few ms with nothing over 50 ms. A p90 in the');
  console.log('hundreds means the copier is batching: check which cat is on PATH');
  console.log("(`cat --version`) and what setupPipePane() passes to pipe-pane.");
}

main().catch((e) => {
  console.error(e);
  quiet('kill-session', '-t', SESSION);
  quiet('kill-server');
  try { unlinkSync(FIFO); } catch { /* ignore */ }
  process.exit(1);
});
