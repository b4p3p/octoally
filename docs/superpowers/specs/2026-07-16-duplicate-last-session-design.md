# Duplicate Last Session from Project Tab — Design

**Date:** 2026-07-16
**Status:** Approved
**Scope:** Frontend-only (`dashboard/`). No server changes, no terminal/geometry code touched. Deployable with `deploy:ui`.

## Problem

Recent-project tabs in the top bar are the fastest way to reach a project, but
launching a new session still requires opening the project and walking through
the launcher, re-entering the task prompt and re-picking model/CLI. Users who
repeatedly launch sessions with the same settings (same standard prompt, same
model) want a one-gesture shortcut.

## Solution

Right-click on a project tab in the top bar opens a small custom context menu
with a single item: **"Duplicate last session"**. Clicking it activates that
project's tab and opens the SessionLauncher **pre-filled** with the task
prompt, model, and CLI type (claude/codex) of that project's most recently
created session. The user reviews/edits and launches normally — nothing is
auto-launched.

## UX

- Trigger: `contextmenu` on a project tab only (not the Projects/home tab).
  Native browser menu suppressed on project tabs.
- Menu: floating, positioned at the cursor, one item "Duplicate last session"
  with a `CopyPlus` lucide icon. Closes on outside click, `Esc`, or tab switch.
- Result: project tab activated, launcher open in session mode with task
  textarea, model, and CLI toggle pre-filled.

## Source session selection

From the sessions list already loaded in `App.tsx` (the API returns all active
sessions plus the 50 most recent inactive ones):

- `project_id` matches the tab's project
- exclude terminals (`task === 'Terminal'`)
- exclude agents (`task` starting with `Agent (`)
- pick the most recent by `created_at`

If no matching session exists, the launcher opens anyway with the project
defaults (current behavior) — no error, the menu item is never disabled.

## Data flow (Approach A — prop chain, extends existing plumbing)

1. **`App.tsx`**
   - New state: `tabMenu: { projectId, x, y } | null` and
     `pendingPrefill: { projectId, task?, model?, cliType? } | null`.
     Prefill fields are optional: when no source session exists,
     `pendingPrefill` is set with only `projectId`, which still opens the
     launcher (un-prefilled).
   - `onContextMenu` on project tab buttons → `preventDefault()` + set `tabMenu`.
   - Menu item click → compute prefill from the sessions list, `setActiveTab`,
     set `pendingPrefill`, close menu.
   - Pass `pendingPrefill` + an `onHandled` callback (one-shot reset) to the
     matching `ProjectView`.

2. **`ProjectView.tsx`**
   - New optional props: `launchPrefill?: { task, model, cliType } | null`,
     `onLaunchPrefillHandled?: () => void`.
   - Effect: when set → `setShowLauncher(true)`, forward to the launcher via
     the existing pending-launch pattern, extended additively with
     `pendingLaunchTask` / `pendingLaunchModel` (the existing
     `pendingLaunchMode` / `pendingLaunchCliType` voice flow is unchanged).

3. **`SessionLauncher.tsx` / `LaunchForm`**
   - New optional props: `initialTask?: string`, `initialModel?: string`,
     used as `useState` initial values (same pattern as the existing
     `initialCliType`).
   - **Double-append guard:** the stored session `task` already embeds the
     project `session_prompt` (`---\nAdditional Instructions:\n…`) when one
     was set. When `initialTask` is provided, the form sets its
     `sessionPrompt` override to `''` so the project prompt is not appended a
     second time at launch.

## Edge cases

- Source session has empty/null `model` → model field stays on
  "inherit default".
- No prior plain session → launcher opens un-prefilled (project defaults).
- Right-click on the home tab → no menu.
- Only one context menu open at a time; opening another closes the first.

## Error handling

No new failure modes: no network calls are added. The prefill is computed from
client state; a missing/stale sessions list degrades to the un-prefilled
launcher.

## Testing / verification

In `dev:isolated` (server :42020, dashboard :42021, dev DB):

1. Right-click a project tab → menu appears at cursor; `Esc`/outside click
   closes it.
2. Duplicate on a project with a prior session → launcher opens with task
   textarea, model, and CLI pre-filled (verify the real DOM, not by eye).
3. Launch → `GET /api/sessions` newest row has the same `task`, `model`,
   `cli_type` as the source session, and the task does not contain the
   `Additional Instructions` block twice.
4. Duplicate on a project with no prior plain session → launcher opens with
   project defaults.
