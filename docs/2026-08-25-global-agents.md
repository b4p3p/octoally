# Analysis 2026-08-25: the default agents cost global context

Status: **done** (2026-08-25). The fix is implemented and verified; the
sections below remain as the analysis of the problem. What was actually done,
and the two deviations from the plan, are at the end: "How it was implemented".

---

## The problem

OctoAlly installs 36 agent definitions into `~/.claude/agents/`, which is a
**global** folder, not a project one. Claude Code injects the name, description
and tool list of every agent it finds there into the prompt of **every session
on that machine**, including all the sessions that have nothing to do with
OctoAlly.

Measured on 2026-08-25 on the 36 installed files:

```
total frontmatter: 21,556 characters  ≈ 5,400 tokens per session, always
full body:        259,772 characters  (loaded only if the agent actually starts)
```

That is ~5,400 tokens paid by every session, on every project, even by people
who never open the "Launch Agent" button. For a user who does not use the
feature the return is exactly zero.

The cost is not visible from any diagnostic command: `claude plugin list`
does not show agents, and no `/doctor` flags the folder. You only find it by
looking at `~/.claude/agents/` by hand, which makes the problem hard to
attribute to OctoAlly when you run into it.

## Why it is a defect and not a choice

The principle violated is the one that applies to global skills: **a feature
used from a single place must not cost every place**. The agents serve the
dashboard's picker; the price is paid by every Claude Code session on the
machine, dashboard or not.

Worth noting: the definitions are frozen at the commit that introduced them
(`57e10cf`, 2026-04-08) and have never been revisited. They declare MCP tools
(`mcp__magic__*`, `mcp__sequential-thinking__*`, `mcp__playwright__*`) that do
not exist on an arbitrary machine, and they have the model pinned in the
frontmatter (31 `sonnet`, 5 `haiku`). So the context spent is also largely
wrong, not just useless.

## How it works now

Installation — `server/src/data/default-agents.ts`:

- `AGENTS_DIR` = `~/.claude/agents`
- `MARKER_FILE` = `~/.claude/agents/.octoally-installed`
- `getBundledAgents()` reads the `.md` files from `dist/data/agents/` (or
  `src/data/agents/` in dev). The 36 files are versioned in
  `server/src/data/agents/`.
- `installDefaultAgents(force = false)`:
  - returns immediately if `!force && existsSync(MARKER_FILE)`
  - does not overwrite an existing file (`if (existsSync(dest))
    skipped.push(...)`)

Called from three places:

| Place | When | force |
|---|---|---|
| `index.ts` (~line 101) | server startup | no |
| `routes/projects.ts` (~line 698) | adding a project | no |
| `routes/projects.ts` (~line 874) | `ruflo` cleanup | **yes** |

## Careful: there are three consumers, not one

This is where a naive fix breaks something. `~/.claude/agents/<name>.md`
is read by three distinct paths, all in
`server/src/services/pty-worker.ts` → `buildAgentCommand()`:

1. **Claude, normal mode** — `claude --agent '<name>'`. The CLI resolves
   the name from the folder. It does not go through our code.
2. **Codex** — `buildCodexAgentPrompt()`. Codex has no `--agent`, so
   OctoAlly **reads the `.md` and builds a persona prompt from it**.
3. **Claude in `inheritMcp` mode** — skips `--agent` to keep the user's full
   MCP, and reuses `buildCodexAgentPrompt()`. So it reads the file too.

The file lookup is in `findAgentMdPath()` (~line 331), in this order:

```
<projectPath>/.claude/agents/<name>.md
~/.claude/agents/<name>.md
```

Removing the global installation without touching (2) and (3) sends them into
a silent fallback: `buildCodexAgentPrompt()` does not fail, it returns the
generic `"You are a ${agentType} agent."` and the persona disappears without
errors.

## The proposed fix

The agents stay in the bundle, where they already are. Nothing writes to
`~/.claude/agents/` any more. At launch, **only the requested agent** is passed.

Claude Code accepts inline definitions:

```
--agents <json>   JSON object defining custom agents
                  (e.g. '{"reviewer": {"description": "...", "prompt": "..."}}')
```

In practice:

- **`findAgentMdPath()`**: add the bundle as a source, keeping precedence for
  project and home (anyone who customised an agent must not lose it):

  ```
  <projectPath>/.claude/agents/<name>.md     ← unchanged, wins
  ~/.claude/agents/<name>.md                 ← unchanged, backward compatibility
  <bundle>/data/agents/<name>.md             ← new fallback
  ```

  With this, the Codex and `inheritMcp` paths keep working with no other
  changes: they read from the bundle when the global folder is empty.

- **`buildAgentCommand()`, normal Claude branch**: replace
  `--agent '<name>'` with `--agents '<json>'` built from the resolved `.md`,
  plus `--agent '<name>'` to select it. The YAML frontmatter needs converting
  into the shape `--agents` expects (at least `description` and `prompt`;
  check how to map `tools` and `model`, and what happens if they are
  omitted). Watch the quoting: the command already goes through `bash -c`
  with manual escaping of single quotes, and an inline JSON is far more
  fragile than a name — consider passing it via a temporary file or an
  environment variable instead of on the command line.

- **Remove `installDefaultAgents()`** and its three calls. The
  `.octoally-installed` marker becomes useless.

- **Migration** for those who already have the 36 files installed: stopping
  the install is not enough, they stay there and keep costing. An explicit
  cleanup is needed — a dashboard action, or a step in the existing `ruflo`
  cleanup — that deletes the `.md` files **matching the bundle and
  unmodified** (byte-for-byte comparison), leaving alone the ones the user
  customised or added.

