import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';

/** Resolve the octoally CLI path (mirrors Rust logic in desktop/src/main.rs) */
export function resolveCliPath(): string {
  // Check the standard install path directly first
  if (fs.existsSync('/usr/local/bin/octoally')) {
    // Resolve symlinks — use realpath (works on macOS + Linux) with readlink -f as fallback
    try {
      const resolved = execFileSync('realpath', ['/usr/local/bin/octoally'], {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {}
    try {
      const resolved = execFileSync('readlink', ['-f', '/usr/local/bin/octoally'], {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {}
    return '/usr/local/bin/octoally';
  }

  // Fallback: check ~/.local/bin
  const home = process.env.HOME;
  if (home) {
    const localPath = path.join(home, '.local/bin/octoally');
    if (fs.existsSync(localPath)) return localPath;
  }

  // Last resort: rely on PATH
  return 'octoally';
}

/** Check if OctoAlly server is currently running */
export function isServerRunning(cli: string): boolean {
  try {
    const stdout = execFileSync(cli, ['status'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return stdout.includes('running');
  } catch (e: any) {
    // CLI may exit non-zero but still output status — check stdout/stderr
    const output = (e.stdout || '') + (e.stderr || '');
    if (output.includes('running')) return true;
    return false;
  }
}

/** Check if the server is reachable via HTTP */
export function isServerReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:42010/api/health', (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Build a PATH that includes node binary directories that may not be present
 * when the app is launched from a desktop environment (e.g. task manager, dock).
 * Interactive shells load nvm/fnm/volta via .bashrc/.zshrc, but desktop-launched
 * processes inherit the bare session environment which typically lacks these.
 *
 * NOTE: near-duplicate of server/src/utils/enrich-path.ts because Electron and
 * the server are separate build targets that cannot share modules at runtime.
 * They diverge on purpose: that one enriches the PATH handed to agent sessions,
 * where the newest available node is a reasonable pick, while this one decides
 * which node runs OUR server and therefore must not switch runtime (see below).
 */
function buildNodeAwarePath(): string {
  const currentPath = process.env.PATH || '';
  const home = os.homedir();
  const extraDirs: string[] = [];

  // Common system paths that may be missing from desktop sessions
  for (const p of ['/usr/local/bin', path.join(home, '.local', 'bin')]) {
    if (fs.existsSync(p)) extraDirs.push(p);
  }

  // Version managers are a LAST RESORT, consulted only when no node is
  // reachable at all. Prepending, say, the newest installed nvm version when
  // the session already has a node switches the runtime behind the user's
  // back — and the server's native modules (better-sqlite3, node-pty) are
  // compiled for a single NODE_MODULE_VERSION, so a different Node major makes
  // them fail to load and the server dies at startup with ERR_DLOPEN_FAILED.
  if (!hasNodeIn([...currentPath.split(':'), ...extraDirs])) {
    extraDirs.push(...versionManagerNodeDirs(home));
  }

  // Prepend discovered dirs to PATH (only those not already present)
  const pathSet = new Set(currentPath.split(':'));
  const toAdd = extraDirs.filter((d) => !pathSet.has(d));

  return toAdd.length > 0 ? [...toAdd, currentPath].join(':') : currentPath;
}

/** True when any of these directories provides an executable `node`. */
function hasNodeIn(dirs: string[]): boolean {
  return dirs.some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, 'node'), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Node bin directories owned by version managers, best candidate first. */
function versionManagerNodeDirs(home: string): string[] {
  const dirs: string[] = [];

  // nvm: the version the user made default first, the newest installed after
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(nvmVersionsDir)) {
    // The default alias is what an interactive shell would have given us —
    // prefer it over "newest installed", which changes under the app every
    // time the user installs a Node major.
    try {
      const alias = fs.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf-8').trim();
      if (alias) {
        const aliasDir = path.join(nvmVersionsDir, alias.startsWith('v') ? alias : `v${alias}`, 'bin');
        if (fs.existsSync(aliasDir)) dirs.push(aliasDir);
      }
    } catch {}
    const newest = newestVersionDir(nvmVersionsDir);
    if (newest) dirs.push(path.join(nvmVersionsDir, newest, 'bin'));
  }

  // fnm (Fast Node Manager)
  const fnmDir = path.join(home, '.local', 'share', 'fnm', 'node-versions');
  if (fs.existsSync(fnmDir)) {
    const newest = newestVersionDir(fnmDir);
    if (newest) dirs.push(path.join(fnmDir, newest, 'installation', 'bin'));
  }

  // volta
  const voltaBin = path.join(home, '.volta', 'bin');
  if (fs.existsSync(voltaBin)) {
    dirs.push(voltaBin);
  }

  return dirs;
}

/** Highest vX.Y.Z directory name inside dir, or null. */
function newestVersionDir(dir: string): string | null {
  try {
    const versions = fs.readdirSync(dir)
      .filter((d) => d.startsWith('v'))
      .sort((a, b) => {
        const pa = a.slice(1).split('.').map(Number);
        const pb = b.slice(1).split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
        }
        return 0;
      });
    return versions.length > 0 ? versions[versions.length - 1] : null;
  } catch {
    return null;
  }
}

/** Start the server via CLI */
export function startServer(cli: string): Promise<boolean> {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: buildNodeAwarePath() };
    // Generous timeout: when the Node ABI changed since install, `start` first
    // rebuilds better-sqlite3/node-pty, which can take minutes on a cold
    // node-gyp compile. Killing it at 15s would leave the rebuild unfinished
    // and the server permanently unstartable.
    execFile(cli, ['start'], { timeout: 300000, env }, (err) => {
      if (err) {
        console.error('[OctoAlly] Failed to start server:', err.message);
      }
      resolve(!err);
    });
  });
}

/** Stop the server via CLI */
export function stopServer(cli: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cli, ['stop'], { timeout: 10000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Stop whatever process is listening on port 42010 (for external/unknown servers) */
export function stopServerOnPort(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('fuser', ['-k', '42010/tcp'], { timeout: 10000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Wait for the server to become reachable, polling every 500ms */
export async function waitForServer(maxWaitMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isServerReachable()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Check if the systemd/launchd service is installed */
export function isServiceInstalled(): boolean {
  if (process.platform === 'linux') {
    return fs.existsSync('/etc/systemd/system/octoally.service');
  }
  if (process.platform === 'darwin') {
    const home = process.env.HOME;
    if (home) {
      return fs.existsSync(
        path.join(home, 'Library/LaunchAgents/com.aigenius.octoally.plist'),
      );
    }
  }
  return false;
}

/** Toggle service install/uninstall */
export function toggleService(cli: string): Promise<boolean> {
  const installed = isServiceInstalled();
  const cmd = installed ? 'uninstall-service' : 'install-service';

  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      // Use pkexec for graphical sudo prompt (same as Tauri version)
      execFile('pkexec', [cli, cmd], { timeout: 30000 }, (err) => {
        resolve(!err);
      });
    } else {
      execFile(cli, [cmd], { timeout: 30000 }, (err) => {
        resolve(!err);
      });
    }
  });
}
