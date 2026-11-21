#!/usr/bin/env node
// askflow: an append-only ledger of what was asked, and the five gates every ask goes through.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createLedger, parse } from "../src/engine.mjs";
import { normalize, checkConfig } from "../src/config.mjs";
import { resolveLedger, configHome, readSettings, CONFIG, expand } from "../src/resolve.mjs";
import { init, dayZeroText, slugify, STORES } from "../src/init.mjs";
import { install, claudeHome } from "../src/install.mjs";

const HELP = `askflow — from ask to verified

Setup
  askflow init [options]        set a project up (asks what it needs; --yes takes the defaults)
      --root <dir>              project folder (default: current directory)
      --name <name>             project name (default: folder name)
      --store project|memory|path
                                where the ledger lives: inside the project (.askflow/), in a memory
                                repo (<repo>/projects/<slug>/ledger) or at any other path
      --memory-repo <dir>       the memory repo, for --store memory (remembered after the first time)
      --slug <slug>             folder name inside the memory repo
      --path <dir>              the ledger folder, for --store path
      --ignore                  with --store project: add .askflow/ to .gitignore
      --history                 the project has earlier asks to load: day zero is left undeclared
  askflow install [--dry-run]   copy the skill and the agents into Claude Code (~/.claude)

Daily use (run from anywhere inside the project)
  askflow config                where the ledger is and how the project is configured (JSON)
  askflow validate              check the book
  askflow views                 regenerate views/SUMMARY.md, STATUS.md and BACKLOG.md
  askflow show <id>             full history of one item
  askflow log '<json>'          append one event (the only way to write after day zero)
  askflow reconcile             compare with the latest board-*.tsv → views/RECONCILIATION.md

Initial load
  askflow import <file.jsonl> [--apply]   validate a batch of events; --apply appends it
  askflow day-zero                        declare day zero: from then on the book only grows

Any command accepts --ledger <dir> (or ASKFLOW_LEDGER) to point at a ledger explicitly.
Exit codes: 0 ok · 1 error · 3 this directory has no ledger.`;

const BOOLEAN = new Set(["yes", "apply", "history", "ignore", "dry-run", "help"]);
const parseArgs = (argv) => {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const k = a.slice(2);
    flags[k] = BOOLEAN.has(k) ? true : argv[++i];
  }
  return { flags, rest };
};

