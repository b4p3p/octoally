# Analysis 2026-09-04: terminal lag and broken rendering on KDE Wayland

Date: 2026-09-04
Status: **partially resolved**. The broken rendering and Alt+Enter are resolved
and the fix is written (not yet released). The remaining typing lag is
narrowed down but **not yet explained**: the server-side chain still has to be
broken down.
Purpose: a document another session can pick up and analyse. It contains the
measured numbers, the hypotheses already ruled out (do not redo them) and the
operational mistakes not to repeat.

## 1. Reported symptoms

On this machine, and only on this one, the user reports that the OctoAlly
console is unusable:

- pressing space does not move the cursor, same for backspace;
- Alt+Enter does not work: the first one does nothing, the second creates two lines;
- pressing Alt shows a crosshair pointer;
- blurry text and overlapping lines, "console completely broken";
- the same version (1.1.5) runs fine on two PCs with Linux Mint.

Clarification that emerged at the end of the investigation: the lag is felt
**only in the terminal**. The rest of the interface (for example the
Task/Objective modal) is smooth.

## 2. Environment

Affected machine:

| item | value |
|---|---|
| OS | Ubuntu 26.04.1, kernel 7.0.0-31 |
| desktop | KDE Plasma on **Wayland**, `kwinrc: Scale=1.75` |
| GPU | RTX 5090 (driver 595.84) + integrated Radeon (Granite Ridge) |
| monitors | 3 screens, all on NVIDIA; DP-3 3840x2160 **@160 Hz**, VRR never |
| tmux | **3.6** |
| node | v22.23.2 |
| app | OctoAlly 1.1.5, Electron 41.1.1 (Chromium 146) |

Comparison machines: two Linux Mint PCs, same OctoAlly version, no defect.
**To collect**: `tmux -V` on those PCs (see section 7).

## 3. Confirmed cause number 1: XWayland with fractional scaling

The app was running inside **XWayland** on a desktop scaled to 1.75. In that
condition the compositor receives a window drawn at integer scale and
stretches it: the text blurs and, more seriously, every xterm.js cell lands on
non-integer pixels, so the terminal grid stops being exact and glyphs overlap
the line above.

Observed evidence, not inferred: through an operational mistake, two windows of
the same app ended up open at the same time on the same screen, one on native
Wayland and one on XWayland. Only the second had the defect.

**Fix applied** in `desktop-electron/src/main.ts` (right after
`const cliPath = resolveCliPath()`):

```ts
if (process.platform === 'linux') {
  app.commandLine.appendSwitch(
    'ozone-platform-hint',
    process.env.OCTOALLY_OZONE || 'auto',
  );
}
```

`auto` picks Wayland only if the session is Wayland, so it is a no-op on X11,
macOS and Windows. `OCTOALLY_OZONE=x11` restores the old behaviour.

Verified effect: `devicePixelRatio` goes from stretched scale to **a real
1.75**, the process maps `libwayland-egl` and the `wayland-cursor` buffers, and
the user confirms that sharpness and readability improve markedly.

Status: the code is changed and builds (`npm run build` in `desktop-electron`,
the switch is in the bundle). The typecheck reports three **pre-existing**,
unrelated errors (`main.ts` `setBackgroundColor`, two `string | null` in
`speech/index.ts`). The binary installed in `/opt/OctoAlly` dates from August
25 and **does not contain the fix yet**: until the package is rebuilt,
launching from the icon goes back to XWayland and the defects return.

## 4. Confirmed cause number 2: Alt+Enter was XWayland

On native Wayland the defect no longer reproduces. Measured twice:

- with events injected via CDP: three consecutive Alt+Enter produce three lines
  (`q`, `w`, `e`), **the first one included**;
- with the user's physical keys: events `a`, `Alt`, `Enter+ALT`, `b`, `Alt`,
  `Enter+ALT`, `c`, bytes sent `[97] [27,13] [98] [27,13] [99]`, result three
  lines `a` / `b` / `c`.

xterm.js always sends `ESC CR` (`[27,13]`), identical on every press. On
XWayland the first Alt was lost on its way through the compositor.

