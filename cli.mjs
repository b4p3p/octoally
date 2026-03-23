#!/usr/bin/env node
// OctoAlly CLI — thin npm wrapper
// Version check + launch. Delegates install/update to install.sh.
// Re-entrancy guard prevents recursive loops when install.sh invokes `octoally`.

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// ── Re-entrancy guard ────────────────────────────────────────────────────────
// install.sh may call `octoally` commands (start, status, etc.) during
// install/update. If npx is in PATH, those resolve to THIS script instead of
// bin/octoally. The guard detects this and proxies directly to the real CLI.
if (process.env.__OCTOALLY_NPX_ACTIVE === "1") {
  const installDir = process.env.OCTOALLY_INSTALL_DIR || join(homedir(), "octoally");
  const localCli = join(installDir, "bin", "octoally");
  if (existsSync(localCli)) {
    const child = spawn(localCli, process.argv.slice(2), {
      stdio: "inherit",
      cwd: installDir,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", () => process.exit(1));
  } else {
    process.exit(0);
  }
  // Stop execution — the spawn handles everything.
  await new Promise(() => {});
}

// ── Constants ────────────────────────────────────────────────────────────────

const INSTALL_DIR = process.env.OCTOALLY_INSTALL_DIR || join(homedir(), "octoally");
const GITHUB_REPO = "ai-genius-automations/octoally";
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install.sh`;
const LOCAL_CLI = join(INSTALL_DIR, "bin", "octoally");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

function log(color, msg) {
  console.log(`${color}[OctoAlly]${NC} ${msg}`);
}

function isInstalled() {
  return existsSync(LOCAL_CLI) && existsSync(join(INSTALL_DIR, "server", "dist"));
}

function getPackageVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version || null;
  } catch { return null; }
}

function getLocalVersion() {
  try {
    const data = JSON.parse(readFileSync(join(INSTALL_DIR, "version.json"), "utf8"));
    return data.version || null;
  } catch { return null; }
}

function isNewer(a, b) {
  if (!a || !b) return false;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function promptYesNo(question) {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`${BOLD}${question} [Y/n]:${NC} `, resolve);
  });
  rl.close();
  return answer.toLowerCase() !== "n";
}

/** Run install.sh with the re-entrancy guard set. */
function runInstaller() {
  log(CYAN, "Running OctoAlly installer...\n");
  execSync(`bash -c "$(curl -fsSL ${INSTALL_SCRIPT_URL})"`, {
    stdio: "inherit",
    env: {
      ...process.env,
      OCTOALLY_INSTALL_DIR: INSTALL_DIR,
      __OCTOALLY_NPX_ACTIVE: "1",
    },
  });
}

function proxyCommand(args) {
  const child = spawn(LOCAL_CLI, args, {
    stdio: "inherit",
    cwd: INSTALL_DIR,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    log(RED, `Failed to run: ${err.message}`);
    process.exit(1);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || "";

// Explicit --install or --update → run installer directly
if (command === "--install" || command === "install" || command === "--update") {
  try {
    runInstaller();
  } catch (err) {
    log(RED, `Failed: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// ── Not installed → install, then launch ─────────────────────────────────────

if (!isInstalled()) {
  log(YELLOW, "OctoAlly is not installed yet.");
  if (await promptYesNo("Install OctoAlly?")) {
    try {
      runInstaller();
    } catch (err) {
      log(RED, `Installation failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    process.exit(0);
  }
  // After install, launch if it succeeded
  if (isInstalled()) {
    proxyCommand(args.length ? args : ["start"]);
  }
} else {
  // ── Installed → check for update, then launch ─────────────────────────────

  const packageVersion = getPackageVersion();
  const localVersion = getLocalVersion();

  if (packageVersion && localVersion && isNewer(packageVersion, localVersion)) {
    log(YELLOW, `Update available: v${localVersion} → v${packageVersion}`);
    if (await promptYesNo("Update before launching?")) {
      try {
        runInstaller();
      } catch (err) {
        log(RED, `Update failed: ${err.message}`);
        log(CYAN, "Launching existing version...");
      }
    }
  }

  proxyCommand(args.length ? args : ["start"]);
}
