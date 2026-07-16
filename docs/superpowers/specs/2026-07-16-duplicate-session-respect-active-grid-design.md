# Duplicate Last Session — Respect the Active Sessions Grid

**Date:** 2026-07-16
**Status:** Approved
**Scope:** Frontend-only (`dashboard/`). No server changes, no geometry/control code touched (the only terminal-adjacent edit is a status filter in `ActiveTerminals.tsx`). Deployable with `deploy:ui`.
**Extends:** `2026-07-16-duplicate-last-session-design.md`

## Problem

"Duplicate last session" (project-tab context menu) always tears the user out
of their current view: it dismisses the global **Active Sessions** overlay
(`ActiveTerminals`), activates the project tab, opens the launcher full-page,
and after launch shows the new session in single (full-screen) view. Users who
work from the Active Sessions grid lose their grid layout on every duplicate
and have to navigate back by hand.

## Solution

When the Active Sessions overlay is open at the moment the user clicks
"Duplicate last session", keep the overlay open and show the pre-filled
`TaskModal` **on top of the grid**. On launch the modal closes, the overlay
stays, and the new session's card appears in the grid by itself (the grid
derives its cards from the `['sessions']` query). Nothing is auto-launched —
the modal still requires explicit confirmation, consistent with the original
design.

When the overlay is **not** open, the existing flow is unchanged (activate
project tab → full-page launcher → TaskModal).

## Data flow

Changes live in `dashboard/src/App.tsx` plus a two-line status-filter
amendment in `dashboard/src/components/ActiveTerminals.tsx` (see point 5);
`ProjectView` and `SessionLauncher` are untouched.

1. **Branch in `duplicateLastSession`** on `showActiveTerminals`:
   - **Overlay open:** do NOT call `dismissActiveTerminals()`, do NOT
     `setActiveTab`, do NOT set `launchPrefill`. Instead set a new state
     `overlayDuplicate: { project, task?, model?, cliType? } | null`
     (the `project` object comes from the already-loaded `projects` list;
     source-session selection logic is unchanged).
   - **Overlay closed:** current behavior, byte-for-byte.

2. **Render `TaskModal` from App** (already exported by
   `SessionLauncher.tsx`) when `overlayDuplicate` is set. The modal is
   already `fixed inset-0 z-50`, which stacks above the overlay container
   (`z-20`) with no extra styling. Props: `mode="session"`, `project`,
   `agents` (see below),
   `codexReady={true}`, `initialTask` / `initialModel` / `initialCliType`
   from the source session, `onClose` → clear `overlayDuplicate`.

3. **Agents query:** `TaskModal` takes an `agents` list (used by agent mode).
   App fetches it with the same query key/function `SessionLauncher` uses
   (`api.projects.rufloAgents(project.id)`), enabled only while
   `overlayDuplicate` is set — cache is shared, so in practice this is a
   no-op refetch.

4. **Launch:** a `useMutation` in App calling `api.sessions.create({...})`
   with the same parameter mapping as `SessionLauncher`'s `createMutation`
   (`project_path`, `task`, `mode`, `agent_type`, `project_id`, `cli_type`,
   `model`, `remember_model`, `inherit_mcp`). On success:
   - `invalidateQueries(['sessions'])` (and `['projects']` if
     `rememberModel`),
   - clear `overlayDuplicate`.
   - **No navigation**: no `onSessionCreated`, no tab switch, overlay stays.

5. **Pending sessions get a card (spawn trigger).** The PTY spawn is lazy:
   it fires on the first `resize` received on the session's terminal
   WebSocket (`server/src/routes/terminal.ts`), and every mounted `Terminal`
   sends one on connect — including passive browser viewers. In the classic
   flow that mount comes from `ProjectView.handleSessionCreated`; in the
   overlay flow nothing navigates, so the grid itself must mount the card.
   `ActiveTerminals.tsx` therefore includes `'pending'` in its card status
   filter (line ~224) and in the minimized-tray `aliveIds` set (line ~154):
   the new card mounts immediately, its `Terminal` attach triggers the
   spawn, and the status dot flips from warning to running. Without this,
   an overlay-launched session stays `pending` forever and the server
   watchdog auto-fails it after 90s. Side effect (accepted): pending
   sessions born elsewhere also show a card — more visibility, no conflict,
   since the server's pending path already buffers claim-control
   (commit 051404b). `ProjectView`'s sync effect still adds the tab in the
   hidden project view; the project tab is open by construction (the
   context menu lives on it), so the card passes the `openProjectIds`
   filter.

## Edge cases

- Duplicate from overlay for a project whose tab is open but not active:
  works the same — no tab switch happens or is needed.
- No prior plain session: modal opens un-prefilled with project defaults
  (same degradation as the original design).
- Session `pending` after create: the card appears immediately (pending is
  a card status) and its mount is what triggers the spawn; the dot turns
  green when the session reaches `running`.
- Closing the modal (Esc/outside/Cancel) just clears `overlayDuplicate`;
  overlay untouched.

## Error handling

If `api.sessions.create` fails the modal stays open (mutation error state),
matching the existing launcher behavior. No new failure modes otherwise: the
only new network call is the launch itself, identical to the launcher's.

## Testing / verification

In `dev:isolated` (server :42020, dashboard :42021, dev DB):

1. Open the Active Sessions overlay with ≥1 running session → right-click a
   project tab → "Duplicate last session" → TaskModal appears **over the
   grid**; the grid remains visible behind it (verify the real DOM: overlay
   container still mounted).
2. Launch → modal closes, overlay stays open, a new card appears in the grid
   for the new session (verify via `GET /api/sessions` + card count in DOM).
3. Cancel/Esc the modal → overlay untouched, no session created.
4. With the overlay closed, duplicate → old flow intact: project tab
   activated, full-page launcher, pre-filled modal, session opens single-view.
