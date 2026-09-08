# Terminal lag on distributions that ship uutils coreutils

Date: 2026-09-08
Status: **cause found, fixed, verified in production on the affected machine.**
Fixed in: `fix(terminal): copy pane output with dd, not cat`.

Supersedes the diagnosis of two earlier documents in this folder (both in
Italian): `ANALISI-2026-09-04-lag-terminale-wayland.md` and
`ANALISI-2026-09-05-lag-terminale-confronto-mint.md`. Their measurements all
stand and are reused below. Their final conclusion does not: they closed on a
cause that turned out to be a third of the problem, and archived the line of
enquiry that led to the real one. Section 6 says exactly where and why, because
that mistake is more instructive than the bug.

This document is in English while its four predecessors are in Italian. The
repository is public and `CLAUDE.md` asks for English in everything committed;
the older ones are left as they are rather than retranslated.

## 0. In one paragraph

Every byte a session ever displays travels through a command that tmux's
`pipe-pane` pipes into, and that command was `cat`. On a distribution that
ships **uutils coreutils** (Rust) instead of GNU, which Ubuntu 26.04 does by
making `/usr/bin/cat` a link into `/usr/lib/cargo/bin/coreutils`, that `cat`
holds pane output back and releases it in bursts. Typing into Claude Code, half
the keystrokes waited **over three seconds** for their redraw, at no
predictable rhythm. Replacing the copier with `dd bs=65536` takes the same
measurement from a p50 of 2245.8 ms to 2.8 ms.

## 1. Symptom

Reported as "the console is unusable, and it is unusable only on this machine".
The characters landed in clumps, seconds apart, with no pattern the user could
name: asked whether the lag was constant or one keystroke behind, the answer
was "it is random". That randomness is the signature: a p50 of 4.9 ms with a
p90 of 204 ms feels far worse than a constant 200 ms would.

Two Linux Mint machines running the identical version showed nothing. They
have GNU coreutils, so they cannot reproduce it.

## 2. The affected machine

| item | value |
|---|---|
| OS | Ubuntu 26.04.1, kernel 7.0.0-31 |
| desktop | KDE Plasma on Wayland, `Scale=1.75` |
| **coreutils** | **uutils 0.8.0** (`/usr/bin/cat` -> `/usr/lib/cargo/bin/coreutils/cat`) |
| tmux | 3.6 |
| node | v22.23.2 |
| GPU / monitor | RTX 5090, 3840x2160 @ 160 Hz |

The reference machine that works: Linux Mint 22, X11, tmux 3.4, GNU coreutils.

## 3. The output path, and the one link that was wrong

```
Claude Code -> tmux -> pipe-pane -> <copier> > FIFO
  -> pty-worker reads the FIFO -> IPC -> server -> WebSocket -> xterm.js -> DOM
```

`setupPipePane()` in `server/src/services/pty-worker.ts` builds that copier
command. It was `cat > <fifo>`; it is now `dd bs=65536 2>/dev/null > <fifo>`.

Measured on this machine, one Claude Code session per run, same tmux, same
222x48 pane, 40 isolated keystrokes 250 ms apart, **only the copier changed**:

| copier | p50 | p90 | over 50 ms | over 200 ms |
|---|---|---|---|---|
| `cat` (uutils 0.8.0) | **2245.8 ms** | 3000 (timeout) | 20 of 40 | 20 of 40 |
| `cat` (GNU coreutils 9.7) | 2.9 ms | 3.3 ms | 0 | 0 |
| `dd bs=65536 2>/dev/null` | **2.8 ms** | 3.3 ms | 0 | 0 |

GNU `cat` is in the table only as a control: it is not the fix, because it is
not portable (on this machine it exists solely as `gnucat`, from the
`gnu-coreutils` package). `dd` with an explicit block size is a plain
read/write loop that forwards every short read at once, and it is POSIX, so
macOS behaves the same. Its stderr goes to `/dev/null` for the transfer
summary alone; `status=none` would do the same but is not portable.

### 3.1 What was not established

The mechanism inside uutils `cat` was not isolated, and this document does not
claim one. Two observations that a future investigation should start from,
both reproducible on the affected machine:

- with a **regular file** as the destination instead of the FIFO, uutils `cat`
  forwarded every write promptly;
- with a plain `printf` loop as the **source** instead of tmux, it also
  forwarded promptly.

The stall needs the whole combination. It is enough for OctoAlly's purposes to
know that the copier is the variable and that `dd` is not affected, but the
underlying behaviour may well affect other software on these distributions.

## 4. Why it hid for so long

**A plain shell does not reproduce it.** This is the whole reason the defect
survived a full round of latency work on this very code path. A shell's echo
comes back promptly whatever the copier is: measured through the real server
with a throwaway terminal session, `scripts/probe-ws-latency.mjs` reports p50
**0.71 ms** and a max of 1.15 ms, with uutils `cat` in the chain. It takes a
TUI that redraws on every keystroke, like Claude Code, to bring the stall out.

Any probe built around a shell is therefore blind to this, and one had already
been built and trusted.

**The obvious client-side probe is blind too.** The recipe in section 9 of the
2026-09-04 document times a keydown against the next DOM mutation. When output
arrives late but a later keystroke flushes it, the observer attributes the
mutation to the most recent key and records a small number. That probe measured
a median of 23.9 ms while the pipe was stalling for seconds.

What did see it, immediately, was a **passive capture of the WebSocket frames**
from the Chromium debugger, taken while the user typed in a real session
(`Network.webSocketFrameSent` / `Received`, no page instrumentation):

```
inputs sent: 194    outputs received: 109
key -> first output frame
  p50 4.9 ms   p90 204.5 ms   p99 1400.5 ms   max 1949.8 ms
  over 50 ms: 93 of 194     over 200 ms: 20
```

