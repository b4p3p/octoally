import { spawn } from 'child_process';
import { graphicalEnv } from './graphical-env.js';

/** Start a GUI program that must outlive the server.
 *
 *  No shell: the path goes in as an argument, never as command text. The
 *  display comes from graphicalEnv(), since under the systemd unit the server
 *  has none. And on Linux it goes into a transient scope of its own, for the
 *  same reason tmux does (see tmuxNewSession in pty-worker.ts): an editor or
 *  file manager started from inside the unit's control group would die with it on
 *  the next `systemctl stop`. Without systemd-run it is spawned directly. */
export function launchDetached(bin: string, args: string[]): Promise<void> {
  const env = { ...process.env, ...graphicalEnv() };
  const useScope = process.platform === 'linux' && !!(env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS);
  // A launcher that exits non-zero within the grace period has failed; one
  // still running after it (or exiting cleanly) has handed off to the GUI.
  const start = (cmd: string, cmdArgs: string[]) => new Promise<void>((ok, fail) => {
    const child = spawn(cmd, cmdArgs, { env, detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.unref(); ok(); }, 3000);
    child.once('error', (err) => { clearTimeout(timer); fail(err); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) ok(); else fail(new Error(`${cmd} exited with code ${code}`));
    });
  });
  if (!useScope) return start(bin, args);
  // systemd-run --scope execs the command in place, so a failure here is
  // either no user bus or the launcher itself: retry once outside the scope.
  return start('systemd-run', ['--user', '--scope', '--quiet', '--collect', bin, ...args])
    .catch(() => start(bin, args));
}
