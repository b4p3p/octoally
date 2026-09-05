#!/usr/bin/env node
/**
 * bench-ipc-hop.mjs — costs the pty-worker -> server IPC hop with the payload
 * sizes a real keystroke produces (letter ~40 B, space ~1,5 KB, burst 17 KB).
 *
 * Answers section 7.3 of ANALISI-2026-09-04: whether the worker -> server hop
 * is worth removing.  Needs nothing but node; touches no OctoAlly session.
 */
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'oa-ipc-'));
const child = join(dir, 'echo-child.mjs');
writeFileSync(child, `
process.on('message', (m) => { process.send({ type: 'output', data: m.data }); });
process.send({ type: 'ready' });
`);

const proc = fork(child, [], { silent: true });
await new Promise((r) => proc.once('message', r));

console.log(`node: ${process.version}`);
console.log('IPC round-trip parent -> child -> parent (2 hops), ms');

for (const size of [40, 1500, 17000]) {
  const payload = 'x'.repeat(size);
  const s = [];
  for (let i = 0; i < 300; i++) {
    const t0 = process.hrtime.bigint();
    proc.send({ data: payload });
    await new Promise((res) => proc.once('message', () => {
      s.push(Number(process.hrtime.bigint() - t0) / 1e6);
      res();
    }));
  }
  s.sort((a, b) => a - b);
  console.log(`  ${String(size).padStart(6)} byte : p50 ${s[150].toFixed(3)}  p90 ${s[270].toFixed(3)}  max ${s[299].toFixed(3)}`);
}

proc.kill();
rmSync(dir, { recursive: true, force: true });
