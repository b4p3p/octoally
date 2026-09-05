#!/usr/bin/env node
/**
 * probe-ws-latency.mjs — key-to-first-output latency through the real server.
 * Needs a running server (default :42020 = dev:isolated; BASE=http://host:port to override).
 * Creates a throwaway plain terminal in /tmp, attaches over WebSocket, sends 60 isolated
 * keys and a 200-key burst. Section 6.1 of ANALISI-2026-09-05 has the reference numbers.
 */
// End-to-end over the real server: REST create -> WS attach -> isolated keys -> first 'output' frame.
const BASE = process.env.BASE || 'http://localhost:42020';
const r = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ project_path: '/tmp', task: 'Terminal', mode: 'terminal' }) });
const { session } = await r.json();
const ws = new WebSocket(`ws://${new URL(BASE).host}/api/terminal/${session.id}`);
await new Promise((res) => ws.addEventListener('open', res));
let lastOut = null; let outCount = 0;
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.type === 'output') { lastOut = performance.now(); outCount++; } });
ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })); // triggers the spawn
await new Promise((res) => setTimeout(res, 1500));                 // shell prompt settles
ws.send(JSON.stringify({ type: 'input', data: 'stty -echo; PS1=""; clear\n' })); // quiet shell: no echo, no prompt
await new Promise((res) => setTimeout(res, 800));
ws.send(JSON.stringify({ type: 'input', data: 'stty echo\n' }));   // echo back on: each key now produces exactly its echo
await new Promise((res) => setTimeout(res, 800));

const N = 60; const lat = []; const gaps = [];
for (let i = 0; i < N; i++) {
  const before = outCount; const t0 = performance.now();
  ws.send(JSON.stringify({ type: 'input', data: 'x' }));
  while (outCount === before && performance.now() - t0 < 500) await new Promise((res) => setTimeout(res, 0));
  lat.push(lastOut - t0);
  await new Promise((res) => setTimeout(res, 60)); // isolated keystrokes, well past any window
}
// burst: 200 keys as fast as possible, count WS frames -> flood protection still there?
const b0 = outCount; const tb = performance.now();
for (let i = 0; i < 200; i++) ws.send(JSON.stringify({ type: 'input', data: 'y' }));
await new Promise((res) => setTimeout(res, 400));
const burstFrames = outCount - b0;

ws.send(JSON.stringify({ type: 'input', data: 'exit\n' }));
await new Promise((res) => setTimeout(res, 300)); ws.close();
const s = lat.filter(Number.isFinite).sort((a, b) => a - b); const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2);
console.log(`isolated keys: n=${s.length}  p50=${p(0.5)} ms  p90=${p(0.9)} ms  max=${s[s.length-1].toFixed(2)} ms`);
console.log(`burst of 200 keys in ${(performance.now()-tb-400).toFixed(0)} ms -> ${burstFrames} WS output frames (cap: ~1 per 16 ms window)`);
