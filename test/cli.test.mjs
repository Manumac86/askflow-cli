import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalize, checkConfig, template } from "../src/config.mjs";
import { resolveLedger } from "../src/resolve.mjs";
import { init } from "../src/init.mjs";
import { install, parseAgents, guide, AGENTS } from "../src/install.mjs";

const BIN = fileURLToPath(new URL("../bin/askflow.mjs", import.meta.url));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "askflow-")));
// Every test gets its own project root, config home and memory repo: nothing touches the real ones.
const world = () => { const t = tmp(); const w = { root: join(t, "proj"), home: join(t, "home"), memory: join(t, "memory"), claude: join(t, "claude") };
  for (const d of Object.values(w)) mkdirSync(d, { recursive: true }); return w; };
const run = (w, cwd, ...args) => spawnSync("node", [BIN, ...args], { cwd, encoding: "utf8",
  env: { ...process.env, ASKFLOW_HOME: w.home, ASKFLOW_TODAY: "2026-11-22", ASKFLOW_LEDGER: "", ASKFLOW_CLAUDE_HOME: w.claude } });
const OPEN = { type: "opened", title: "First ask", goal: "G", origin: "owner", mode: "preserve", protection: "unit", surface: ["api"], verify: false, criteria: ["works"] };

test("config: defaults fill in, the project's origins replace the default ones, and bad configs are reported", () => {
  const c = normalize({ name: "X", origins: { consultant: {} } });
  assert.deepEqual(Object.keys(c.origins), ["consultant"]);
  assert.equal(c.idPrefix, "A");
  assert.equal(c.board.enabled, false);
  assert.deepEqual(checkConfig(c), []);
  assert.match(checkConfig(normalize({ origins: {} })).join(), /name/);
  assert.match(checkConfig(normalize({ name: "X", origins: {} })).join(), /origin/);
  assert.match(checkConfig(normalize({ name: "X", idPrefix: "a-1" })).join(), /idPrefix/);
  assert.deepEqual(checkConfig(normalize(template({ name: "X", root: "/x" }))), []);
});

test("init inside the project creates the ledger, declares day zero and never overwrites", () => {
  const w = world();
  const r = init({ root: w.root, name: "Demo", store: "project", home: w.home, today: "2026-11-22" });
  assert.equal(r.ledger, join(w.root, ".askflow"));
  assert.equal(readFileSync(join(r.ledger, "events.jsonl"), "utf8"), "");
  assert.equal(JSON.parse(readFileSync(join(r.ledger, "askflow.config.json"), "utf8")).name, "Demo");
  assert.ok(existsSync(join(r.ledger, "DAY-ZERO")));
  assert.ok(existsSync(join(r.ledger, "README.md")));
  assert.throws(() => init({ root: w.root, name: "Demo", store: "project", home: w.home, today: "2026-11-22" }), /already/);
});

test("init with prior history leaves day zero undeclared and explains the initial load", () => {
  const w = world();
  const r = init({ root: w.root, name: "Demo", store: "project", history: true, home: w.home, today: "2026-11-22" });
  assert.ok(!existsSync(join(r.ledger, "DAY-ZERO")));
  assert.match(readFileSync(join(r.ledger, "README.md"), "utf8"), /askflow import/);
  assert.equal(r.dayZero, false);
});

test("init in a memory repo or any other path registers the project so nothing is written in the repo", () => {
  const w = world();
  const r = init({ root: w.root, name: "Demo", store: "memory", memoryRepo: w.memory, slug: "demo", home: w.home, today: "2026-11-22" });
  assert.equal(r.ledger, join(w.memory, "projects", "demo", "ledger"));
  assert.ok(!existsSync(join(w.root, ".askflow")));
  assert.equal(JSON.parse(readFileSync(join(w.home, "projects.json"), "utf8"))[w.root], r.ledger);
  const w2 = world(); const elsewhere = join(w2.memory, "some", "where");
  assert.equal(init({ root: w2.root, name: "D", store: "path", path: elsewhere, home: w2.home, today: "2026-11-22" }).ledger, elsewhere);
  assert.throws(() => init({ root: w2.root, name: "D", store: "memory", home: w2.home, today: "2026-11-22" }), /memory repo/);
  assert.throws(() => init({ root: w2.root, name: "D", store: "nope", home: w2.home, today: "2026-11-22" }), /store/);
});