194 keystrokes producing 109 replies is the tell: keystrokes were not getting
their own redraw at all.

## 5. Result

End to end through the real production server, Claude Code in the pane at
222x48, 40 isolated keystrokes:

| | p50 | p90 | p99 | max | over 50 ms |
|---|---|---|---|---|---|
| before | 4.9 ms | 204.5 | 1400.5 | 1949.8 | 93 of 194 |
| after | 3.3 ms | **3.9** | **9.7** | **9.7** | **0 of 40** |

The p50 was always fine. It was the tail that made the application unusable,
and it is the tail that is gone.

## 6. What the two earlier documents got right, and where they turned wrong

Both remain worth reading: they contain measurements this one relies on, and a
list of operational mistakes that is still accurate.

**Right, and confirmed here.** The XWayland diagnosis (blurred text, overlapping
rows, Alt+Enter) and its `ozone-platform-hint` fix: verified on this machine
after installing the rebuilt package, with `devicePixelRatio` at a real 1.75,
two Wayland sockets open, no X11 client, and `libwayland-egl` mapped. The
16 ms trailing debounce on the WebSocket output path and its leading-edge
replacement: re-measured here A/B on the real server, p50 **16.24 ms** before
and **0.71 ms** after. Both were real defects, both are fixed, neither was
the reason the terminal was unusable.

**Where it turned wrong.** The 2026-09-04 document suspected tmux 3.6, which was
the correct neighbourhood: the whole output path goes through `pipe-pane`. The
2026-09-05 document then measured the chain on the *reference* machine, where
tmux is 3.4, found 0.31 ms, and closed the question by inference. Its section
7.1 tells the other console to run `bench-tmux-chain.mjs` and, on a p50 under
1 ms, to archive the hypothesis.

Run here, that bench does report a p50 of **0.23 ms**, faster than the
reference machine. It also reports **101 lost samples out of 200**, and the
pass criterion never looked at them. Half the keystrokes never arrived, and the
percentile could not say so because it is computed over the ones that did.

The lesson is not about tmux. It is that a benchmark whose pass criterion
ignores its own loss counter will certify a stalling pipe as healthy, and that
a hypothesis should be killed by a measurement on the machine that shows the
defect, never by one taken on the machine that does not.

## 7. Reproducing and checking

```sh
node scripts/bench-claude-redraw.mjs                     # what we ship: dd
node scripts/bench-claude-redraw.mjs cat                 # whatever cat is first
node scripts/bench-claude-redraw.mjs gnucat 60           # a GNU control, if any
```

Healthy is a p50 of a few ms with nothing over 50 ms. A p90 in the hundreds
means the copier is batching. First thing to check is then `cat --version`.

The bench runs Claude Code on its own tmux socket and its own FIFO, so it
cannot disturb a live session. That matters: attaching `pipe-pane` to a pane
OctoAlly owns replaces the pipe the worker reads from and mutes that session in
the UI until it is closed and reopened.

It types letters and never presses Enter, so nothing reaches the model and a
run costs nothing. Claude Code must already trust the directory it runs in,
otherwise it opens on the "do you trust this folder?" prompt where letters do
nothing and every sample times out.

## 8. Still unmeasured

- **The mechanism inside uutils `cat`** (section 3.1).
- **Whether other uutils replacements on the same path batch the same way.**
  Only `cat` and `dd` were tested.
## 9. The GPU process crashes, which are not ours

An earlier revision of this document listed three Chromium GPU process restarts
at startup (`Context was lost`, `eglCreateImage failed`) as unexplained, and
said they came with the move off XWayland and that the process then settled on
the NVIDIA driver. Both halves were wrong, and the correction is worth keeping
because the reasoning error is easy to repeat.

They are not ours, and they are not about Wayland. Forcing the app back to X11
with `OCTOALLY_OZONE=x11` reproduces them exactly: three crashes, same EGL
errors. What Chromium reports about itself settles the rest, and it is the only
source that does. `SystemInfo.getInfo` over the debugger, which is the data
behind `chrome://gpu`:

```
gpu_compositing   disabled_software      glRenderer   Disabled
rasterization     disabled_software      glVendor     Disabled
opengl            disabled_off           webgl        disabled_off
```

Everything renders on the CPU. The earlier claim that it "settles on the NVIDIA
driver" came from finding NVIDIA libraries mapped into a process, which says
only that the libraries were loaded, never that a feature is enabled.

The cause is on the machine, not in any application:

```
kernel module in memory   595.84
userspace libraries       595.91.07
nvidia-smi                Failed to initialize NVML: version mismatch
vulkaninfo                enumerates only the integrated Radeon and llvmpipe
```

The NVIDIA driver was upgraded while the machine was running, six minutes after
it booted, so the module in memory and the libraries on disk are different
versions and cannot talk to each other. The card is unusable to every
application until a reboot, and `nvidia-smi` says so plainly. Nothing in
OctoAlly can work around that, and nothing should try.

One measurement is worth keeping from this: even with all rendering on the CPU,
the frame cadence held at p50 6.2 ms and p99 7.2 ms over 3000 frames, with
nothing above 20 ms. The terminal was never GPU bound.

Two traps this one laid, both of which caught a first pass:

- **A crash counter is not an outcome.** Forcing GLVND to the NVIDIA vendor
  with `__EGL_VENDOR_LIBRARY_FILENAMES` takes the crashes from three to zero,
  which looks like a fix and is the opposite of one: EGL then fails to
  initialise at all (`Initialization of all EGL display types failed`), so
  nothing is left to crash. The feature status is identical either way.
- **Loaded libraries are not enabled features.** Only `chrome://gpu`, or
  `SystemInfo.getInfo` over the debugger, answers what is actually on.