The crosshair pointer **is not a defect**: xterm.js turns on the
`column-select` class while Alt is held, for rectangular selection. It happens
on Mint too.

## 5. The remaining lag: what was measured

All measurements were taken via CDP (`--remote-debugging-port=9222`) on the
real renderer, with the user actually typing.

| measurement | result |
|---|---|
| event delivery from the system to Chromium | median **0.4 ms**, max 2.6 |
| full round trip key -> redraw | median **23.9 ms**, p90 38.3, max 189.7 |
| interval between frames | median **6.2 ms**, max 6.4, none above 50 ms |
| long tasks during the observation window | **zero** |
| gaps between frames | **zero** |
| renderer CPU profile (2.6 s, 10 spaces) | **idle 99.6%**, ~7 ms of JS |
| `Performance.getMetrics` (3.3 s, 15 spaces) | script 3.2 ms, **layout 3 ms**, style 1.7 ms, total task 17.7 ms, **0.5% CPU** |
| bytes produced on the PTY per key | letter **36-44**, space/backspace **1058-1980**, bursts up to 17 KB |

Reading: the client is not the bottleneck. The 24 ms are almost all in the
chain between the key and the output coming back, i.e. outside the browser.

Why the modal is smooth and the terminal is not: in the modal the browser
writes the character locally, at zero cost. The terminal has no local echo,
every character has to make the full round trip before it appears. In Konsole
that round trip does not exist: the process is attached to the PTY.

The user verified that **Claude Code inside Konsole is smooth**, so the
overhead is in OctoAlly's chain and not in Claude Code nor in the machine.

Full output chain, to be shortened or justified:

```
Claude Code -> tmux -> pipe-pane -> `cat > /tmp/octoally-pipes/<id>.fifo`
  -> pty-worker reads the fifo -> IPC to the server process -> WebSocket -> client
  -> batching on requestAnimationFrame -> xterm.js -> DOM
```

## 6. Hypotheses already ruled out (do not redo them)

1. **xterm.js DOM renderer**: ruled out by two independent measurements (CPU
   profile and layout/style counters). The comment in `Terminal.tsx:252` that
   motivates choosing the DOM renderer remains valid and must not be touched
   for performance reasons.
2. **Input delivery from the system**: 0.4 ms median.
3. **Irregular frame presentation**: a constant 6.2 ms, consistent with the
   160 Hz monitor.
4. **Copy between different GPUs**: all three monitors are on `card1` (NVIDIA)
   and Chromium renders on `renderD128` (NVIDIA). No cross-GPU path.
5. **Server-side input filter**: `TERMINAL_RESPONSE_RE`
   (`pty-worker.ts:539`) always requires `ESC [`, so it does not touch
   `ESC CR`. `handleInput` writes the payload with a single `write`.
6. **Throttle or debounce in the server**: there are none on the output path
   (verified by reading `pty-worker.ts`).
7. **Multi-client conflict on tmux**: a single attached client, geometry
   consistent with the pane.
8. **The `octoally-desktop` SIGSEGV**: it is not a crash from use. See section 8.
9. **Vulkan / `libvulkan_nouveau`**: the NVK ICD is present on a machine with
   the proprietary driver (system hygiene, `nouveau_icd.json` should be
   removed), but it plays no part in this problem and Chromium on Linux does
   not use Vulkan by default.

## 7. What remains open

1. **Break down the 24 ms** into the segments of the chain in section 5. To be
   done in `dev:isolated` with timestamps at each hop: `onData` in the client,
   arrival at the server, write to the PTY, read from the fifo, IPC, WebSocket
   send, `term.write`. Do not do it on the live install.
2. **Difference with the Mint machines**: the most promising hypothesis is the
   **tmux version** (3.6 here, very recent; the whole output chain goes
   through `pipe-pane`). First step, at zero cost: `tmux -V` on the two Mint
   machines. If they are 3.2/3.4, install the same version here side by side
   (separate socket) and compare.
3. **Measure the cost of the two avoidable hops**: the `cat` process on the
   fifo and the worker -> server IPC hop.
4. The `requestAnimationFrame` batching in the client is worth at most 6 ms at
   160 Hz: it is the last place to look, not the first.