const pad = (n) => String(n).padStart(2, "0");
const today = () => { if (process.env.ASKFLOW_TODAY) return process.env.ASKFLOW_TODAY; const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fail = (message, code = 1) => { console.error(message); process.exit(code); };

const open = (flags) => {
  let dir;
  try { dir = resolveLedger({ flag: flags.ledger || process.env.ASKFLOW_LEDGER }); } catch (x) { fail(x.message); }
  if (!dir) fail("No askflow ledger for this directory. Set the project up with: askflow init", 3);
  let raw;
  try { raw = JSON.parse(readFileSync(join(dir, CONFIG), "utf8")); } catch { fail(`${join(dir, CONFIG)}: invalid JSON`); }
  const config = normalize(raw);
  const bad = checkConfig(config);
  if (bad.length) fail(bad.join("\n"));
  const L = createLedger(config);
  let events;
  try { events = parse(readFileSync(join(dir, "events.jsonl"), "utf8")); } catch (x) { fail(`events.jsonl: ${x.message}`); }
  const errors = L.validate(events);
  if (errors.length) fail(errors.join("\n"));
  const snapshots = readdirSync(dir).filter((f) => /^board-.*\.tsv$/.test(f)).sort();
  const snapshot = snapshots.at(-1) ?? null;
  const board = snapshot ? L.parseBoard(readFileSync(join(dir, snapshot), "utf8")) : new Map();
  return { dir, config, L, events, board, snapshot, items: L.compute(events, board) };
};

const runInit = async (flags) => {
  const root = resolve(expand(flags.root ?? process.cwd()));
  const o = { root, name: flags.name, store: flags.store, path: flags.path, memoryRepo: flags["memory-repo"], slug: flags.slug,
    gitignore: !!flags.ignore, history: !!flags.history, home: configHome(), today: today() };
  if (!flags.yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim() || def;
    o.name ??= await ask("Project name", basename(root));
    if (!o.store) {
      console.log("Where should the ledger live?\n  project  inside this project (.askflow/)\n  memory   in a separate memory repo, nothing written here\n  path     any other folder");
      o.store = await ask(`Store (${STORES.join(" | ")})`, "project");
    }
    if (o.store === "memory") {
      o.memoryRepo ??= await ask("Memory repo folder", readSettings(o.home).memoryRepo);
      o.slug ??= await ask("Folder name inside it", slugify(o.name));
    }
    if (o.store === "path") o.path ??= await ask("Ledger folder");
    if (o.store === "project" && !flags.ignore) o.gitignore = /^y/i.test(await ask("Keep the ledger out of git (add .askflow/ to .gitignore)? y/n", "n"));
    if (!flags.history) o.history = /^y/i.test(await ask("Does this project have earlier asks to load into the ledger? y/n", "n"));
    rl.close();
  }
  o.store ??= "project";
  let r;
  try { r = init(o); } catch (x) { fail(x.message); }
  console.log(`Ledger for «${r.name}» created at ${r.ledger}`);
  console.log(`Next: edit ${join(r.ledger, CONFIG)} (client, what «done» means, board, spec tool, review rules).`);
  console.log(r.dayZero
    ? "Day zero declared: write with `askflow log '<json>'`."
    : `Day zero NOT declared. Load the earlier asks first (see ${join(r.ledger, "README.md")}): askflow import <batch.jsonl> [--apply], then askflow day-zero.`);
  if (!existsSync(join(claudeHome(), "skills", "askflow", "SKILL.md"))) console.log("The Claude Code skill and agents are not installed yet: askflow install");
};

const { flags, rest } = parseArgs(process.argv.slice(2));
const [command, arg] = rest;

if (flags.help || !command || command === "help") console.log(HELP);
else if (command === "init") await runInit(flags);
else if (command === "install") {
  const r = install({ today: today(), dryRun: !!flags["dry-run"] });
  for (const f of r.written) console.log(`${flags["dry-run"] ? "would write" : "written"}  ${f}`);
  for (const f of r.backups) console.log(`${flags["dry-run"] ? "would keep" : "kept"} the previous version as ${f}`);
  if (!r.written.length) console.log("Skill and agents already up to date.");
} else if (command === "config") {
  const l = open(flags);
  console.log(JSON.stringify({ ledger: l.dir, dayZero: existsSync(join(l.dir, "DAY-ZERO")), boardSnapshot: l.snapshot, config: l.config }, null, 2));
} else if (command === "validate") {
  const l = open(flags);
  console.log(`Ledger valid: ${l.events.length} events, ${l.items.size} items`);
} else if (command === "views") {
  const l = open(flags);
  mkdirSync(join(l.dir, "views"), { recursive: true });
  const written = ["SUMMARY.md", "STATUS.md"];
  writeFileSync(join(l.dir, "views", "SUMMARY.md"), l.L.summaryView(l.items, today()));
  writeFileSync(join(l.dir, "views", "STATUS.md"), l.L.statusView(l.items, today()));
  if ([...l.items.values()].some((a) => a.backlog)) { writeFileSync(join(l.dir, "views", "BACKLOG.md"), l.L.backlogView(l.items, today())); written.push("BACKLOG.md"); }
  console.log(`views/ regenerated (${written.join(", ")}; ${l.items.size} items)`);
} else if (command === "show") {
  const l = open(flags);
  const a = l.items.get(arg);
  if (!a) fail(`No such item: ${arg}`);
  console.log(l.L.itemView(a));
} else if (command === "log") {
  const l = open(flags);
  if (!existsSync(join(l.dir, "DAY-ZERO"))) fail("Day zero has not been declared: load earlier asks with `askflow import`, then run `askflow day-zero`.");
  let e;
  try { e = l.L.log(l.events, JSON.parse(arg ?? ""), today()); } catch (x) { fail(x.message); }
  appendFileSync(join(l.dir, "events.jsonl"), JSON.stringify(e) + "\n");
  console.log(`${e.item} · ${e.type} logged. Regenerate the views with: askflow views`);
} else if (command === "import") {
  const l = open(flags);
  if (!arg || !existsSync(arg)) fail(`Batch file not found: ${arg ?? "(none given)"}`);
  let added;
  try { added = l.L.importBatch(l.events, parse(readFileSync(arg, "utf8")), today()); } catch (x) { fail(x.message); }
  const opened = added.filter((e) => e.type === "opened");
  const range = opened.length ? ` (${opened[0].item} … ${opened.at(-1).item})` : "";
  if (flags.apply) {
    appendFileSync(join(l.dir, "events.jsonl"), added.map((e) => JSON.stringify(e)).join("\n") + (added.length ? "\n" : ""));
    console.log(`${added.length} events appended, ${opened.length} items${range}.`);
  } else console.log(`Dry run: ${added.length} events, ${opened.length} items${range} would be appended. Nothing written; repeat with --apply.`);
} else if (command === "day-zero") {
  const l = open(flags);
  if (existsSync(join(l.dir, "DAY-ZERO"))) fail(`Day zero was already declared:\n${readFileSync(join(l.dir, "DAY-ZERO"), "utf8").trim()}`);
  const text = dayZeroText(today(), l.events.length, l.items.size);
  writeFileSync(join(l.dir, "DAY-ZERO"), text);
  console.log(text.trim());
} else if (command === "reconcile") {
  const l = open(flags);
  if (!l.config.board.enabled) fail("This project has no board configured (board.enabled is false).");
  if (!l.snapshot) fail("No board snapshot (board-*.tsv) in the ledger folder.");
  const r = l.L.reconcile(l.items, l.board);
  mkdirSync(join(l.dir, "views"), { recursive: true });
  writeFileSync(join(l.dir, "views", "RECONCILIATION.md"), l.L.reconciliationView(r, l.snapshot));
  console.log(Object.entries(r).map(([k, v]) => `${k}: ${v.length}`).join(" · ") + " → views/RECONCILIATION.md");
} else fail(`Unknown command «${command}». Try: askflow help`);
