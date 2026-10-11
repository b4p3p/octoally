# Analysis 2026-06-16: Terminal pivot and choice of base

Date: 2026-06-16
Purpose: an **analyzable** document for deciding whether and how to abandon
OctoAlly's "scaled multi-client web terminal" model, and which base to restart from.
It combines (a) the architectural analysis done in session and (b) multi-source
research on existing systems (21 of 25 claims confirmed, primary sources).

> Method note: each option reports the **reliability** level of the
> assessment. "Verified 3-0" = claim confirmed unanimously in adversarial
> verification against a primary source (official repo/docs). The judgements on
> *maturity / suitability for forking* remain partly engineering calls, to be
> confirmed by reading the code before any commitment.

---

## 0. TL;DR

- **kitty is NOT the way** (verified): it cannot be embedded in an app or in the
  browser, it is already one of our documented terminal anti-patterns, and it
  would take away tmux persistence. Discarded.
- The **pain (resize / multi-client)** is structural to the *one shared PTY with a
  single geometry* model. It is solved **at the root** by moving to
  **one dedicated PTY session per client** (no more scaled viewers competing
  over the same size).
- Target architecture: **headless engine (over IP)** + **rich desktop client
  (serious work, real multi-tab terminals)** + **phone/web client as a
  remote control** (reads the console, sends quick commands). The geometry
  constraint only kicks in for "same live session on two views at once", which
  becomes an edge case.
- **Two realistic paths** (details in §6):
  - **Path A — evolutionary (minimum risk):** keep the Node/Hono + tmux engine,
    build the desktop client as **Electron + xterm.js, 1 PTY per tab**
    (= the VS Code terminal model → resize is solved by construction),
    demote the web UI to reader + remote control. Reuses ~80% of what you have,
    no Rust.
  - **Path B — native pivot:** **Tauri 2 + Rust (portable-pty)**, native PTY per
    client. Cleaner on resize/perf and a lightweight binary, but a rewrite of the
    engine in Rust, and the reference bases are still PoC-grade. Candidate base to
    *audit*: **maiTerm**; mature emulator library: **wezterm-term (WezTerm)**.
- **Recommendation:** start from **Path A** to stop suffering right away,
  keeping Path B as the trajectory if/when a native/GPU terminal is needed.
  Before forking anything: **code audit** of maiTerm and opcode/crystal.

---

## 1. The problem (why we are here)

Current stack: React/Vite + Node/Hono + **xterm.js + node-pty + tmux + WebSocket**,
plus an **Electron** client. This is the industry standard (ttyd, wetty, code-server,
sshx) — there is no magic library that gets around it.

The constraint that hurts: **one session = one PTY = ONE
geometry (cols×rows) at a time.** With several clients on the same window,
tmux shrinks to the smallest client. Hence the "CSS-scaled viewers" model
and all the scale/resize/readability bugs.

**Technical cause of the resize issue** (verified 3-0): vim/tmux read the size from
the **kernel PTY** (ioctl `TIOCGWINSZ` + `SIGWINCH`), *not* from xterm.js. If the
front end resizes the view but the backend PTY is not updated (or is
deliberately left un-updated, as is correct for passive viewers), the winsize
stays stale. **Implication:** a backend with **one dedicated PTY per client**
solves resize far more cleanly than the shared multi-client tmux model.
Sources: xterm.js#3873, node-pty#266, tmux#4003.

---

## 2. The architectural direction (independent of the base)

Separate the two roles OctoAlly mixes today:

```
        ┌─────────────────────────────────────────────┐
        │   ENGINE (headless, on one machine, over IP)│
        │   PTY/tmux + Claude Code SDK agents         │
        │   Projects/prompts DB + HTTP/WebSocket API  │
        └───────────────┬──────────────────┬───────────┘
                        │                  │
         ┌──────────────┴───────┐   ┌──────┴───────────────┐
         │  DESKTOP CLIENT       │   │  PHONE/WEB CLIENT     │
         │  REAL terminals,      │   │  reads console +      │
         │  multi-tab, 1 PTY/tab │   │  quick commands       │
         │  = where you WORK     │   │  = remote over IP     │
         └───────────────────────┘   └───────────────────────┘
```

- **Desktop** = serious work. 1 PTY per tab, single-owner view → "real" reflow,
  zoom and resize. The rich terminal lives here.
- **Phone/web** = remote control: **read** via `capture-pane`/stream (text only,
  no geometry) + **write** via `send-keys`/input. From the bathroom you read and send
  "continue"/approve a tool/write a short prompt. It does **not** resize the PTY
  → the bug cannot occur on this path.
- **Safely over IP:** Tailscale/WireGuard instead of exposing the port to the
  Internet (the engine has terminals + agents = RCE surface).
- **Natural bonus:** push notifications when the agent finishes or asks for confirmation.