Note on the perceived contrast: this screen runs at 160 Hz, where the rest of
the system responds in 6 ms. The same 24 ms on a 60 Hz panel are less
noticeable. It does not explain everything, but it should be kept in mind when
comparing machines.

## 8. Operational mistakes made during the investigation

Listed because they produced symptoms that looked like the defect under
investigation.

1. **`tmux pipe-pane` on a pane managed by OctoAlly**: OctoAlly routes the
   pane's output into a fifo precisely with `pipe-pane` (`pty-worker.ts:250`,
   `pipe-pane -O -t <name> "cat > <fifo>"`). Hooking a measurement in with
   `pipe-pane` replaces that pipe, and removing it removes it: **the session
   goes silent in the UI**. Restoring it by hand is not enough, because the
   worker has already closed the reader and `cat` stays in `wait_for_partner`.
   Only the worker recreates it on the next `attach-session`, i.e. by closing
   and reopening the session in the UI.
2. **`octoally-desktop --version` does not print the version**: it opens a window.
3. **Launching the app from the shell of an OctoAlly pane does not work**: the
   pty-worker starts panes with `env -u ...`, without `WAYLAND_DISPLAY` or a
   usable `DISPLAY`. Chromium initialises no Ozone platform, prints
   `Missing X server or $DISPLAY`, exits and produces a **general protection
   fault during teardown**. That SIGSEGV had been blamed on the switch to
   Wayland: it is unrelated. To launch it you have to pass the graphical
   session's environment (`XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`,
   `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `XDG_SESSION_TYPE`,
   `XDG_CURRENT_DESKTOP`). Same cause for an aborted `kscreen-doctor`: from
   that shell Qt calls `qFatal`.

4. **`Page.reload` via CDP** unmounts the terminal view in the dashboard: it
   has to be reopened by hand.
5. **`strace` on the pty-worker is not usable**: `ptrace_scope=1` only allows
   tracing your own descendants.
6. The **V8 CPU profile does not see layout, style and paint**: using it alone
   to acquit or condemn a renderer is wrong. You need the
   `Performance.getMetrics` counters, which here confirmed the acquittal.

## 9. How to redo the measurements

Start the window with the debug port, with the graphical environment set
explicitly:

```sh
env XDG_RUNTIME_DIR=/run/user/1000 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 \
    XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=KDE \
    /opt/OctoAlly/octoally-desktop --ozone-platform-hint=auto \
    --remote-debugging-port=9222
```

Then, from Node 22 (which has a native `WebSocket`), connect to the target
listed by `http://localhost:9222/json` and evaluate expressions with
`Runtime.evaluate`.

Probe that measures, for each real keystroke, the event delivery delay and the
time until the redraw:

```js
window.__p = { keys: [], frames: [], pend: null };
const rows = document.querySelector('.xterm-rows');
const ta = document.querySelector('.xterm-helper-textarea');
ta.addEventListener('keydown', e => {
  const now = performance.now();
  window.__p.keys.push({ k: e.key, delivery: now - e.timeStamp, t: now, alt: e.altKey });
  window.__p.pend = now;
}, true);
new MutationObserver(() => {
  const p = window.__p.pend;
  if (p != null) { window.__p.keys.at(-1).render = performance.now() - p; window.__p.pend = null; }
}).observe(rows, { childList: true, subtree: true, characterData: true });
```

Hook that records the bytes actually sent to the server (useful for Alt+Enter):

```js
const orig = WebSocket.prototype.send;
WebSocket.prototype.send = function (d) {
  if (typeof d === 'string' && d.includes('"type":"input"')) {
    const o = JSON.parse(d);
    (window.__sent = window.__sent || []).push([...o.data].map(c => c.charCodeAt(0)));
  }
  return orig.apply(this, arguments);
};
```

Layout and style counters around a burst: `Performance.enable` and two
`Performance.getMetrics` calls, diff on `LayoutDuration`, `RecalcStyleDuration`,
`ScriptDuration`, `TaskDuration`.

Caution: to trace WebSocket frames with `Network.webSocketFrameSent` /
`Received` the connection must be created **after** `Network.enable`, so a
reload is needed, which however unmounts the terminal view (see section 8).
