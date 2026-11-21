import { test } from "node:test";
import assert from "node:assert/strict";
import { createLedger, parse } from "../src/engine.mjs";
import { normalize } from "../src/config.mjs";

// A neutral project: one client origin that demands verification, a board and a spec tool.
const cfg = (extra = {}) => normalize({
  name: "Demo",
  origins: { client: { isClient: true, requiresVerification: true }, owner: {}, finding: {}, import: {} },
  board: { enabled: true, doneStates: ["done"], foreign: { column: 7, values: ["other"] } },
  spec: { enabled: true },
  ...extra,
});
const L = createLedger(cfg());

const opened = (extra = {}) => ({
  date: "2026-11-18", item: "A-0001", type: "opened", title: "T", goal: "G", origin: "client",
  mode: "preserve", protection: "unit", surface: ["offer"], verify: true, criteria: ["c1"], ...extra,
});
const board = (rows) => new Map(Object.entries(rows).map(([k, v]) => [k, typeof v === "string" ? { state: v, title: "", tag: "" } : v]));

test("a complete opening event is valid", () => assert.deepEqual(L.validate([opened()]), []));

test("parse skips blank lines and comments and reports the broken line", () => {
  assert.equal(parse('\n// note\n{"a":1}\n').length, 1);
  assert.throws(() => parse("{nope"), /Line 1: invalid JSON/);
});

test("an origin that requires verification cannot opt out of it", () => {
  assert.match(L.validate([opened({ verify: false })]).join(), /origin «client» requires verification/);
  assert.deepEqual(L.validate([opened({ origin: "owner", verify: false })]), []);
});

test("origins come from the project configuration, not from the engine", () => {
  assert.match(L.validate([opened({ origin: "consultant" })]).join(), /unknown origin/);
  const other = createLedger(cfg({ origins: { consultant: { requiresVerification: true }, me: {} } }));
  assert.deepEqual(other.validate([opened({ origin: "consultant" })]), []);
  assert.match(other.validate([opened({ origin: "client" })]).join(), /unknown origin/);
});

test("criteria may be missing only on imported items", () => {
  assert.match(L.validate([opened({ criteria: [] })]).join(), /criteria/);
  assert.deepEqual(L.validate([opened({ criteria: [], imported: true })]), []);
});

test("nothing precedes the opening event and there is no third mode", () => {
  assert.match(L.validate([{ date: "2026-11-18", item: "A-0001", type: "partial", reason: "x" }]).join(), /first event/);
  assert.match(L.validate([opened({ mode: "new" })]).join(), /invalid mode/);
  assert.match(L.validate([opened(), opened()]).join(), /duplicate/);
});

test("partial and decision must say why", () => {
  assert.match(L.validate([opened(), { date: "2026-11-19", item: "A-0001", type: "partial" }]).join(), /reason/);
  assert.match(L.validate([opened(), { date: "2026-11-19", item: "A-0001", type: "decision", text: "x" }]).join(), /why/);
  assert.match(L.validate([opened(), { date: "2026-11-19", item: "A-0001", type: "implemented" }]).join(), /PR or commit/);
  assert.match(L.validate([opened(), { date: "2026-11-19", item: "A-0001", type: "verified" }]).join(), /evidence/);
});

test("the identifier prefix is configurable", () => {
  const K = createLedger(cfg({ idPrefix: "REQ" }));
  assert.deepEqual(K.validate([opened({ item: "REQ-0001" })]), []);
  assert.match(K.validate([opened()]).join(), /invalid item identifier/);
  const { item: _, ...noId } = opened();
  assert.equal(K.log([opened({ item: "REQ-0041" })], noId, "2026-11-22").item, "REQ-0042");
});

test("superseding marks the old item obsolete without deleting it", () => {
  const ev = [opened(), opened({ item: "A-0002" }), { date: "2026-11-20", item: "A-0002", type: "supersedes", target: "A-0001" }];
  assert.deepEqual(L.validate(ev), []);
  const items = L.compute(ev);
  assert.equal(items.get("A-0001").obsolete, true);
  assert.equal(items.get("A-0001").supersededBy, "A-0002");
  assert.equal(items.size, 2);
  assert.match(L.validate([opened(), { date: "2026-11-20", item: "A-0001", type: "supersedes", target: "A-0009" }]).join(), /existing target/);
});

test("an item split into several is obsolete and remembers all of them", () => {
  const ev = [opened(), opened({ item: "A-0002" }), opened({ item: "A-0003" }),
    { date: "2026-11-21", item: "A-0002", type: "supersedes", target: "A-0001" },
    { date: "2026-11-21", item: "A-0003", type: "supersedes", target: "A-0001" }];
  assert.deepEqual(L.compute(ev).get("A-0001").splitInto, ["A-0002", "A-0003"]);
});