## Verification

After the fix:

1. `ls ~/.claude/agents/` empty on a clean install, and no file recreated
   after a server restart or adding a project.
2. Launching a Claude agent from the dashboard: the persona is the right one
   (not the generic "You are a X agent").
3. Launching the same agent with **Codex**: same — it is the path that breaks
   first, and silently.
4. Launching with **inherit-MCP** on: same.
5. A customised agent in `<project>/.claude/agents/<name>.md` still wins over
   the bundle.
6. In any Claude Code session, `/context` no longer shows the 36 agents.

## Note on the state of the development machine (2026-08-25)

On this workstation the 36 `.md` files were **deleted by hand** from
`~/.claude/agents/`, leaving the `.octoally-installed` marker. With the current
code this is stable: the marker guard prevents reinstallation at server
startup and when adding a project. The only path that puts them back is the
`ruflo` cleanup (`force = true`), which is an explicit action.

So if the folder turns out empty during the work, **it is not a bug**: it is
this. To restore them, the bundle is intact in `server/src/data/agents/`
(36 files, versioned).

> No longer true: the note described the state *before* the fix. The marker
> was consumed by the migration's verification, and `~/.claude/agents/` on
> this machine is now genuinely empty, with no marker.

---

## How it was implemented

`server/src/data/default-agents.ts` → `bundled-agents.ts`. It no longer writes
anything to `~/.claude/agents/`: it exposes the bundle read-only
(`getBundledAgents`, `findBundledAgentPath`, `findAgentMdIn`) and the migration
`cleanupInstalledAgents()`, which deletes from the global folder only files
**byte-for-byte identical** to the bundle, and only if the
`.octoally-installed` marker is present (the proof that we put them there).
Whatever the user modified or added stays. It runs at server startup and in
the `ruflo` cleanup, in place of the old installs; the marker is removed, so
it is one-shot.

In `pty-worker.ts` the lookup is now `resolveAgentMd()`, which also returns the
**origin** (project / home / bundle), in the planned precedence order. The
normal Claude branch uses the origin to decide:

- **bundle** agent → `--agents '<json>' --agent '<name>'`, with the JSON
  built from the `.md` (`description`, `prompt` = the file body, plus `tools`
  and `model` if declared);
- **user** agent (project or home) → still only `--agent '<name>'` is passed
  and the CLI is left to resolve it. That way the YAML of a hand-written file
  does not go through our simplified parser and is not degraded.

On `model`: it is mapped as is, because the dashboard's `--model` wins over
the agent's field anyway (verified: `--model sonnet` with `model: haiku` in
the JSON runs sonnet). Behaviour identical to before.

Quoting was not a problem: the command reaches the PTY as the `argv` of
`shell -i -c`, and the JSON is a single line with its single quotes already
escaped by the existing code. The largest agent produces a ~11 KB command
line, well under the limit. No temporary file, no environment variable.

### Two things the plan did not foresee

1. **The picker would have been left empty.** The route
   `GET /projects/:id/ruflo-agents` (`routes/projects.ts`) listed agents by
   reading *only* `~/.claude/agents/` and `<project>/.claude/agents/`.
   Stopping the install without touching it would have emptied the
   "Launch Agent" list. The route now adds the bundle as a third source
   (category `bundled`). Along the way the scan order was fixed too: the
   dedup keeps the **first** match, but `global` was scanned before
   `project`, so the global one won over the local one — the opposite of
   what the comment claimed. Now: project, home, bundle.

2. **The agent name is not the file name.** Four files declare in their
   frontmatter a `name` different from the filename (`code-reviewer.md` →
   `code-reviewer-pro`, `architect-review.md` → `architect-reviewer`,
   `electorn-pro.md` → `electron-pro`, `postgres-pro.md` →
   `postgresql-pglite-pro`). The picker passes the `name`, but
   `findAgentMdPath()` looked for `<name>.md`: for these four it found
   nothing, and Codex/inherit-MCP silently fell back to the generic "You are
   a X agent" — a bug that was already there before. Resolution now tries
   the filename and then scans the folder comparing the frontmatter `name`,
   as Claude Code does.

### Verification performed

All in `dev:isolated` (:42020), actually launching the sessions and reading
the `argv` that reaches the CLI (a fake CLI that writes its arguments to a
file), with `~/.claude/agents/` empty:

1. Claude, bundle agent → `--agents` with valid JSON (key
   `code-reviewer-pro`, 10,151-byte prompt, 11 tools, model haiku) + `--agent`.
   Also tried live with `claude --print`: the persona is the right one.
2. Claude, agent overridden in the project → only `--agent python-pro`,
   no `--agents`.
3. Codex, bundle agent → full `code-reviewer-pro` persona (one of the
   four whose name differs from the file: it did not work before).
4. Codex, project agent → persona from the project file.
5. Inherit-MCP, bundle agent → full `electron-pro` persona.
6. Migration: rebuilt the pre-fix situation (36 files installed, one
   modified by hand, one foreign file added) → 35 removed, kept
   `python-pro.md` (modified) and `my-own.md` (the user's), marker
   deleted, second run a no-op.
7. Server startup and adding a project recreate no file in
   `~/.claude/agents/`.
8. Picker: 37 agents (35 `bundled` + 1 `global` + 1 `project`), with
   `python-pro` taken from the project version.
9. `tsc --noEmit` clean and `npm run build` ok: `dist/data/agents/` contains
   the 36 `.md` files and resolution from the bundle also works from `dist`.
