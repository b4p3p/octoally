# Sessions under the service unit: no display, and a cgroup that kills them

Date: 2026-09-10
Status: **both causes found and fixed.** The clipboard fix is verified end to
end in `dev:isolated` against a display-less server. The `KillMode` change is a
unit-file change and takes effect at the next service start.

Two separate faults, one shared root: the systemd unit the installed server
normally runs under. Sessions it hosts cannot reach the compositor, and
stopping it the wrong way takes every session down with it.

## 0. In one paragraph

`octoally install-service` writes a **system** unit
(`WantedBy=multi-user.target`, `User=<you>`), so the server starts at boot,
before anyone logs in, with no `WAYLAND_DISPLAY`, no `DISPLAY`, no
`XDG_RUNTIME_DIR` and no `XAUTHORITY`. Everything a session shells out to
inherits that emptiness: `wl-paste` and `xclip` cannot open the display, and
pasting an image into Claude Code silently does nothing. The same unit owns a
second trap: the tmux server that holds every open session is a child of it, so
`KillMode=mixed` means anything that kills the main process ungracefully makes
systemd SIGKILL the whole control group, terminals, Claude processes and MCP
servers included.

## 1. Pasting an image did nothing

The desktop app used to start the server itself (`startServer` runs
`octoally start`), and Electron has the session environment, so the server
inherited it and every session inherited it in turn. Under the unit that chain
is gone. Nothing logs an error: `wl-paste` fails, the paste is dropped, the
prompt stays empty.

`graphicalEnv()` in `server/src/services/pty-worker.ts` puts the variables back
by looking them up on the filesystem: the `wayland-N` socket in the runtime
dir, the `X<N>` socket in `/tmp/.X11-unix`, the `xauth_*` cookie next to the
wayland socket. Three things about it matter:

- **Per session, not once at startup.** At boot the sockets do not exist yet,
  and their names change between logins.
- **A no-op when the server already has a display.** It returns `{}` the moment
  it sees `WAYLAND_DISPLAY` or `DISPLAY`, which covers `octoally start`, the
  desktop app and every non-Linux platform.
- **Delivered twice**, because one is not enough. `sessionEnv()` covers the
  dtach and no-tmux paths; the `env KEY=VALUE` wrapper on `tmux new-session`
  covers tmux, whose new sessions inherit from the tmux *server's* environment
  and not from the client's. `set-environment -g` then covers windows opened
  in that session later.

`XDG_RUNTIME_DIR` is handed over only when its directory was really readable.
The X socket lives in `/tmp` and belongs to whoever is logged in, who on a
shared machine need not be the user the server runs as; an `XDG_RUNTIME_DIR`
pointing at a directory that does not exist is worse than none, and dbus,
pipewire and gnupg are the ones that walk into it.

## 2. How it was verified

Not by pasting an image and being happy. When the fix was first deployed the
server had been restarted **by the desktop app**, so it carried a display
already, `graphicalEnv()` returned `{}`, and the paste that started working
proved only that inheritance works.

1. The compiled function, run against this machine with the environment
   stripped (`env -u WAYLAND_DISPLAY -u DISPLAY -u XAUTHORITY -u
   XDG_RUNTIME_DIR`), returns the four real values.
2. Those values are sufficient on their own:
   `env -i WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 wl-paste
   --list-types` exits 0 and lists what is on the clipboard.
3. End to end: `dev:isolated` started with the same four variables stripped,
   one terminal session created through the API. `tmux list-panes -F
   '#{pane_start_command}'` shows the wrapper carrying all four, a session
   created by the display-carrying production server shows none, and
   `wl-paste --list-types` run **inside** the test pane exits 0.

Step 3 needs `#{pane_start_command}`, not the pane process environment. The
tmux server on a machine already in use carries the right values in its global
environment, so a pane can inherit them without the fix doing anything; the
start command is what distinguishes the two.

## 3. The deploy that killed three sessions

`deploy-dev.sh` was expected to leave open sessions alone, and the code says it
should: `killAllSessions()` kills the PTY workers only and deliberately leaves
tmux alive, `cleanupStaleRunningSessions()` marks those sessions `detached`,
and `autoReconnectDetachedSessions()` picks them up on the next start.

All true, and all irrelevant, because step 1 of the deploy was
`fuser -k 42010/tcp`. That is a SIGKILL: no handler runs, and systemd sees the
main process die of signal 9. From the journal:

```
octoally.service: Main process exited, code=killed, status=9/KILL
octoally.service: Killing process 8464 (tmux: server) with signal SIGKILL.
octoally.service: Killing process 8465 (claude) with signal SIGKILL.
octoally.service: Killing process 8710 (stefatt-mcp) with signal SIGKILL.
octoally.service: Killing process 8790 (chrome-devtools) with signal SIGKILL.
```

Three sessions, their agents and their MCP servers, in one sweep. The careful
code path never got to run.

It did not stop there. The deploy then started the server by hand while systemd
was still in its `Restart=on-failure` loop; every retry found the port taken,
the unit burned through `StartLimitBurst=5` and landed in `failed` while still
`enabled`. The install was left with a hand-started server nobody would
restart.

## 4. The fixes

**`KillMode=process`** in `scripts/service/octoally.service`. Signalling the
main process alone is enough: the server stops sessions the right way on
SIGINT, and a PTY worker whose parent dies exits through its own `disconnect`
handler, so nothing is orphaned. What survives is exactly what should: the tmux
server and the panes.

**`deploy-dev.sh` stops through whoever owns the server.** If the unit is
active it goes through `systemctl stop`, otherwise through `octoally stop`;
`fuser -k` is a last resort after the port refuses to come free, and it says
out loud that sessions may not survive. The restart is symmetric, so the port
is not stolen back from systemd.

## 5. Still open

- `cmd_start` in `bin/octoally` and `startServer` in the desktop app know
  nothing about the unit: whenever it is installed and enabled, either can take
  the port and put it back into a restart loop. The unit is a system unit, so
  the CLI cannot simply call `systemctl start` non-interactively; the fix needs
  a decision, not a patch.
- **Any** control group holding the tmux server is the same trap. Right now the
  sessions on this machine live inside the desktop app's own scope
  (`app-octoally-desktop-<pid>.scope`, `KillMode=control-group`), because the
  app started the server: quitting the app takes the terminals with it.
