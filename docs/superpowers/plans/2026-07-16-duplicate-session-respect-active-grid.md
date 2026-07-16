# Duplicate Last Session — Respect Active Sessions Grid: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When "Duplicate last session" is clicked while the global Active Sessions overlay is open, show the pre-filled TaskModal on top of the grid and launch without any navigation — the overlay stays open and the new session's card appears in the grid by itself.

**Architecture:** All changes live in `dashboard/src/App.tsx` (`Dashboard` component). `duplicateLastSession` branches on `showActiveTerminals`: overlay open → set a new `overlayDuplicate` state that renders the already-exported `TaskModal` (`fixed inset-0 z-50`, stacks above the overlay's `z-20`) and launches via a local `useMutation` that mirrors `SessionLauncher`'s `createMutation`; overlay closed → existing flow byte-for-byte. The grid derives cards from the `['sessions']` query, and `ProjectView`'s sync effect adds the tab in the hidden project view, so no navigation or bookkeeping is needed after launch.

**Tech Stack:** React 19, TanStack Query v5, existing `api.sessions.create` REST helper. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-duplicate-session-respect-active-grid-design.md`

## Global Constraints

- Frontend-only (`dashboard/`): no server changes, no terminal/geometry code touched.
- `ProjectView.tsx` and `SessionLauncher.tsx` must NOT be modified.
- English for all committed code, comments, and UI strings.
- No test framework exists in `dashboard/` — verification is `tsc -b` (typecheck), `eslint`, and manual behavior checks in `dev:isolated` (server :42020, dashboard :42021). Never test on the live install.
- **Commits only on explicit user request** (user-level rule, overrides the per-step commit convention below — do NOT commit at the end of tasks; leave the working tree for the user to review).

---

### Task 1: Overlay-duplicate state, branch, and TaskModal launch path in App.tsx

**Files:**
- Modify: `dashboard/src/App.tsx` (imports at lines 1–21; `Dashboard` component: state near line 377, `duplicateLastSession` at lines 389–404, hooks after line 404, JSX after the tab context menu block that ends at line 768)

**Interfaces:**
- Consumes (all existing, verified):
  - `TaskModal` (exported from `dashboard/src/components/SessionLauncher.tsx:147`) with props `{ mode: 'session' | 'agent' | null; project: Project; agents: RufloAgent[]; codexReady: boolean; initialCliType?: 'claude' | 'codex'; initialTask?: string; initialModel?: string; onClose: () => void; onLaunch: (task: string, agentType?: string, cliType?: 'claude' | 'codex', model?: string, rememberModel?: boolean, inheritMcp?: boolean) => void }`
  - `api.sessions.create({ project_path, task, mode, project_id, cli_type, model, remember_model })` (`dashboard/src/lib/api.ts:23`)
  - `api.projects.rufloAgents(id)` (`dashboard/src/lib/api.ts:95`) — query key `['project-agents', id]` shared with `SessionLauncher.tsx:794` so the cache is reused
  - In `Dashboard`: `queryClient` (line 127), `sessions` (line 173), `projects` (line 172), `showActiveTerminals` (line 192), `dismissActiveTerminals` (line 205)
- Produces: nothing consumed by later tasks (Task 2 is verification only)

- [ ] **Step 1: Extend imports**

In `dashboard/src/App.tsx` line 2, add `useMutation`:

```tsx
import { QueryClient, QueryClientProvider, useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
```

Line 5, add the `Project` type:

```tsx
import { api, type Project } from './lib/api';
```

After line 14 (`import { ActiveTerminals } ...`), add:

```tsx
import { TaskModal } from './components/SessionLauncher';
```

- [ ] **Step 2: Add `overlayDuplicate` state**

Right after the `launchPrefill` state declaration (`App.tsx:377`), add:

```tsx
  // "Duplicate last session" invoked while the Active Sessions overlay is
  // open: render the TaskModal on top of the grid and launch in place —
  // the overlay never closes and no tab switch happens. (Spec:
  // docs/superpowers/specs/2026-07-16-duplicate-session-respect-active-grid-design.md)
  const [overlayDuplicate, setOverlayDuplicate] = useState<{
    project: Project;
    task?: string;
    model?: string;
    cliType?: 'claude' | 'codex';
  } | null>(null);
```

- [ ] **Step 3: Branch `duplicateLastSession` on the overlay**

Replace the body of `duplicateLastSession` (`App.tsx:389-404`) with:

```tsx
  const duplicateLastSession = useCallback((projectId: string) => {
    setTabMenu(null);
    // Most recent plain session of this project — terminals and agents excluded.
    // The list from the API includes the 50 most recent inactive sessions too.
    const source = sessions
      .filter((s) => s.project_id === projectId && s.task !== 'Terminal' && !s.task.startsWith('Agent ('))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    const prefill = {
      task: source?.task,
      model: source?.model || undefined,
      cliType: source?.cli_type,
    };
    // Overlay open: launch in place over the grid — no navigation, the new
    // card shows up in the grid via the ['sessions'] query. Falls through to
    // the classic flow if the project object isn't loaded yet.
    const project = projects.find((p) => p.id === projectId);
    if (showActiveTerminals && project) {
      setOverlayDuplicate({ project, ...prefill });
      return;
    }
    setLaunchPrefill({ projectId, ...prefill });
    setActiveTab(`project-${projectId}`);
    dismissActiveTerminals();
  }, [sessions, projects, showActiveTerminals, dismissActiveTerminals]);
```

Note: `setActiveTab` is a state setter (stable identity), so the dependency
array stays correct with the two additions (`projects`, `showActiveTerminals`).

- [ ] **Step 4: Agents query + create mutation**

Right after `duplicateLastSession` (before the `confirmClose` state, `App.tsx:406`), add:

```tsx
  // Agents for the overlay TaskModal — same key/fn as SessionLauncher, so the
  // cache is shared and this is usually a no-op fetch. Session mode doesn't
  // use the list, but TaskModal requires the prop.
  const { data: overlayAgentsData } = useQuery({
    queryKey: ['project-agents', overlayDuplicate?.project.id],
    queryFn: () => api.projects.rufloAgents(overlayDuplicate!.project.id),
    staleTime: 120_000,
    enabled: !!overlayDuplicate,
  });

  // Launch from the overlay TaskModal — same parameter mapping as
  // SessionLauncher's createMutation, minus navigation: on success we only
  // refresh the sessions list so the new card appears in the grid.
  const overlayCreateMutation = useMutation({
    mutationFn: (opts: { project: Project; task: string; cliType?: 'claude' | 'codex'; model?: string; rememberModel?: boolean }) =>
      api.sessions.create({
        project_path: opts.project.path,
        task: opts.task,
        mode: 'session',
        project_id: opts.project.id,
        cli_type: opts.cliType,
        model: opts.model || undefined,
        remember_model: opts.rememberModel || undefined,
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (vars.rememberModel) queryClient.invalidateQueries({ queryKey: ['projects'] });
      setOverlayDuplicate(null);
    },
  });
```

Failure behavior (per spec): on error `overlayDuplicate` is not cleared, so
the modal stays open — same as the launcher's existing behavior.

- [ ] **Step 5: Render the TaskModal over the overlay**

In the JSX, right after the closing of the project-tab context menu block
(`{tabMenu && (...)}` ends at `App.tsx:768`, just before `{confirmClose && (`
at line 770), add:

```tsx
      {/* "Duplicate last session" over the Active Sessions overlay: TaskModal
          is fixed inset-0 z-50, so it stacks above the overlay (z-20). */}
      {overlayDuplicate && (
        <TaskModal
          mode="session"
          project={overlayDuplicate.project}
          agents={overlayAgentsData?.agents ?? []}
          codexReady={true}
          initialCliType={overlayDuplicate.cliType}
          initialTask={overlayDuplicate.task}
          initialModel={overlayDuplicate.model}
          onClose={() => setOverlayDuplicate(null)}
          onLaunch={(task, _agentType, cliType, model, rememberModel) =>
            overlayCreateMutation.mutate({
              project: overlayDuplicate.project,
              task,
              cliType,
              model,
              rememberModel,
            })
          }
        />
      )}
```

- [ ] **Step 6: Typecheck and lint**

```bash
cd /home/b4p3p/progetti/octoally/dashboard && npx tsc -b && npx eslint src/App.tsx
```

Expected: both exit 0, no output. If `tsc` complains about the unused
`_agentType` parameter, rename it per the ESLint config's ignore pattern
(the codebase already uses the `_`-prefix convention, e.g. `_projectName`
in `ProjectView.tsx:109`).

### Task 2: Behavior verification in dev:isolated

**Files:**
- No file changes — verification only.

**Interfaces:**
- Consumes: the Task 1 build of `dashboard/` served by Vite on :42021 against the dev server on :42020 with the isolated DB (`~/.octoally/octoally-dev.db`).
- Produces: pass/fail evidence for the 4 spec scenarios.

- [ ] **Step 1: Start the isolated environment**

```bash
cd /home/b4p3p/progetti/octoally && npm run dev:isolated
```

Expected: server listening on :42020, Vite dev server on :42021. Open
`http://localhost:42021` in a browser (or via the chrome-devtools MCP).

- [ ] **Step 2: Seed state**

Open a project tab and launch at least one plain session from the launcher
(task text such as `echo hello from source session`), so the project has a
"last session" to duplicate and the Active Sessions grid has ≥1 card.

- [ ] **Step 3: Scenario 1 — modal over the grid**

Open the Active Sessions overlay (Monitor icon in the top bar). Right-click
the project tab → "Duplicate last session".

Verify (real DOM, not by eye):
- The TaskModal is visible and pre-filled with the source session's task text.
- The overlay is still mounted behind it (its grid cards are present in the
  DOM at the same time as the modal).

- [ ] **Step 4: Scenario 2 — launch stays in the grid**

Click Launch in the modal. Verify:
- The modal closes; the overlay is still open (no tab switch, no full-screen
  session view).
- Within a few seconds a new card appears in the grid for the new session.
- `curl -s http://localhost:42020/api/sessions | jq '.sessions[0] | {task, model, cli_type, status}'`
  shows the new session with the same `task`/`model`/`cli_type` as the
  source, and the task does NOT contain the `Additional Instructions` block
  twice.

- [ ] **Step 5: Scenario 3 — cancel is a no-op**

Duplicate again from the overlay, then press Esc (or click Cancel). Verify:
the modal closes, the overlay is untouched, and `GET /api/sessions` shows no
new session.

- [ ] **Step 6: Scenario 4 — classic flow intact**

Close the overlay (Back). Right-click the project tab → "Duplicate last
session". Verify the pre-existing behavior: project tab activated, full-page
launcher with the pre-filled TaskModal, and launching opens the session in
single view.

- [ ] **Step 7: Report**

Report the four scenario results to the user. Do not commit — the user
decides when to commit.

### Task 3: Render pending sessions in the Active Sessions grid (spawn trigger)

*Added after Task 2 found Scenario 2 failing: an overlay-launched session
stays `pending` forever (watchdog auto-fails it at 90s) because the PTY
spawn is lazy — it fires on the first `resize` on the session's terminal
WebSocket (`server/src/routes/terminal.ts:101`), sent by every mounted
`Terminal` on connect (`Terminal.tsx:481`, passive viewers included) — and
the grid only mounted cards for `running`/`detached` sessions, so nothing
ever attached. User-approved fix: give `pending` sessions a card too.*

**Files:**
- Modify: `dashboard/src/components/ActiveTerminals.tsx:223-225` (card status filter) and `dashboard/src/components/ActiveTerminals.tsx:152-155` (minimized-tray aliveIds set)

**Interfaces:**
- Consumes: `Session.status` values from the `['sessions']` query (existing).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Include pending in the card filter**

At `ActiveTerminals.tsx:223-225`, change:

```tsx
  const activeSessions = sessions.filter(
    (s) => s.status === 'running' || s.status === 'detached'
  );
```

to:

```tsx
  // 'pending' included: a freshly-created session only spawns its PTY when
  // a mounted Terminal attaches and sends the first resize (lazy spawn) —
  // the grid card must mount for overlay-launched sessions to ever start.
  const activeSessions = sessions.filter(
    (s) => s.status === 'running' || s.status === 'detached' || s.status === 'pending'
  );
```

- [ ] **Step 2: Include pending in the minimized-tray aliveIds set**

At `ActiveTerminals.tsx:152-155`, apply the same status addition to the
`aliveIds` set that prunes stale minimized session IDs:

```tsx
    const aliveIds = new Set(
      sessions.filter((s) => s.status === 'running' || s.status === 'detached' || s.status === 'pending').map((s) => s.id),
    );
```

- [ ] **Step 3: Typecheck and lint**

```bash
cd /home/b4p3p/progetti/octoally/dashboard && npx tsc -b && npx eslint src/components/ActiveTerminals.tsx
```

Expected: `tsc -b` exits 0; eslint reports no NEW issues on the changed lines
(pre-existing issues elsewhere in the file are not findings).

- [ ] **Step 4: Re-verify Scenario 2 in dev:isolated**

Re-run Task 2's Scenario 2 (duplicate from the overlay → launch): the new
card must appear in the grid while `pending` (warning dot), the session must
reach `running` within a few seconds (spawn triggered by the card's
Terminal), and the overlay must stay open. Kill the created session and stop
dev:isolated afterwards.