test("a later pending note does not move an implemented item backwards", () => {
  const ev = [opened(), { date: "2026-11-19", item: "A-0001", type: "implemented", pr: "#1" },
    { date: "2026-11-20", item: "A-0001", type: "partial", reason: "not seen live yet" }];
  const a = L.compute(ev).get("A-0001");
  assert.equal(a.phase, "implemented, unverified");
  assert.deepEqual(a.pending, ["not seen live yet"]);
});

test("the phase is computed and closing without verification is a gap", () => {
  const ev = [opened({ spec: "s", task: "T1" }),
    { date: "2026-11-19", item: "A-0001", type: "partial", reason: "X missing" },
    { date: "2026-11-20", item: "A-0001", type: "implemented", pr: "#1" },
    { date: "2026-11-21", item: "A-0001", type: "closed" }];
  const a = L.compute(ev).get("A-0001");
  assert.equal(a.phase, "closed");
  assert.deepEqual(a.pending, ["X missing"]);
  assert.ok(a.gaps.includes("closed without verification"));
  const custom = createLedger(cfg({ done: { gapLabel: "closed without seeing it live" } }));
  assert.ok(custom.compute(ev).get("A-0001").gaps.includes("closed without seeing it live"));
});

test("spec and task gaps exist only when the project uses a spec tool and a board", () => {
  assert.deepEqual(L.compute([opened()]).get("A-0001").gaps, ["no spec", "no linked task"]);
  const bare = createLedger(cfg({ board: { enabled: false }, spec: { enabled: false } }));
  assert.deepEqual(bare.compute([opened()]).get("A-0001").gaps, []);
  const quiet = createLedger(cfg({ gaps: { missingSpec: false, missingTask: false, unknownProtection: false } }));
  assert.deepEqual(quiet.compute([opened({ protection: "unknown" })]).get("A-0001").gaps, []);
});

test("flags what the board calls done and the ledger does not", () => {
  const ev = [opened({ task: "T1" }), { date: "2026-11-19", item: "A-0001", type: "partial", reason: "X missing" }];
  const gap = "board says done, ledger does not";
  assert.ok(L.compute(ev, board({ T1: "done" })).get("A-0001").gaps.includes(gap));
  assert.ok(!L.compute(ev, board({ T1: "in_progress" })).get("A-0001").gaps.includes(gap));
  const shipped = createLedger(cfg({ board: { enabled: true, doneStates: ["shipped", "closed"] } }));
  assert.ok(shipped.compute(ev, board({ T1: "shipped" })).get("A-0001").gaps.includes(gap));
  assert.ok(!shipped.compute(ev, board({ T1: "done" })).get("A-0001").gaps.includes(gap));
});

test("log numbers the next opening, dates it and rejects what does not validate", () => {
  const book = [opened(), opened({ item: "A-0007" })];
  const { item: _, ...noId } = opened({ title: "New" });
  const e = L.log(book, { ...noId, date: undefined }, "2026-11-22");
  assert.equal(e.item, "A-0008");
  assert.equal(e.date, "2026-11-22");
  assert.throws(() => L.log(book, { item: "A-0001", type: "partial" }, "2026-11-22"), /reason/);
  assert.throws(() => L.log(book, { item: "A-0099", type: "closed" }, "2026-11-22"), /first event/);
  assert.equal(L.log([], noId, "2026-11-22").item, "A-0001");
});

test("a batch import resolves local references and refuses to load twice", () => {
  const { item: _, ...noId } = opened({ imported: true, backlog: true, criteria: [] });
  const lines = [{ ...noId, ref: "H1-001", date: "2026-08-01" }, { ...noId, ref: "H1-002", date: "2026-08-02" },
    { item: "@H1-002", type: "supersedes", target: "@H1-001", imported: true },
    { item: "@H1-002", type: "closed", imported: true }];
  const added = L.importBatch([opened()], lines, "2026-11-22");
  assert.deepEqual(added.map((e) => e.item), ["A-0002", "A-0003", "A-0003", "A-0003"]);
  assert.deepEqual(added[0].aliases, ["H1-001"]);
  assert.equal(added[2].target, "A-0002");
  assert.equal(added[0].ref, undefined);
  assert.throws(() => L.importBatch([opened(), ...added], lines, "2026-11-22"), /already imported: H1-001/);
  assert.throws(() => L.importBatch([], [{ item: "@nope", type: "closed" }], "2026-11-22"), /unknown reference @nope/);
  assert.throws(() => L.importBatch([], [{ ...noId, ref: "X", mode: "bad" }], "2026-11-22"), /invalid mode/);
});

