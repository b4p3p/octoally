# HANDOFF — resume here

Branch: `feat/pivot-terminale-desktop` (not yet merged to `main`).
Read `CLAUDE.md` first — it has the commands, layout, and terminal architecture.

## What this branch changed (vs main)

- **Active Sessions grid = real terminals.** In the Electron client, grid cells are
  controller terminals that fit their cell (real reflow on column change / fullscreen;
  minimize returns to the cell). In a browser they stay passive viewers.
- **Web dashboard is safe by construction.** Only the Electron client drives the PTY
  geometry; any browser (networked PC or phone) is forced to a passive viewer — it
  reads + sends input but never resizes/claims control, so it can never break the
  Electron client. Gate in `dashboard/src/components/Terminal.tsx`
  (`wantsControl = isController && window.electronAPI`).
- **Terminal caret fixed.** Claude/agent consoles now show the caret when focused
  (was hidden by a blunt CSS rule). Uses xterm's `cursorInactiveStyle: 'none'`.
- **Project `CLAUDE.md`** added (architecture, conventions, anti-patterns).
- **Secret scanning** (public repo): pre-commit hook (`.githooks/pre-commit` +
  `scripts/secret-scan.sh`, installed via the `prepare` script → `core.hooksPath`),
  CI backstop (`.github/workflows/secret-scan.yml`, gitleaks over full history),
  strengthened `.gitignore`. Manual scan: `npm run scan:secrets`.
- **Terminal.tsx refactor — step 1 done** (see below).

## State

- All changes are **frontend-only**. Deployed to the local install
  (`~/octoally/dashboard/dist`) via `npm run deploy:ui`; server (`:42010`) untouched.
- `/m` mobile page and the experimental `/w` Workspace were tried and **removed**;
  the safe responsive web access is the dashboard itself in a browser.

## How to work / verify

- Test in `npm run dev:isolated` (server `:42020`, dashboard `:42021`, separate DB).
  **Never** test on the live install.
- Deploy frontend to the install: `npm run deploy:ui` (no server restart).
- Measure real behavior, don't eyeball:
  `tmux -L octoally list-panes -t of-<sessionId> -F '#{pane_width}x#{pane_height}'`.
- To exercise the Electron path in a plain browser (e.g. Chrome DevTools), inject
  `window.electronAPI` before load; without it the dashboard behaves as a browser.

## Terminal.tsx refactor — plan and progress

Goal: simplify the (now ~1187-line) `Terminal.tsx` **incrementally and
behavior-preserving**, verified in `dev:isolated`.
Pattern per step: **extract → small named API → build → dev smoke → commit.**

- [x] **Step 1 — cross-terminal registry** → `dashboard/src/lib/terminal-registry.ts`
  (connection tracking + server-alive fan-out). Done, behavior-identical.
- [ ] **Step 2 — `createTerminalXterm()`**: extract the big `new XTerm({...})` config
  block (theme/cursor/options) into a factory. Self-contained, low risk.
- [ ] **Step 3 — viewer scaling**: `applyScale` + `getSizer` + `scheduleScale` into a
  module/hook. Medium coupling (closes over refs/term/container).
- [ ] **Step 4 — `useTerminalSocket`**: the WebSocket lifecycle (`connectWs` /
  `disconnectWs` / `onServerAlive` / `onmessage` / reconnect backoff). Highest
  coupling — do last, with full dev verification.

## Open items

- Merge the branch to `main` when ready (user decides).
- Optional: make the full dashboard phone-responsive (it is safe in a browser but
  desktop-laid-out, so cramped on a phone).
- Pre-existing **Italian** UI strings elsewhere in the codebase (not from this work,
  e.g. `dashboard/src/components/ProjectDashboard.tsx`) — sweep to English if desired.
