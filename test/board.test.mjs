import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newBoard, parseBoardFile, addTask, moveTask } from "../src/board.mjs";
import { normalize, checkConfig, template } from "../src/config.mjs";

const B = { states: ["To do", "In progress", "Done"], doneStates: ["Done"], taskPrefix: "T" };
const BIN = fileURLToPath(new URL("../bin/askflow.mjs", import.meta.url));
const world = () => { const t = realpathSync(mkdtempSync(join(tmpdir(), "askflow-"))); const w = { root: join(t, "proj"), home: join(t, "home"), claude: join(t, "claude") };
  for (const d of Object.values(w)) mkdirSync(d, { recursive: true }); return w; };
const run = (w, cwd, ...args) => spawnSync("node", [BIN, ...args], { cwd, encoding: "utf8",
  env: { ...process.env, ASKFLOW_HOME: w.home, ASKFLOW_TODAY: "2026-11-22", ASKFLOW_LEDGER: "", ASKFLOW_CLAUDE_HOME: w.claude } });
const OPEN = { type: "opened", title: "First ask", goal: "G", origin: "owner", mode: "preserve", protection: "unit", surface: ["api"], verify: false, criteria: ["works"] };

test("a new Markdown board has one section per state and no tasks", () => {
  const md = newBoard("Demo", B);
  assert.match(md, /^# Board — Demo\n/);
  for (const s of B.states) assert.match(md, new RegExp(`\n## ${s}\n`));
  assert.equal(parseBoardFile(md).size, 0);
});

test("tasks are numbered by the board, land in the state asked for and keep the item they serve", () => {
  let r = addTask(newBoard("Demo", B), B, { title: "Export PDF", item: "A-0001" });
  assert.equal(r.code, "T-1");
  assert.equal(r.state, "To do");
  r = addTask(r.text, B, { title: "Fix totals", state: "in progress" });
  assert.equal(r.code, "T-2");
  const tasks = parseBoardFile(r.text);
  assert.deepEqual(tasks.get("T-1"), { state: "To do", title: "Export PDF", tag: "", item: "A-0001" });
  assert.deepEqual(tasks.get("T-2"), { state: "In progress", title: "Fix totals", tag: "", item: "" });
  assert.match(r.text, /- \[ \] T-1 · Export PDF \(A-0001\)\n/);
  assert.throws(() => addTask(r.text, B, { title: "x", state: "Blocked" }), /Unknown state «Blocked».*To do, In progress, Done/);
  assert.throws(() => addTask(r.text, B, { title: "  " }), /title/);
});

test("moving a task carries its notes, ticks it when the state is a done state, and numbering never reuses a code", () => {
  let md = addTask(newBoard("Demo", B), B, { title: "One" }).text;
  md = md.replace("- [ ] T-1 · One\n", "- [ ] T-1 · One\n  - the button appears\n  - totals match\n");
  md = addTask(md, B, { title: "Two" }).text;
  md = moveTask(md, B, "T-1", "done").text;
  const done = md.slice(md.indexOf("## Done"));
  assert.match(done, /- \[x\] T-1 · One\n  - the button appears\n  - totals match\n/);
  assert.equal(md.match(/^- \[.\] T-1 ·/gm).length, 1);
  assert.equal(parseBoardFile(md).get("T-1").state, "Done");
  assert.equal(parseBoardFile(md).get("T-2").state, "To do");
  md = moveTask(md, B, "T-1", "To do").text;
  assert.match(md, /- \[ \] T-1 · One\n  - the button appears/);
  assert.equal(addTask(md, B, { title: "Three" }).code, "T-3");
  assert.throws(() => moveTask(md, B, "T-9", "Done"), /No task T-9/);
  assert.throws(() => moveTask(md, B, "T-1", "Nowhere"), /Unknown state/);
});

test("a board edited by hand is still read: other headings, prose and a missing section do not break it", () => {
  const md = "# Board\n\nSome prose.\n\n## To do\n\n- [ ] T-4 · By hand\n- not a task\n\n### Notes\n\ntext\n";
  assert.deepEqual([...parseBoardFile(md).keys()], ["T-4"]);
  const moved = moveTask(md, B, "T-4", "Done").text;
  assert.match(moved, /## Done\n\n- \[x\] T-4 · By hand\n/);
  assert.equal(addTask(md, B, { title: "Next" }).code, "T-5");
});

test("config: the board is a tool reached through MCP or a Markdown file, and old configs keep working", () => {
  assert.equal(normalize({ name: "X" }).board.mode, "");
  assert.equal(normalize({ name: "X", board: { enabled: true } }).board.mode, "mcp");
  const file = normalize(template({ name: "X", root: "/x", board: { mode: "file" } }));
  assert.equal(file.board.enabled, true);
  assert.deepEqual(file.board.doneStates, ["Done"]);
  assert.equal(file.board.file, "BOARD.md");
  assert.deepEqual(checkConfig(file), []);
  const mcp = template({ name: "X", root: "/x", board: { mode: "mcp", tool: "Linear", mcp: "linear" } });
  assert.deepEqual([mcp.board.enabled, mcp.board.tool, mcp.board.mcp], [true, "Linear", "linear"]);
  assert.match(checkConfig(normalize({ name: "X", board: { enabled: true, mode: "trello" } })).join(), /board\.mode/);
  assert.match(checkConfig(normalize({ name: "X", board: { enabled: true, mode: "file", states: ["A"], doneStates: ["Done"] } })).join(), /doneStates/);
});

test("cli: init --board file creates BOARD.md, and board add / move / reconcile work on it with no snapshot", () => {
  const w = world();
  writeFileSync(join(w.root, "BOARD.md"), "mine\n");
  assert.equal(run(w, w.root, "init", "--yes", "--name", "Demo", "--board", "file", "--board-file", "docs/BOARD.md").status, 0);
  assert.equal(readFileSync(join(w.root, "BOARD.md"), "utf8"), "mine\n");
  const file = join(w.root, "docs", "BOARD.md");
  assert.match(readFileSync(file, "utf8"), /## In progress/);
  assert.equal(JSON.parse(run(w, w.root, "config").stdout).boardFile, file);
  run(w, w.root, "log", JSON.stringify(OPEN));
  const add = run(w, w.root, "board", "add", "Build the thing", "--item", "A-0001");
  assert.match(add.stdout, /T-1 added to «To do» and linked to A-0001/);
  assert.match(run(w, w.root, "show", "A-0001").stdout, /tasks: T-1/);
  assert.equal(run(w, w.root, "board", "add", "Orphan", "--item", "A-0099").status, 1);
  assert.ok(!readFileSync(file, "utf8").includes("Orphan"));
  assert.match(run(w, w.root, "board", "add", "Loose end").stdout, /T-2 added to «To do»/);
  assert.match(run(w, w.root, "board", "move", "T-1", "Done").stdout, /T-1 moved to «Done»/);
  assert.match(run(w, w.root, "board").stdout, /To do: 1 · In progress: 0 · Done: 1/);
  const rec = run(w, w.root, "reconcile");
  assert.match(rec.stdout, /boardDoneLedgerNot: 1/);
  assert.match(readFileSync(join(w.root, ".askflow", "views", "RECONCILIATION.md"), "utf8"), /T-2 \(To do\) Loose end/);
  assert.match(run(w, w.root, "views").stdout, /regenerated/);
  assert.match(readFileSync(join(w.root, ".askflow", "views", "SUMMARY.md"), "utf8"), /Board says done, ledger does not \(1\)/);
});

test("cli: with an MCP board the tasks live in the tool, so board add refuses and says where", () => {
  const w = world();
  const r = run(w, w.root, "init", "--yes", "--name", "Demo", "--board", "mcp", "--board-tool", "Linear", "--board-mcp", "linear");
  assert.match(r.stdout, /MCP server «linear»/);
  assert.ok(!existsSync(join(w.root, "BOARD.md")));
  const c = JSON.parse(run(w, w.root, "config").stdout).config.board;
  assert.deepEqual([c.enabled, c.mode, c.tool, c.mcp], [true, "mcp", "Linear", "linear"]);
  const add = run(w, w.root, "board", "add", "x");
  assert.equal(add.status, 1);
  assert.match(add.stderr, /Linear.*MCP server «linear»/);
  assert.match(run(w, w.root, "board").stdout, /Linear, through the MCP server «linear»/);
  assert.equal(run(w, w.root, "init", "--yes", "--board", "trello").status, 1);
});