test("init --ignore keeps the in-project ledger out of git without touching other ignore rules", () => {
  const w = world();
  writeFileSync(join(w.root, ".gitignore"), "node_modules\n");
  init({ root: w.root, name: "Demo", store: "project", gitignore: true, home: w.home, today: "2026-11-22" });
  assert.equal(readFileSync(join(w.root, ".gitignore"), "utf8"), "node_modules\n.askflow/\n");
});

test("the ledger is found from a subfolder, by flag, through the index, or not at all", () => {
  const w = world();
  init({ root: w.root, name: "Demo", store: "project", home: w.home, today: "2026-11-22" });
  const sub = join(w.root, "src", "deep"); mkdirSync(sub, { recursive: true });
  assert.equal(resolveLedger({ cwd: sub, home: w.home }), join(w.root, ".askflow"));
  assert.equal(resolveLedger({ cwd: join(w.root, ".askflow"), home: w.home }), join(w.root, ".askflow"));
  const m = world();
  const r = init({ root: m.root, name: "Demo", store: "memory", memoryRepo: m.memory, slug: "demo", home: m.home, today: "2026-11-22" });
  const msub = join(m.root, "a"); mkdirSync(msub);
  assert.equal(resolveLedger({ cwd: msub, home: m.home }), r.ledger);
  assert.equal(resolveLedger({ cwd: w.memory, home: w.home }), null);
  assert.equal(resolveLedger({ cwd: w.memory, home: w.home, flag: r.ledger }), r.ledger);
  assert.throws(() => resolveLedger({ cwd: w.memory, home: w.home, flag: w.memory }), /no askflow ledger at/i);
});

test("a git worktree of a registered project resolves to the same ledger", () => {
  const w = world();
  const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
  git(w.root, "init", "-q"); git(w.root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  const r = init({ root: w.root, name: "Demo", store: "memory", memoryRepo: w.memory, slug: "demo", home: w.home, today: "2026-11-22" });
  const wt = join(w.home, "wt");
  assert.equal(git(w.root, "worktree", "add", "-q", wt).status, 0);
  assert.equal(resolveLedger({ cwd: realpathSync(wt), home: w.home }), r.ledger);
});

test("cli: a project without a ledger is told so and nothing is created", () => {
  const w = world();
  const r = run(w, w.root, "validate");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /No askflow ledger/);
  assert.equal(run(w, w.root, "config").status, 3);
});

