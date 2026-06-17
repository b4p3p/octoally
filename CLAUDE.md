# CLAUDE.md — OctoAlly

Local-first orchestration dashboard for Claude Code & OpenAI Codex sessions.
Monorepo: a headless engine plus web and desktop clients.

> **Disclaimer — desktop-first fork.** This fork intentionally diverges from
> upstream (`ai-genius-automations/octoally`): it privileges the **Electron desktop
> client** as the single controller of terminal geometry. Upstream lets every
> connected client (browser, phone, desktop) drive the shared PTY, which re-opens
> the "smallest attached client wins" reflow conflict on a session. Here, only the
> desktop drives geometry (`wantsControl = isController && window.electronAPI` in
> `dashboard/src/components/Terminal.tsx`); any browser is a **passive viewer** — it
> reads output and can send input, but never resizes or claims control, so it can't
> garble the desktop's terminals. Deliberate trade-off: a rock-solid desktop terminal
> experience, at the cost of full interactive control from browser/mobile clients.

## Commands

- **Dev (isolated — always test here):** `npm run dev:isolated`
  → server on :42020, dashboard (Vite) on :42021, separate DB `~/.octoally/octoally-dev.db`.
  Never test on the live install ("deploy and pray" has burned us repeatedly).
- **Build:** `npm run build` (or `build:dashboard` / `build:server`).
- **Deploy UI to the local install (frontend only):** `npm run deploy:ui`
  → builds the dashboard and rsyncs to `~/octoally/dashboard/dist`. No server restart.
- **Start (prod):** `npm start`. The installed server runs on **:42010**.

## Layout

- `server/` — Fastify API + WebSocket. Terminal sessions run through **tmux + node-pty**
  (a PTY worker process). State + `pty_output` in SQLite (better-sqlite3). Routes under `/api`.
- `dashboard/` — React 19 + Vite 7 + Tailwind v4. Terminals use **xterm.js**. `main.tsx`
  renders `<App/>`.
- `desktop-electron/` — Electron client; loads the dashboard from the server URL
  (`localhost:42010`). Detected at runtime via `window.electronAPI`.

## Conventions

- **English everywhere committed**: UI strings, code, comments, and commit messages
  (international open-source project).
- Verify changes in `dev:isolated` by **measuring the real DOM / tmux geometry**, not by eye.
- The dashboard pivot work is **frontend-only**; `deploy:ui` updates just the served dashboard.

## Terminal architecture (read before touching any terminal code)

The hard constraint and the model that works:

- **One session = one PTY = one geometry (cols×rows) at a time.** With multiple attached
  clients, tmux shrinks to the smallest one. This is structural, not a bug.
- **Only the Electron desktop client drives the PTY geometry.** Any browser (a networked PC
  or a phone) is forced to a **passive viewer**: it reads the console and can send input, but
  never resizes or claims control. The gate is in `dashboard/src/components/Terminal.tsx`
  (`wantsControl = isController && window.electronAPI`). Guarantee: a browser can never break
  the Electron client's terminals.
- **Active Sessions grid** (`dashboard/src/components/ActiveTerminals.tsx`): in Electron, cells
  are **controller terminals fit to their cell** (real reflow on layout change / fullscreen);
  in a browser they are passive scaled viewers. The expanded session's grid card is suspended
  so two controllers never drive the same PTY.
- **Cursor:** Claude/agent sessions (`hideCursor`) use xterm's focus-aware cursor
  (`cursorInactiveStyle: 'none'`): caret visible when focused, none when not. Do NOT hide the
  cursor layer with CSS.

### Terminal anti-patterns (do not repeat)

- Don't make browser terminals controllers — it re-introduces the multi-client geometry
  conflict that garbles the Electron client.
- Don't auto-normalize/reset PTY geometry on attach — it re-wraps everyone's scrollback.
- Don't test terminal changes on the live install. Use `dev:isolated` and measure panes:
  `tmux -L octoally list-panes -t of-<sessionId> -F '#{pane_width}x#{pane_height}'`.
