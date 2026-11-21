// Copies the skill and the agents into Claude Code's user folder. Their source of truth is this repository.
// Nothing is deleted: a file that differs is kept next to the new one as <name>.bak-<date>.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
export const claudeHome = () => process.env.ASKFLOW_CLAUDE_HOME || join(homedir(), ".claude");

export const install = ({ claudeHome: target = claudeHome(), today, dryRun = false } = {}) => {
  const files = [
    ["skills/askflow/SKILL.md", "skills/askflow/SKILL.md"],
    ...readdirSync(join(SOURCE, "agents")).filter((f) => f.endsWith(".md")).sort().map((f) => [`agents/${f}`, `agents/${f}`]),
  ];
  const written = [], backups = [], unchanged = [];
  for (const [from, to] of files) {
    const src = join(SOURCE, from), dest = join(target, to);
    const text = readFileSync(src, "utf8");
    if (existsSync(dest)) {
      if (readFileSync(dest, "utf8") === text) { unchanged.push(dest); continue; }
      let bak = `${dest}.bak-${today}`;
      for (let n = 2; existsSync(bak); n++) bak = `${dest}.bak-${today}-${n}`;
      if (!dryRun) copyFileSync(dest, bak);
      backups.push(bak);
    }
    if (!dryRun) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, text); }
    written.push(dest);
  }
  return { written, backups, unchanged };
};