test("cli: init, log, show, views and config work end to end from a subfolder", () => {
  const w = world();
  assert.equal(run(w, w.root, "init", "--yes", "--name", "Demo", "--store", "project").status, 0);
  const sub = join(w.root, "src"); mkdirSync(sub);
  const logged = run(w, sub, "log", JSON.stringify(OPEN));
  assert.match(logged.stdout, /A-0001 · opened logged/);
  assert.match(run(w, sub, "show", "A-0001").stdout, /# A-0001 — First ask/);
  assert.match(run(w, sub, "validate").stdout, /Ledger valid: 1 events, 1 items/);
  assert.equal(run(w, sub, "views").status, 0);
  const ledger = join(w.root, ".askflow");
  assert.match(readFileSync(join(ledger, "views", "SUMMARY.md"), "utf8"), /Generated on 2026-11-22/);
  assert.ok(existsSync(join(ledger, "views", "STATUS.md")));
  const cfg = JSON.parse(run(w, sub, "config").stdout);
  assert.equal(cfg.ledger, ledger);
  assert.equal(cfg.config.name, "Demo");
  const bad = run(w, sub, "log", JSON.stringify({ item: "A-0001", type: "partial" }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /reason/);
  assert.equal(readFileSync(join(ledger, "events.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("cli: before day zero only import writes; day-zero then opens the ledger to log", () => {
  const w = world();
  run(w, w.root, "init", "--yes", "--name", "Demo", "--store", "project", "--history");
  assert.match(run(w, w.root, "log", JSON.stringify(OPEN)).stderr, /Day zero has not been declared/);
  const batch = join(w.home, "batch.jsonl");
  writeFileSync(batch, [{ ...OPEN, ref: "H-1", imported: true, backlog: true, date: "2026-01-05" }, { item: "@H-1", type: "closed", imported: true }].map((e) => JSON.stringify(e)).join("\n"));
  const dry = run(w, w.root, "import", batch);
  assert.match(dry.stdout, /Dry run/);
  assert.equal(readFileSync(join(w.root, ".askflow", "events.jsonl"), "utf8"), "");
  assert.match(run(w, w.root, "import", batch, "--apply").stdout, /2 events appended/);
  assert.equal(run(w, w.root, "import", batch, "--apply").status, 1);
  assert.match(run(w, w.root, "day-zero").stdout, /Day zero declared on 2026-11-22 with 2 events and 1 items/);
  assert.equal(run(w, w.root, "day-zero").status, 1);
  assert.match(run(w, w.root, "log", JSON.stringify(OPEN)).stdout, /A-0002 · opened logged/);
});

test("cli: reconcile needs a board snapshot and writes the reconciliation view", () => {
  const w = world();
  run(w, w.root, "init", "--yes", "--name", "Demo", "--store", "project");
  const ledger = join(w.root, ".askflow");
  const p = join(ledger, "askflow.config.json");
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), board: { enabled: true, doneStates: ["done"] } }));
  run(w, w.root, "log", JSON.stringify({ ...OPEN, task: "T1" }));
  assert.match(run(w, w.root, "reconcile").stderr, /No board snapshot/);
  writeFileSync(join(ledger, "board-2026-11-22.tsv"), "T1\tdone\t\t\ttask\tOne\nT2\ttodo\t\t\ttask\tTwo\n");
  assert.match(run(w, w.root, "reconcile").stdout, /boardDoneLedgerNot: 1/);
  assert.match(readFileSync(join(ledger, "views", "RECONCILIATION.md"), "utf8"), /T2 \(todo\) Two/);
});

test("cli: a broken configuration stops every command", () => {
  const w = world();
  run(w, w.root, "init", "--yes", "--name", "Demo", "--store", "project");
  writeFileSync(join(w.root, ".askflow", "askflow.config.json"), JSON.stringify({ name: "Demo", origins: {} }));
  const r = run(w, w.root, "validate");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /origin/);
});

test("install copies the skill and the agents and keeps a backup of what it replaces", () => {
  const w = world();
  const first = install({ claudeHome: w.claude, today: "2026-11-22" });
  assert.ok(first.written.length >= 4);
  const skill = join(w.claude, "skills", "askflow", "SKILL.md");
  assert.match(readFileSync(skill, "utf8"), /^---\nname: askflow\n/);
  for (const a of ["askflow-archivist", "askflow-pr-reviewer", "askflow-verifier"]) assert.ok(existsSync(join(w.claude, "agents", `${a}.md`)));
  assert.deepEqual(install({ claudeHome: w.claude, today: "2026-11-22" }).written, []);
  writeFileSync(skill, "mine");
  const again = install({ claudeHome: w.claude, today: "2026-11-22" });
  assert.equal(again.backups.length, 1);
  assert.equal(readFileSync(again.backups[0], "utf8"), "mine");
});

test("parseAgents accepts numbers, names and «all», drops repeats and rejects what it does not know", () => {
  const names = Object.keys(AGENTS);
  assert.deepEqual(names, ["claude", "codex", "cursor", "gemini", "generic"]);
  assert.deepEqual(parseAgents("1, 3"), ["claude", "cursor"]);
  assert.deepEqual(parseAgents("codex cursor,codex"), ["codex", "cursor"]);
  assert.deepEqual(parseAgents("ALL"), names);
  assert.deepEqual(parseAgents("", ["gemini"]), ["gemini"]);
  assert.throws(() => parseAgents("copilot"), /Unknown agent «copilot»/);
  assert.throws(() => parseAgents("9"), /Unknown agent «9»/);
});