**kitty — why it is out (verified):** it is a GPU desktop emulator, not
embeddable in an app/browser; requests for reparent/XEmbed have been
rejected (issue #2612 closed, #7083 declined). Replacing tmux with `kitty @`
would take away persistence/detach. = a known anti-pattern.

---

## 3. The concrete options (from the research)

### A. maiTerm — *the single base closest to all 3 needs*
- **What it covers:** (1) native hybrid terminal (alacritty_terminal in Rust =
  VTE parser/scrollback + xterm.js as a thin DOM renderer, ~60fps);
  (2) **workspace/project** organization with recursive split panes + multi-tab
  + persistent scrollback in SQLite; (3) **deep Claude Code**: MCP server
  with 25+ tools, lifecycle hooks (SessionStart/PreToolUse…), auto-resume,
  an "agent bridge" between two Claude sessions.
- **Stack:** Tauri 2 + Svelte 5 + Rust (alacritty_terminal 0.25, portable-pty,
  rusqlite).
- **License:** to be checked in the repo.
- **Reliability:** verified 3-0 on the features, **but the only source = README**, and
  the project self-describes as "fully written by AI", with no third-party verification.
- **Pros:** it is already *almost* our triplet in a single project, on the
  Tauri stack that solves resize at the root.
- **Cons/Caveats:** it is more "terminal + workspace" than an **AI session
  orchestrator** (it lacks the branch-per-session depth of Claude Squad/Crystal).
  **Audit the code before forking.**
- Link: https://github.com/Flexmark-Intl/maiterm · https://maiterm.dev

### B. Tauri 2 + xterm.js + native PTY in Rust (portable-pty) — *build it yourself on the validated pattern*
- **What it covers:** the **terminal layer** (1). It is the Tauri equivalent of your
  current Electron + node-pty: replace node-pty with **portable-pty** on the Rust side.
- **Stack/License:** Tauri 2 + xterm.js + portable-pty; **tauri-plugin-pty** is
  **MIT** (~8k downloads/month, spawn/onData/write/resize API).
- **Reliability:** pattern verified 3-0, but the reference projects are
  **PoCs**: `tauri-terminal` (Tauri 1.x, dated), `Terminon` (single-author PoC,
  0 stars, **no declared license = not legally forkable until
  clarified**), `tauri-plugin-pty` (early but working).
- **Pros:** full control, lightweight binary, PTY-per-client = clean resize.
- **Cons:** you start closer to "from scratch" on everything else (orchestration, UI, DB).
- Link: https://github.com/Tnze/tauri-plugin-pty ·
  https://github.com/Shabari-K-S/terminon · https://github.com/marc2332/tauri-terminal

### C. WezTerm / `wezterm-term` crate — *the mature emulator + multiplexer*
- **What it covers:** (1) **cross-platform GPU** emulator AND multiplexer, Rust, in a
  single project. **Client-server architecture with "hot-swappable GUI attachments
  without session loss"** → relevant to multi-client/remote, an alternative to tmux.
  The **wezterm-term** crate is reusable as a **library** independent of the GUI.
- **License:** **MIT** (both WezTerm and wezterm-term). Verified 3-0.
- **Pros:** the most solid and battle-tested emulator base; the mux solves
  "same session on several views" better than tmux.
- **Cons:** using wezterm-term as a library = **you build the renderer and PTY
  management from scratch** (more work than forking maiTerm/Terminon); possible fallback to
  software rendering on some Intel/RDP setups.
- Link: https://github.com/wezterm/wezterm ·
  https://github.com/wezterm/wezterm/blob/main/term/README.md ·
  https://wezterm.org/multiplexing.html

### D. claudecodeui (siteboon) — *an OctoAlly-style session manager, but web*
- **What it covers:** (2) **multi-CLI** GUI (Claude Code, Cursor, Codex, Gemini),
  conversation resume, multiple sessions, history, file tree, Git, optional
  TaskMaster, **remote** control. Very close to an "OctoAlly-style manager".
- **Stack:** web React/Vite (NOT native desktop). Very active (~12k stars,
  push 2026-06-16).
- **License:** **AGPL-3.0** (network copyleft → obligations if served as SaaS).
- **Reliability:** verified 3-0 on the manager; **the "embedded multi-tab xterm.js
  terminal" claim was REFUTED (1-2).**
- **Pros:** an excellent reference for the *remote control* and session management.
- **Cons:** the same xterm.js stack you already use → does **not** meet the need for a
  native terminal; heavy AGPL; covers "prompt/workflow" only partially.
- Link: https://github.com/siteboon/claudecodeui

### E. Vibe Kanban (BloopAI) — *multi-agent kanban orchestrator*
- **What it covers:** (2)+(3) kanban orchestration for **10+ agents** (Claude Code,
  Codex, Gemini, Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen): git worktree
  per workspace, planning, agent runs, **diff review with inline comments**,
  app preview.
- **Stack:** **Rust ~50% + React/TS ~46%**, self-hostable web via Docker (no
  Tauri/Electron).
- **Reliability / OPEN DISCREPANCY:** the README explicitly states
  **"sunsetting"**, but in adversarial verification the claim "it is being sunset/risky"
  received a **0-3 vote (refuted)**. **Check directly on the repo
  before adopting or discarding it.**
- **Pros:** the richest orchestration model among the candidates.
- **Cons:** if it really is sunsetting, risky as a base to fork.
- Link: https://github.com/BloopAI/vibe-kanban

### F. Not verified in this report — to be assessed in a second round
Absence of evidence ≠ evidence of absence. Mentioned but **not** audited here:
**opcode** (getAsterisk / winfunc — Tauri, Claude Code GUI), **crystal**
(stravu — Electron, parallel sessions in worktrees), **claude-squad**,
**conductor**, **OpenCovibe**, **Codeman**. Several are *exactly*
dedicated Claude Code session orchestrators: they need to be assessed on license,
stack, and SDK depth against maiTerm/Vibe Kanban.

---

## 4. Comparison table

| Option | Covers (1/2/3) | Stack | License | Maturity | Claude Code fit | Resize solved |
|---|---|---|---|---|---|---|
| **A. maiTerm** | 1 + 2 + 3 (partial) | Tauri2 / Svelte5 / Rust | to verify | medium (AI-written, README-only) | high (MCP+hooks+resume) | yes (Tauri PTY) |
| **B. Tauri2+portable-pty** | 1 | Tauri2 / xterm.js / Rust | MIT (plugin) | PoC | to be built | yes (by construction) |
| **C. WezTerm / wezterm-term** | 1 (+mux) | Rust | MIT | high | to be built | yes (native mux) |
| **D. claudecodeui** | 2 | React/Vite web | AGPL-3.0 | high (~12k★) | high (multi-CLI) | no (same xterm.js) |
| **E. Vibe Kanban** | 2 + 3 | Rust + React, Docker | to verify | high but "sunsetting?" | high (10+ agents) | n/a (web) |
| **Current OctoAlly** | 2 + 3 | Node/Hono + Electron + xterm.js + tmux | — | in use | in use | no (multi-client) |

---

## 5. Open decisions (to close before choosing)

1. **maiTerm audit:** being "fully written by AI" with the README as its only source, does it hold up to
   a code inspection (quality, multi-client robustness, resize correctness)?
2. **Is Vibe Kanban really sunsetting?** README and verification contradict each other.
3. **Unverified orchestrators** (opcode, crystal, claude-squad, conductor):
   license/stack/SDK depth compared with maiTerm?
4. **Requirement (3) — how to embed the agents:** headless `claude-agent-sdk`
   (`claude -p`, stream-json) **inside** the backend, *or* delegate to an **MCP
   server** (as maiTerm does)? Trade-off: programmatic control vs decoupling.
5. **Electron vs Tauri:** Path A reuses the Electron you have (zero Rust); Path B
   (Tauri/Rust) is cleaner but is a rewrite of the engine.

---

## 6. Final recommendation / where to start

**Start from Path A (evolutionary).** Reason: it stops the pain *right away*, reuses
the engine (tmux/pty/API/DB) and the Electron you already have, and **solves resize by
construction** by moving serious work to **single-owner terminals,
1 PTY per tab** (exactly VS Code's integrated terminal, which is xterm.js in
Electron). In parallel, **demote the web UI to "console reader + remote control"**
for phone/IP use — it is less code and zero geometry constraint.

**Keep Path B (Tauri/Rust) as a trajectory**, not as an immediate leap: you
activate it *if and when* you really need a native/GPU terminal or a lightweight
binary. When you do, the two most serious starting points are **maiTerm**
(fork, after an audit) or **wezterm-term** (library, more work but battle-tested).

**Concrete next step (1 round of evaluation):** before writing code,
**code audit** of `maiTerm`, `opcode`, `crystal` (and a check of Vibe Kanban's
sunsetting) to close the open decisions in §5. Only then choose fork vs
build.

---

## 7. Sources (primary, unless stated otherwise)

- maiTerm — https://github.com/Flexmark-Intl/maiterm · https://maiterm.dev
- tauri-plugin-pty (MIT) — https://github.com/Tnze/tauri-plugin-pty
- Terminon — https://github.com/Shabari-K-S/terminon
- tauri-terminal — https://github.com/marc2332/tauri-terminal
- WezTerm — https://github.com/wezterm/wezterm ·
  https://github.com/wezterm/wezterm/blob/main/term/README.md ·
  https://wezterm.org/multiplexing.html
- claudecodeui (AGPL-3.0) — https://github.com/siteboon/claudecodeui
- Vibe Kanban — https://github.com/BloopAI/vibe-kanban
- opcode — https://github.com/getAsterisk/opcode · https://github.com/winfunc/opcode
- crystal — https://github.com/stravu/crystal
- alacritty_terminal (crate) — https://crates.io/crates/alacritty_terminal
- Claude Agent SDK (stream-json) — https://code.claude.com/docs/en/agent-sdk/streaming-output
- Resize/PTY winsize — https://github.com/xtermjs/xterm.js/issues/3873 ·
  https://github.com/microsoft/node-pty/issues/266 · https://github.com/tmux/tmux/issues/4003
- kitty embedding (rejected) — https://github.com/kovidgoyal/kitty/issues/2612 ·
  https://github.com/kovidgoyal/kitty/issues/7083
