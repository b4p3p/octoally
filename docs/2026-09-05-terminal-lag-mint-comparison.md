# Analysis 2026-09-05: the 24 ms lag, measured from the machine that works

Date: 2026-09-05
Follows: `2026-09-04-terminal-lag-kde-wayland.md`, which closed with two
open questions (break down the 24 ms, and understand the difference with the Mints).
Status: **cause found, fix implemented and measured here in A/B**. It is not
the tmux version. Perception at 160 Hz on the KDE machine is still to be validated.
Purpose: give the other console (the KDE Wayland machine) the comparison that
could not be made from there, plus the exact spot in the code to change.

## 0. In two lines

The 24 ms are not a defect of that machine: they are a `setTimeout(..., 16)`
in the server, on the output path to the WebSocket, present since the first
commit and identical on every machine. The previous document had ruled it out
(section 6.6) **by looking for it in the wrong file**: it lives in `session-manager.ts`,
not in `pty-worker.ts`. The KDE machine *sees* it and the Mints don't because there
the benchmark is a 160 Hz panel and a Konsole that responds in 6 ms.

## 1. Environment of this machine (the one without the defect)

To compare against the table in section 2 of the previous document.

| item | here (works) | there (defect) |
|---|---|---|
| OS | Linux Mint 22 Wilma, kernel 6.8.0-137 | Ubuntu 26.04.1, kernel 7.0.0-31 |
| desktop | **X11**, Cinnamon, no scaling | KDE Wayland, `Scale=1.75` |
| **tmux** | **3.4** (3.4-1ubuntu0.1) | **3.6** |
| node | v22.21.1 | v22.23.2 |
| GPU | RTX 3060 | RTX 5090 (595.84) + integrated Radeon |
| monitor | 2560x1440 **@ 59.95 Hz** (+ two 1080p @ 60) | 3840x2160 **@ 160 Hz** |
| installed binary | `/opt/OctoAlly` from July 31 | `/opt/OctoAlly` from August 25 |

The `tmux -V` requested by section 7.2 is therefore **3.4**. The hypothesis was
reasonable, but section 3 below disproves it with a measurement.

## 2. Measurements taken here, all headless

No GUI, no CDP: these measure only the server-side transport, so they are
reproducible identically on the other machine and directly comparable.

### 2.1 The tmux + pipe-pane + fifo chain: 0.31 ms