test("guide prints the workflow and each role without front matter, and says how to run a role without subagents", () => {
  const flow = guide();
  assert.ok(!flow.startsWith("---"));
  assert.match(flow, /## Gate 1 — Entry/);
  assert.match(flow, /askflow guide pr-reviewer/);
  assert.match(flow, /fresh session/);
  const role = guide("pr-reviewer");
  assert.ok(!/^tools:/m.test(role));
  assert.match(role, /reviewing a PR you did not write/);
  assert.throws(() => guide("nobody"), /Unknown guide «nobody»/);
});

test("install for other agents writes a marked section in the project and leaves the rest of the file alone", () => {
  const w = world();
  writeFileSync(join(w.root, "AGENTS.md"), "# House rules\n\nUse tabs.\n");
  const first = install({ agents: ["codex", "generic", "cursor", "gemini"], project: w.root, claudeHome: w.claude, today: "2026-11-22" });
  assert.deepEqual(first.written.sort(), [join(w.root, ".cursor", "rules", "askflow.mdc"), join(w.root, "AGENTS.md"), join(w.root, "GEMINI.md")].sort());
  assert.deepEqual(first.backups, []);
  assert.ok(!existsSync(join(w.claude, "skills")));
  const agentsMd = readFileSync(join(w.root, "AGENTS.md"), "utf8");
  assert.ok(agentsMd.startsWith("# House rules\n\nUse tabs.\n"));
  assert.match(agentsMd, /<!-- askflow:start[^\n]*-->[\s\S]*askflow guide[\s\S]*<!-- askflow:end -->/);
  assert.match(readFileSync(join(w.root, ".cursor", "rules", "askflow.mdc"), "utf8"), /^---\n[\s\S]*alwaysApply: true\n---\n/);
  assert.match(readFileSync(join(w.root, "GEMINI.md"), "utf8"), /askflow guide/);
  assert.deepEqual(install({ agents: ["codex", "cursor", "gemini"], project: w.root, claudeHome: w.claude, today: "2026-11-22" }).written, []);
  // A stale section is replaced in place; what the user wrote around it stays.
  writeFileSync(join(w.root, "AGENTS.md"), agentsMd.replace(/(<!-- askflow:start[^\n]*-->)[\s\S]*(<!-- askflow:end -->)/, "$1\nold text\n$2") + "\n## After\n");
  const again = install({ agents: ["codex"], project: w.root, claudeHome: w.claude, today: "2026-11-22" });
  assert.deepEqual(again.written, [join(w.root, "AGENTS.md")]);
  const updated = readFileSync(join(w.root, "AGENTS.md"), "utf8");
  assert.ok(!updated.includes("old text"));
  assert.ok(updated.startsWith("# House rules") && updated.endsWith("## After\n"));
  assert.equal(updated.match(/askflow:start/g).length, 1);
});

test("install: dry run writes nothing, and a project agent needs a project", () => {
  const w = world();
  const r = install({ agents: ["claude", "gemini"], project: w.root, claudeHome: w.claude, today: "2026-11-22", dryRun: true });
  assert.ok(r.written.includes(join(w.root, "GEMINI.md")) && r.written.length >= 5);
  assert.ok(!existsSync(join(w.root, "GEMINI.md")) && !existsSync(join(w.claude, "skills")));
  assert.throws(() => install({ agents: ["cursor"], claudeHome: w.claude, today: "2026-11-22" }), /project/);
});

test("cli: guide, install --agent and init --agent", () => {
  const w = world();
  assert.match(run(w, w.root, "guide").stdout, /## Gate 5 — Close/);
  assert.match(run(w, w.root, "guide", "verifier").stdout, /live system/);
  assert.equal(run(w, w.root, "guide", "nobody").status, 1);
  const bad = run(w, w.root, "install", "--agent", "copilot");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown agent «copilot»/);
  const other = join(w.home, "elsewhere"); mkdirSync(other);
  assert.match(run(w, w.root, "install", "--agent", "codex,claude", "--project", other).stdout, /written/);
  assert.ok(existsSync(join(other, "AGENTS.md")) && existsSync(join(w.claude, "skills", "askflow", "SKILL.md")));
  // With no terminal and no --agent, install keeps doing what it always did: Claude Code only.
  const w2 = world();
  run(w2, w2.root, "install");
  assert.ok(existsSync(join(w2.claude, "agents", "askflow-verifier.md")) && !existsSync(join(w2.root, "AGENTS.md")));
  const init2 = run(w2, w2.root, "init", "--yes", "--name", "Demo", "--agent", "cursor");
  assert.equal(init2.status, 0);
  assert.ok(existsSync(join(w2.root, ".cursor", "rules", "askflow.mdc")));
  assert.ok(existsSync(join(w2.root, ".askflow", "events.jsonl")));
});
