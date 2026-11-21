// Sets the workflow up for the coding agents the user works with. The source of truth is this repository.
//
// Claude Code gets the skill and the three agents in its user folder (~/.claude). Every other agent gets a
// short, marked section in the instructions file it reads inside the project; that section sends the agent
// to `askflow guide`, which prints the workflow and the role instructions from the installed package, so no
// second copy of the text can go stale.
//
// Nothing is deleted: a whole file that differs is kept next to the new one as <name>.bak-<date>, and in a
// shared file (AGENTS.md, GEMINI.md) only the text between the askflow markers is ever replaced.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
export const claudeHome = () => process.env.ASKFLOW_CLAUDE_HOME || join(homedir(), ".claude");

// `file` is relative to the project; an agent without one is set up in the user's home instead.
// `whole` means askflow owns the entire file; otherwise it owns only its marked section.
export const AGENTS = {
  claude: { label: "Claude Code", where: "skill and agents in ~/.claude" },
  codex: { label: "Codex", file: "AGENTS.md", where: "a section in AGENTS.md" },
  cursor: { label: "Cursor", file: ".cursor/rules/askflow.mdc", whole: true, where: ".cursor/rules/askflow.mdc" },
  gemini: { label: "Gemini CLI", file: "GEMINI.md", where: "a section in GEMINI.md" },
  generic: { label: "Any other agent that reads AGENTS.md", file: "AGENTS.md", where: "a section in AGENTS.md" },
};

// "1,3" · "codex cursor" · "all" → agent names, in the order given, without repeats.
export const parseAgents = (input, fallback = ["claude"]) => {
  const names = Object.keys(AGENTS);
  const words = String(input ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return [...fallback];
  if (words.includes("all")) return names;
  const picked = words.map((w) => {
    const name = /^\d+$/.test(w) ? names[Number(w) - 1] : w;
    if (!AGENTS[name]) throw new Error(`Unknown agent «${w}». Choose from: ${names.join(", ")} (or all).`);
    return name;
  });
  return [...new Set(picked)];
};

// The agents that look like they are in use here, to offer as the default choice.
export const detectAgents = (project, home = homedir()) => {
  const found = [];
  if (existsSync(claudeHome())) found.push("claude");
  if (existsSync(join(home, ".codex"))) found.push("codex");
  if (project && existsSync(join(project, ".cursor"))) found.push("cursor");
  if (existsSync(join(home, ".gemini"))) found.push("gemini");
  return found;
};

const ROLES = ["archivist", "pr-reviewer", "verifier"];
const body = (path) => readFileSync(join(SOURCE, path), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");

const ROLE_NOTE = `> **Reading this outside Claude Code.** Where the text below says to launch the \`askflow-archivist\`,
> \`askflow-pr-reviewer\` or \`askflow-verifier\` agent, the instructions for that role are printed by
> \`askflow guide archivist\`, \`askflow guide pr-reviewer\` and \`askflow guide verifier\`. If your tool can
> start a subagent with its own context, start one with that text as its instructions and only the inputs
> the role names. If it cannot, stop and ask the user to open a fresh session with that text: a role is
> never played by the session that wrote the code, because its value is that it has not seen your reasoning.

`;

// The workflow (no argument) or one role, as plain Markdown for any agent to read.
export const guide = (role) => {
  if (!role || role === "workflow") return ROLE_NOTE + body("skills/askflow/SKILL.md");
  if (!ROLES.includes(role)) throw new Error(`Unknown guide «${role}». Choose from: workflow, ${ROLES.join(", ")}.`);
  return body(`agents/askflow-${role}.md`);
};

const START = "<!-- askflow:start (managed by `askflow install`; write your own rules outside these markers) -->";
const END = "<!-- askflow:end -->";
const SECTION = `## askflow

This project keeps an askflow ledger of what was asked, and every piece of work goes through five gates.
Before touching code, when a new request arrives, when opening or reviewing a pull request, and before
calling anything done:

1. Run \`askflow config\`. Exit code 3 means there is no ledger for this directory: ignore this section.
2. Otherwise run \`askflow guide\` and follow what it prints. That is the workflow; do not work from memory
   of it.
3. The roles it names (\`askflow guide archivist\`, \`askflow guide pr-reviewer\`, \`askflow guide verifier\`)
   run in a subagent or in a fresh session, never in the session that wrote the code.`;
const BLOCK = `${START}\n${SECTION}\n${END}`;
const CURSOR_RULE = `---\ndescription: askflow — the ledger of what was asked and the five-gate workflow\nalwaysApply: true\n---\n\n${SECTION.replace(/^## /, "# ")}\n`;
const MARKED = /<!-- askflow:start[^\n]*-->[\s\S]*?<!-- askflow:end -->/;

const withSection = (text) => {
  if (MARKED.test(text)) return text.replace(MARKED, () => BLOCK);
  if (!text.trim()) return `${BLOCK}\n`;
  return `${text.replace(/\n*$/, "\n\n")}${BLOCK}\n`;
};

export const install = ({ agents = ["claude"], project, claudeHome: target = claudeHome(), today, dryRun = false } = {}) => {
  const written = [], backups = [], unchanged = [];
  // Replaces a whole file askflow owns, keeping the previous version if it differs.
  const put = (dest, text) => {
    if (existsSync(dest)) {
      if (readFileSync(dest, "utf8") === text) { unchanged.push(dest); return; }
      let bak = `${dest}.bak-${today}`;
      for (let n = 2; existsSync(bak); n++) bak = `${dest}.bak-${today}-${n}`;
      if (!dryRun) copyFileSync(dest, bak);
      backups.push(bak);
    }
    if (!dryRun) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, text); }
    written.push(dest);
  };
  const done = new Set();
  for (const name of agents) {
    const agent = AGENTS[name];
    if (!agent) throw new Error(`Unknown agent «${name}». Choose from: ${Object.keys(AGENTS).join(", ")}.`);
    if (!agent.file) {
      const files = ["skills/askflow/SKILL.md", ...readdirSync(join(SOURCE, "agents")).filter((f) => f.endsWith(".md")).sort().map((f) => `agents/${f}`)];
      for (const f of files) put(join(target, f), readFileSync(join(SOURCE, f), "utf8"));
      continue;
    }
    if (!project) throw new Error(`${agent.label} is set up inside a project: run this from the project folder or pass --project <dir>.`);
    const dest = join(project, agent.file);
    if (done.has(dest)) continue; // Codex and «generic» share AGENTS.md
    done.add(dest);
    if (agent.whole) { put(dest, CURSOR_RULE); continue; }
    const before = existsSync(dest) ? readFileSync(dest, "utf8") : "";
    const after = withSection(before);
    if (after === before) { unchanged.push(dest); continue; }
    if (!dryRun) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, after); }
    written.push(dest);
  }
  return { written, backups, unchanged };
};
