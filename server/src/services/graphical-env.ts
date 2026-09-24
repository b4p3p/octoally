import { readdirSync } from 'fs';
import { join } from 'path';

/** Re-discover the graphical session vars when the server itself has none.
 *
 *  Installed with `octoally install-service` the server is a system unit
 *  (WantedBy=multi-user.target): it starts at boot, before anyone logs in, so
 *  it has no session environment: no WAYLAND_DISPLAY, no DISPLAY and no
 *  XDG_RUNTIME_DIR. Those used to arrive by inheritance, because the desktop
 *  app started the server itself (`startServer` -> `octoally start`) and
 *  Electron has them. Under the unit nothing a session shells out to can reach
 *  the compositor: `wl-paste` and `xclip` both fail, and pasting an image into
 *  Claude Code silently does nothing.
 *
 *  The sockets are looked up per session, not once at startup, because at boot
 *  they do not exist yet and their names change between logins. A server that
 *  already inherited a display is left alone, which makes this a no-op for
 *  `octoally start`, for the desktop app and for every non-Linux platform. */
export function graphicalEnv(): Record<string, string> {
  if (process.platform !== 'linux') return {};
  if (process.env.WAYLAND_DISPLAY || process.env.DISPLAY) return {};
  if (typeof process.getuid !== 'function') return {};

  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  let entries: string[] = [];
  let runtimeDirReadable = false;
  try { entries = readdirSync(runtimeDir); runtimeDirReadable = true; } catch { /* not logged in yet */ }

  const found: Record<string, string> = {};

  const wayland = entries.filter((e) => /^wayland-\d+$/.test(e)).sort()[0];
  if (wayland) found.WAYLAND_DISPLAY = wayland;

  // X11, and XWayland on a Wayland session: the socket names the display, the
  // cookie sitting in the runtime dir is what is allowed to open it.
  let xSockets: string[] = [];
  try { xSockets = readdirSync('/tmp/.X11-unix'); } catch { /* no X server here */ }
  const xSocket = xSockets.filter((e) => /^X\d+$/.test(e)).sort()[0];
  if (xSocket) {
    found.DISPLAY = `:${xSocket.slice(1)}`;
    const cookie = entries.find((e) => e.startsWith('xauth_'));
    if (cookie) found.XAUTHORITY = join(runtimeDir, cookie);
  }

  // Headless machine: hand over nothing rather than a runtime dir on its own.
  if (!found.WAYLAND_DISPLAY && !found.DISPLAY) return {};
  // The X socket lives in /tmp and belongs to whoever is logged in, who on a
  // shared machine need not be the user this server runs as. Pass the runtime
  // dir on only when it was really there: an XDG_RUNTIME_DIR pointing at a
  // directory that does not exist is worse than none, and dbus, pipewire and
  // gnupg are the ones that walk into it.
  if (runtimeDirReadable) found.XDG_RUNTIME_DIR = runtimeDir;
  return found;
}