`scripts/bench-tmux-chain.mjs` (new, in this commit) replicates exactly the
path of `pty-worker.ts`: a node-pty pty holding a `tmux attach-session`,
a pane running `cat` (so the only "application" in the loop is the
line discipline's echo), `pipe-pane -O` to a fifo, a reader on the fifo. It uses its
own tmux socket and fifo: **it touches no live OctoAlly session**
(operational mistake no. 1 of the previous document).

```
tmux 3.4 / node v22.21.1 / 200 iterations
write(pty) -> tmux -> tty echo -> pipe-pane -> cat -> fifo   [ms]
  min 0.12   p50 0.31   p90 0.70   p99 0.88   max 1.97   lost 0
```

The **entire** chain the previous document flagged as suspect — tmux,
`pipe-pane`, the `cat` process, the fifo — costs **0.31 ms**. That is 1.3% of the 24 ms.
Even if tmux 3.6 were three times slower, we would be talking about 1 ms.

### 2.2 The worker -> server IPC hop: 0.03-0.11 ms

With the real per-keystroke volumes reported by the previous document (letter ~40 B,
space ~1.5 KB, 17 KB burst), round-trip over two hops:

```
   40 bytes : p50 0.027   p90 0.036
 1500 bytes : p50 0.033   p90 0.044
17000 bytes : p50 0.108   p90 0.128
```

This answers open question 7.3: the two "avoidable" hops (the `cat` on the fifo and
the IPC) **are not worth removing**. Together they stay under
half a millisecond.

## 3. The cause: `session-manager.ts:711`

The output throttle exists, but it is not in the worker. It is in the server process,
in the `case 'output'` branch that receives IPC messages from the worker:

```ts
// server/src/services/session-manager.ts:696-714
if (!active.wsPendingData) {
  active.wsPendingData = msg.data;
  setTimeout(() => {
    const data = active.wsPendingData!;
    active.wsPendingData = null;
    for (const ws of active.subscribers) {
      ws.send(JSON.stringify({ type: 'output', sessionId, data }));
    }
  }, 16); // ~60fps — one WS message per frame
} else {
  active.wsPendingData += msg.data;
}
```

It is a **trailing debounce**: the first chunk after a quiet period does not
go out immediately, it opens a window and waits 16 ms. The worst case is
exactly the interactive one — you type a key while output is idle,
so `wsPendingData` is empty, so **the full 16 ms is always paid**.
During a continuous burst, on the other hand, chunks queue up and the cost is amortized:
the throttle is tuned for the case that doesn't hurt and penalizes the one that does.

The line has existed since the initial commit (`288348b`, March 12) and was never
revisited. The reason in the comment is true and must be kept: sending every
`pipe-pane` chunk as a separate WS message floods the browser's event queue.

## 4. The 24 ms budget

Open question 7.1, closed. Combining the measurements from here with those of the
previous document, at that monitor's refresh rate:

| segment | ms | source |
|---|---|---|
| key -> `onData` -> WS -> server -> IPC -> write to pty | ~0.5 | 2.2 + doc 6.5 |
| Claude Code redraw | ~2-4 | not measured, residual |
| tmux -> pipe-pane -> `cat` -> fifo | 0.31 | 2.1 |
| worker -> server IPC | 0.05 | 2.2 |
| **`setTimeout(..., 16)` in the server** | **16.0** | 3 |
| WebSocket on localhost | ~0.5 | — |
| wait for `requestAnimationFrame` in the client @160 Hz | 0-6.25, mean 3.1 | doc 5 |
| `term.write` + DOM layout | ~3 | doc 5 (`LayoutDuration`) |
| **expected total** | **~23.5** | |

Median measured there: **23.9 ms**. The model matches within half a
millisecond, and the 16 ms are **two thirds of the total**.

The tail matches too: p90 38.3 ms. If one keypress produces chunks spread over
time (t=0, 5, 12, 20 ms), the debounce sends the first group at 16 and reopens a
window for the chunk at 20, which goes out at 36. The glyph appears at ~36 ms.
This produces **jitter**, not just delay: and it is the jitter, not the constant
24 ms, that is perceived as "a console that doesn't respond".

## 5. Why it only shows on that machine

Not because it is slower there: it is faster. The defect is in the
benchmark.

- **60 Hz here**: a frame lasts 16.7 ms. The server's 16 ms fit inside
  the frame wait that would happen anyway. Everything else in the system
  responds in 16.7 ms, the terminal in 24: **1.4x**, below the threshold.
- **160 Hz there**: a frame lasts 6.25 ms. Konsole shows the character in one
  frame, and the user verified that Claude Code in Konsole is smooth. The
  OctoAlly terminal takes 24 ms: **4x**, and four frames apart,
  with a free-running 16 ms timer beating against a 6.25 ms refresh.

The timer is a fixed number ("~60fps") written when the machines ran at
60 Hz. On a 160 Hz panel it is a wrong tuning choice, not a bug
of that machine.

Note: this explains the **lag**. It does not explain the broken rendering symptoms,
the blurry text and Alt+Enter: those were XWayland, already fixed by the
`ozone-platform-hint` fix (sections 3 and 4 of the previous document), and only await
the package rebuild.

## 6. The fix, implemented

Batching cannot be removed (the original comment is right: `pipe-pane`
chunks arrive by the hundreds per second and one WS message for each
floods the browser's event queue). The edge moves instead: **leading throttle**
instead of trailing debounce. The first chunk after quiet goes out immediately; whatever
arrives within the 16 ms window queues up and goes out at its end, which
re-arms the window. A continuous burst still costs one message every 16 ms;
an isolated keystroke pays nothing.

Files touched (not yet committed):

- `server/src/services/output-batcher.ts` — new, 45 lines:
  `createOutputBatcher(send, windowMs = 16)` with `push()` and `dispose()`.
- `server/src/services/output-batcher.test.ts` — new, 6 tests with
  `node --test` (first chunk immediate; coalescing within the window; chunk after
  the window closed is immediate; empty window sends nothing; re-arm after the
  trailing flush; `dispose` discards the pending data). Written before the code, seen
  failing, then green.
- `server/src/services/session-manager.ts` — the `wsPendingData` field
  becomes `wsBatcher`; the `case 'output'` shrinks to
  `active.wsBatcher.push(msg.data)`; `dispose()` at the five points where the
  session leaves `activeSessions` (exit, dead worker, kill, release,
  shutdown).
- `server/package.json` — `test` script; `server/tsconfig.json` — tests
  excluded from `dist`.

`tsc` clean, `npm run build` clean, the test does not end up in `dist/`.

### 6.1 A/B measurement, same machine, same probe

Headless probe against the real server (`dev:isolated`, port 42020 with the new code,
42022 with the old code restored via `git stash`): a plain terminal
created via REST, WebSocket attached, shell silenced
(`stty -echo; PS1=""`) and then `stty echo`, so each keystroke produces
exactly its echo. Sixty isolated keystrokes (60 ms apart),
timed from the input's `ws.send` to the first `output` frame received.

| code | p50 | p90 | max | burst of 200 keys |
|---|---|---|---|---|
| old (trailing debounce 16 ms) | **17.05 ms** | 18.32 | 20.20 | 1 WS frame |
| new (leading throttle) | **0.80 ms** | 1.13 | 2.77 | 2 WS frames |

The old number is the timer, plain to see: 16 ms plus a hair of transport.
The burst confirms the flood protection is still there (200 keys, two
messages, not two hundred).

What this does **not** measure: perception at 160 Hz, the client's rAF, the
DOM layout. On the KDE machine the probe from section 9 of the previous document should
go from a median of ~24 to ~8 ms (rAF mean 3.1 + DOM ~3 + transport ~1) and from
p90 38 to ~12. Here at 60 Hz it can't be felt: validation happens there.

## 7. Procedure for the other console (KDE machine)

In order. The fix is not committed yet: it lands with the next commit
on `main`, so the first step is a `git pull` once that is done.

1. **Close the tmux hypothesis with a measurement**, two minutes, no GUI,
   no live session touched:
   ```sh
   node scripts/bench-tmux-chain.mjs 200
   node scripts/bench-ipc-hop.mjs
   ```
   Expected: p50 under 1 ms in the first, under 0.2 ms in the second. If so,
   7.2 and 7.3 of the 09/04 document are closed.

2. **Verify the server-side fix, before even the GUI**. From the repo, with
   `npm run dev:isolated` running on :42020, run the A/B probe from section
   6.1 (it lives in `scripts/` as `probe-ws-latency.mjs`):
   ```sh
   node scripts/probe-ws-latency.mjs
   ```
   Expected: p50 under 2 ms. If it is still ~17, the code running is the
   old one (build not redone, or wrong server).

3. **Rebuild and install the package**, which must contain **both**
   fixes: `ozone-platform-hint` (already written on 09/04) and the throttle. As long as
   the binary in `/opt/OctoAlly` is still the August 25 one, launching from the icon
   goes back to XWayland and neither fix is running.
   Check after installing: a real `devicePixelRatio` of 1.75 and the
   process mapping `libwayland-egl` (section 3 of the 09/04 document).

4. **Re-measure with the CDP probe** from section 9 of the 09/04 document,
   with the user actually typing: expected median ~8 ms (from 23.9), p90 ~12
   (from 38.3). And then the question that matters, which is not a number: is the
   lag still noticeable compared to Konsole?

5. If the number dropped but the lag is still felt, the residual is in the client
   (rAF + DOM) and must be measured there with `Performance.getMetrics`: there is
   nothing else on the server path.

## 8. What remains unproven

- **Perception at 160 Hz.** The fix is measured here in A/B (17 -> 0.8 ms on the
  server), not tested on the machine where the defect is felt. The final number
  comes from the CDP probe there.
- **I did not measure tmux 3.6**: this machine has 3.4. The prediction is
  an inference, to be confirmed by step 1 of section 7.
- **The Claude Code redraw (~2-4 ms)** is a residual by difference, not
  timed.
- The measurements on this machine are on **X11 with no scaling**.