test("reconciliation shows differences both ways, loose ends and skips foreign tasks", () => {
  const ev = [opened({ task: "T1" }), opened({ item: "A-0002", task: "T2" }), opened({ item: "A-0003" }), opened({ item: "A-0004", task: "T9" }),
    { date: "2026-11-20", item: "A-0002", type: "verified", evidence: "screenshot" }];
  const b = board({ T1: { state: "done", title: "one", tag: "" }, T2: { state: "in_testing", title: "two", tag: "" },
    T3: { state: "todo", title: "loose", tag: "" }, T4: { state: "done", title: "old", tag: "" }, T5: { state: "todo", title: "theirs", tag: "other" } });
  const r = L.reconcile(L.compute(ev, b), b);
  assert.deepEqual(r.boardDoneLedgerNot.map((a) => a.id), ["A-0001"]);
  assert.deepEqual(r.ledgerDoneBoardNot.map((a) => a.id), ["A-0002"]);
  assert.deepEqual(r.itemsWithoutTask.map((a) => a.id), ["A-0003"]);
  assert.deepEqual(r.unknownTasks, ["A-0004 → T9"]);
  assert.deepEqual(r.tasksWithoutItem, ["T3 (todo) loose"]);
  assert.match(L.reconciliationView(r, "board-x.tsv"), /Board says done, ledger does not \(1\)/);
});

test("the board snapshot is read by position and the foreign column is configurable", () => {
  const b = L.parseBoard("T1\tdone\t2026-11-01\t\ttask\tTitle one\tother\t1\t3\nT2\ttodo\t\t\tbug\tTitle two\tmine\n");
  assert.deepEqual(b.get("T1"), { state: "done", title: "Title one", tag: "other" });
  assert.equal(b.get("T2").tag, "mine");
});

test("the summary gathers what needs input and what the board calls done", () => {
  const ev = [opened({ task: "T1", spec: "s1" }), { date: "2026-11-19", item: "A-0001", type: "partial", reason: "Needs a decision from the client" }];
  const s = L.summaryView(L.compute(ev, board({ T1: "done" })), "2026-11-21");
  assert.match(s, /\*\*1 live items\*\*/);
  assert.match(s, /Needs a decision, a confirmation or a contradiction resolved \(1\)/);
  assert.match(s, /Board says done, ledger does not \(1\)/);
  assert.match(s, /\| s1 \| 1 \| 0 \| 0 \| 1 \|/);
  const bare = createLedger(cfg({ board: { enabled: false }, spec: { enabled: false } }));
  const plain = bare.summaryView(bare.compute(ev), "2026-11-21");
  assert.doesNotMatch(plain, /By spec|Board says/);
});

test("closed backlog is archived with no gaps and open backlog shows up as a possible omission", () => {
  const h = (item) => opened({ item, backlog: true, imported: true, criteria: [], protection: "unknown" });
  const ev = [opened({ task: "T1", spec: "s1" }), h("A-0002"), h("A-0003"), h("A-0004"),
    { date: "2026-11-21", item: "A-0002", type: "closed" },
    { date: "2026-11-21", item: "A-0003", type: "partial", reason: "NO TRACE: no spec or PR" },
    { date: "2026-11-21", item: "A-0004", type: "partial", reason: "something else" }];
  const items = L.compute(ev);
  assert.equal(items.get("A-0002").archived, true);
  assert.deepEqual(items.get("A-0002").gaps, []);
  assert.deepEqual(items.get("A-0003").gaps, []);
  const s = L.summaryView(items, "2026-11-21");
  assert.match(s, /\*\*1 live items\*\*/);
  assert.match(s, /1 archived backlog/);
  assert.match(s, /Open backlog \(2\)\*\*: 1 no trace/);
  const b = L.backlogView(items, "2026-11-21");
  assert.match(b, /\*\*A-0003\*\* \(2026-11-18\) T — no spec or PR/);
  assert.match(b, /## Unmarked \(1\)/);
  const marks = createLedger(cfg({ backlog: { marks: { LOST: "Lost in the mail" } } }));
  assert.match(marks.backlogView(marks.compute(ev), "2026-11-21"), /## Lost in the mail \(0\)/);
});

test("the item view shows the whole history", () => {
  const ev = [opened({ aliases: ["F-042"], source: "mail of 18 Nov" }), { date: "2026-11-19", item: "A-0001", type: "decision", text: "Keep it", why: "client said so" }];
  const v = L.itemView(L.compute(ev).get("A-0001"));
  assert.match(v, /# A-0001 — T/);
  assert.match(v, /Aliases: F-042/);
  assert.match(v, /decision — Keep it Why: client said so/);
});

test("the status view lists open items, what is pending and the gaps", () => {
  const ev = [opened(), { date: "2026-11-19", item: "A-0001", type: "partial", reason: "half way" }];
  const v = L.statusView(L.compute(ev), "2026-11-21");
  assert.match(v, /Items: 1 · open: 1/);
  assert.match(v, /- half way/);
  assert.match(v, /- A-0001: no spec; no linked task/);
});
