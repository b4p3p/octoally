import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutputBatcher } from './output-batcher.js';

const WINDOW = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const sent: string[] = [];
  const batcher = createOutputBatcher((data) => sent.push(data), WINDOW);
  return { sent, batcher };
}

test('first chunk after idle is sent immediately', () => {
  const { sent, batcher } = harness();
  batcher.push('a');
  assert.deepEqual(sent, ['a']);
  batcher.dispose();
});

test('chunks inside the window are coalesced and sent once at the window end', async () => {
  const { sent, batcher } = harness();
  batcher.push('a');
  batcher.push('b');
  batcher.push('c');
  assert.deepEqual(sent, ['a']);
  await sleep(WINDOW + 15);
  assert.deepEqual(sent, ['a', 'bc']);
  batcher.dispose();
});

test('a chunk after the window closed is sent immediately again', async () => {
  const { sent, batcher } = harness();
  batcher.push('a');
  await sleep(WINDOW + 15);
  batcher.push('b');
  assert.deepEqual(sent, ['a', 'b']);
  batcher.dispose();
});

test('nothing is sent at the window end when nothing arrived', async () => {
  const { sent, batcher } = harness();
  batcher.push('a');
  await sleep(WINDOW + 15);
  assert.deepEqual(sent, ['a']);
  batcher.dispose();
});

test('after a trailing flush the window re-arms so a burst stays at one message per window', async () => {
  const { sent, batcher } = harness();
  batcher.push('a');
  batcher.push('b');
  await sleep(WINDOW + 15);
  assert.deepEqual(sent, ['a', 'b']);
  batcher.push('c');
  assert.deepEqual(sent, ['a', 'b'], 'right after a trailing flush the next chunk must wait');
  await sleep(WINDOW + 15);
  assert.deepEqual(sent, ['a', 'b', 'c']);
  batcher.dispose();
});

test('dispose drops a pending flush', async () => {
  const { sent, batcher } = harness();
  batcher.push('a');
  batcher.push('b');
  batcher.dispose();
  await sleep(WINDOW + 15);
  assert.deepEqual(sent, ['a']);
});
