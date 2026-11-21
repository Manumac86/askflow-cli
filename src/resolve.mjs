// Finds the ledger that belongs to a working directory.
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export const CONFIG = "askflow.config.json";
export const IN_PROJECT = ".askflow";

// askflow's own settings: the project index and remembered answers. ASKFLOW_HOME overrides it (tests, sandboxes).
export const configHome = () => process.env.ASKFLOW_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "askflow");
export const expand = (p) => (p === "~" || p?.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
export const readIndex = (home) => readJson(join(home, "projects.json"), {});
export const writeIndex = (home, index) => { mkdirSync(home, { recursive: true }); writeFileSync(join(home, "projects.json"), JSON.stringify(index, null, 2) + "\n"); };
export const readSettings = (home) => readJson(join(home, "settings.json"), {});
export const writeSettings = (home, settings) => { mkdirSync(home, { recursive: true }); writeFileSync(join(home, "settings.json"), JSON.stringify(settings, null, 2) + "\n"); };

const isLedger = (dir) => existsSync(join(dir, CONFIG));
const within = (dir, root) => dir === root || dir.startsWith(root + sep);

const fromTree = (cwd, index) => {
  // 1. Walking up: the folder is a ledger, or holds one in .askflow/.
  for (let d = cwd; ; d = dirname(d)) {
    if (isLedger(d)) return d;
    if (isLedger(join(d, IN_PROJECT))) return join(d, IN_PROJECT);
    if (dirname(d) === d) break;
  }
  // 2. The index: the registered root that contains this folder, the deepest one first.
  const roots = Object.keys(index).filter((r) => within(cwd, real(r))).sort((a, b) => b.length - a.length);
  for (const r of roots) if (isLedger(index[r])) return index[r];
  return null;
};

// Returns the ledger folder, or null when this directory has none.
// Order: explicit flag or ASKFLOW_LEDGER → the tree above cwd → the project index → the main checkout of a git worktree.
export const resolveLedger = ({ cwd = process.cwd(), flag, home = configHome() } = {}) => {
  if (flag) {
    const dir = real(expand(flag));
    if (!isLedger(dir)) throw new Error(`No askflow ledger at ${dir} (missing ${CONFIG}).`);
    return dir;
  }
  const here = real(cwd);
  const index = readIndex(home);
  const found = fromTree(here, index);
  if (found) return found;
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: here, encoding: "utf8" });
  if (git.status !== 0) return null;
  const main = real(dirname(git.stdout.trim()));
  return within(here, main) ? null : fromTree(main, index);
};
