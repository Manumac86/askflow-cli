#!/usr/bin/env node
// askflow: an append-only ledger of what was asked, and the five gates every ask goes through.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createLedger, parse } from "../src/engine.mjs";
import { normalize, checkConfig } from "../src/config.mjs";
import { resolveLedger, configHome, readSettings, CONFIG, expand } from "../src/resolve.mjs";
import { init, dayZeroText, slugify, STORES, BOARDS } from "../src/init.mjs";
import { parseBoardFile, addTask, moveTask } from "../src/board.mjs";
import { install, AGENTS, parseAgents, detectAgents, guide } from "../src/install.mjs";

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
      --board mcp|file|none     where tasks live: a board tool reached through its MCP server, a
                                Markdown board in the project, or no board (default: none)
      --board-tool <name>       for --board mcp: the tool (Linear, Jira, ClickUp, Notion, …)
      --board-mcp <server>      for --board mcp: the MCP server's name as your agent knows it
      --board-file <path>       for --board file: the board file (default: BOARD.md)
      --agent <list>            also set the workflow up for these agents (see install)
  askflow install [options]     set the workflow up for your coding agents (asks which ones)
      --agent <list>            claude, codex, cursor, gemini, generic or all; comma-separated
      --project <dir>           project folder for the agents set up per project (default: current)
      --dry-run                 show what would be written
  askflow guide [role]          print the workflow, or one role: archivist | pr-reviewer | verifier

Daily use (run from anywhere inside the project)
  askflow config                where the ledger is and how the project is configured (JSON)
  askflow validate              check the book
  askflow views                 regenerate views/SUMMARY.md, STATUS.md and BACKLOG.md
  askflow show <id>             full history of one item
  askflow log '<json>'          append one event (the only way to write after day zero)
  askflow reconcile             compare with the board → views/RECONCILIATION.md
  askflow board                 where the board is and how many tasks are in each state
  askflow board add "<title>" [--item <id>] [--state <state>]
                                Markdown board: add a task; --item also logs the link in the ledger
  askflow board move <code> "<state>"
                                Markdown board: move a task (its notes go with it)

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
  // The board is either a Markdown file in the project or the latest snapshot exported from the board tool.
  let board = new Map(), snapshot = null, boardFile = null;
  if (config.board.enabled && config.board.mode === "file") {
    const root = config.project.root || (basename(dir) === ".askflow" ? dirname(dir) : null);
    if (!root) fail("config: «project.root» is needed to find the Markdown board.");
    boardFile = resolve(root, config.board.file);
    if (existsSync(boardFile)) { board = parseBoardFile(readFileSync(boardFile, "utf8")); snapshot = boardFile; }
  } else {
    snapshot = readdirSync(dir).filter((f) => /^board-.*\.tsv$/.test(f)).sort().at(-1) ?? null;
    if (snapshot) board = L.parseBoard(readFileSync(join(dir, snapshot), "utf8"));
  }
  return { dir, config, L, events, board, snapshot, boardFile, items: L.compute(events, board) };
};

// Ctrl+C or Ctrl+D at a question leaves without a stack trace and without having written anything.
const question = async (rl, text) => {
  try { return await rl.question(text); } catch (x) { if (x.code === "ABORT_ERR") fail("\nCancelled. Nothing was written."); throw x; }
};

const report = (r, dry) => {
  for (const f of r.written) console.log(`${dry ? "would write" : "written"}  ${f}`);
  for (const f of r.backups) console.log(`${dry ? "would keep" : "kept"} the previous version as ${f}`);
  if (!r.written.length) console.log("Already up to date.");
};

// Which agents to set up: --agent wins; on a terminal the user picks from the list; otherwise the fallback.
const chooseAgents = async (flags, project, fallback, rl) => {
  if (flags.agent !== undefined) { try { return parseAgents(flags.agent, []); } catch (x) { fail(x.message); } }
  if (flags.yes || !process.stdin.isTTY) return fallback;
  const names = Object.keys(AGENTS);
  const found = detectAgents(project);
  const def = found.length ? found : ["claude"];
  console.log("Which coding agents will work with askflow?");
  names.forEach((n, i) => console.log(`  ${i + 1}) ${AGENTS[n].label.padEnd(38)} ${AGENTS[n].where}${found.includes(n) ? "  (detected)" : ""}`));
  const own = rl ?? createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await question(own, `Numbers or names, comma-separated; «all» or «none» [${def.join(",")}]: `)).trim();
      if (/^none$/i.test(answer)) return [];
      try { return parseAgents(answer, def); } catch (x) { console.log(x.message); }
    }
  } finally { if (!rl) own.close(); }
};

const runInstall = (agents, project, flags) => {
  if (!agents.length) return;
  let r;
  try { r = install({ agents, project, today: today(), dryRun: !!flags["dry-run"] }); } catch (x) { fail(x.message); }
  report(r, !!flags["dry-run"]);
};

const runInit = async (flags) => {
  const root = resolve(expand(flags.root ?? process.cwd()));
  const o = { root, name: flags.name, store: flags.store, path: flags.path, memoryRepo: flags["memory-repo"], slug: flags.slug,
    gitignore: !!flags.ignore, history: !!flags.history, home: configHome(), today: today(),
    board: { mode: flags.board, tool: flags["board-tool"], mcp: flags["board-mcp"], file: flags["board-file"] } };
  if (o.board.mode && !BOARDS.includes(o.board.mode)) fail(`Unknown board «${o.board.mode}» (one of: ${BOARDS.join(", ")}).`);
  if (!flags.yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q, def) => (await question(rl, `${q}${def ? ` [${def}]` : ""}: `)).trim() || def;
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
    if (!o.board.mode) {
      console.log("Where do this project's tasks live?\n  mcp   in a board tool (Linear, Jira, ClickUp, Notion, …) your agent reaches through its MCP server\n  file  in a Markdown board inside the project (BOARD.md)\n  none  no board");
      for (;;) { o.board.mode = await ask(`Board (${BOARDS.join(" | ")})`, "none"); if (BOARDS.includes(o.board.mode)) break; console.log(`Unknown board «${o.board.mode}».`); }
    }
    if (o.board.mode === "mcp") {
      o.board.tool ??= await ask("Board tool");
      o.board.mcp ??= await ask("Name of its MCP server in your agent (empty if it is not connected yet)");
    }
    if (o.board.mode === "file") o.board.file ??= await ask("Board file, relative to the project", "BOARD.md");
    o.agents = await chooseAgents(flags, root, [], rl);
    rl.close();
  }
  o.agents ??= await chooseAgents(flags, root, []);
  o.store ??= "project";
  let r;
  try { r = init(o); } catch (x) { fail(x.message); }
  console.log(`Ledger for «${r.name}» created at ${r.ledger}`);
  console.log(`Next: edit ${join(r.ledger, CONFIG)} (client, what «done» means, board, spec tool, review rules).`);
  console.log(r.dayZero
    ? "Day zero declared: write with `askflow log '<json>'`."
    : `Day zero NOT declared. Load the earlier asks first (see ${join(r.ledger, "README.md")}): askflow import <batch.jsonl> [--apply], then askflow day-zero.`);
  if (r.board.mode === "file") console.log(r.boardCreated
    ? `Markdown board created at ${r.boardFile}. Tasks: askflow board add "<title>" --item <id> · askflow board move <code> "<state>"`
    : `Markdown board: ${r.boardFile} already existed and was left as it is.`);
  if (r.board.mode === "mcp") console.log(r.board.mcp
    ? `Board: ${r.board.tool || "(tool not named)"}, through the MCP server «${r.board.mcp}». The agent creates and moves tasks there; that server must be connected in every agent that works on this project.`
    : `Board: ${r.board.tool || "(tool not named)"}. Connect its MCP server in your agent (Claude Code: claude mcp add --transport http <name> <url>), then put the server's name in «board.mcp».`);
  if (o.agents.length) runInstall(o.agents, root, flags);
  else console.log("To set the workflow up for a coding agent (Claude Code, Codex, Cursor, Gemini CLI…): askflow install");
};

const { flags, rest } = parseArgs(process.argv.slice(2));
const [command, arg] = rest;

if (flags.help || !command || command === "help") console.log(HELP);
else if (command === "init") await runInit(flags);
else if (command === "install") {
  const project = resolve(expand(flags.project ?? process.cwd()));
  const agents = await chooseAgents(flags, project, ["claude"]);
  if (!agents.length) console.log("Nothing chosen, nothing written.");
  runInstall(agents, project, flags);
} else if (command === "guide") {
  try { console.log(guide(arg)); } catch (x) { fail(x.message); }
} else if (command === "config") {
  const l = open(flags);
  console.log(JSON.stringify({ ledger: l.dir, dayZero: existsSync(join(l.dir, "DAY-ZERO")), boardSnapshot: l.boardFile ? null : l.snapshot, boardFile: l.boardFile, config: l.config }, null, 2));
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
  if (!l.snapshot) fail(l.boardFile ? `The Markdown board is missing: ${l.boardFile}` : "No board snapshot (board-*.tsv) in the ledger folder.");
  const r = l.L.reconcile(l.items, l.board);
  mkdirSync(join(l.dir, "views"), { recursive: true });
  writeFileSync(join(l.dir, "views", "RECONCILIATION.md"), l.L.reconciliationView(r, l.snapshot));
  console.log(Object.entries(r).map(([k, v]) => `${k}: ${v.length}`).join(" · ") + " → views/RECONCILIATION.md");
} else if (command === "board") {
  const l = open(flags);
  const b = l.config.board;
  const [, action, first, second] = rest;
  if (!b.enabled) fail("This project has no board configured (board.enabled is false).");
  if (b.mode !== "file") {
    const where = `${b.tool || "a board tool"}, through the MCP server «${b.mcp || "not set: board.mcp"}»`;
    if (action) fail(`This project's board is ${where}: create and move tasks there, with that server's tools.`);
    console.log(`Board: ${where}.${l.snapshot ? ` Latest snapshot: ${l.snapshot}.` : " No snapshot yet (board-*.tsv) for askflow reconcile."}`);
  } else if (!action) {
    const count = (s) => [...l.board.values()].filter((t) => t.state === s).length;
    console.log(`Board: ${l.boardFile}\n${b.states.map((s) => `${s}: ${count(s)}`).join(" · ")}`);
  } else if (action === "add" || action === "move") {
    const text = existsSync(l.boardFile) ? readFileSync(l.boardFile, "utf8") : "";
    try {
      if (action === "move") {
        const r = moveTask(text, b, first, second);
        writeFileSync(l.boardFile, r.text);
        console.log(`${r.code} moved to «${r.state}».`);
      } else {
        const item = flags.item;
        if (item && !l.items.has(item)) fail(`No such item: ${item}`);
        if (item && !existsSync(join(l.dir, "DAY-ZERO"))) fail("Day zero has not been declared: a task cannot be linked to an item yet.");
        const r = addTask(text, b, { title: first, state: flags.state, item });
        const e = item ? l.L.log(l.events, { item, type: "linked", task: r.code }, today()) : null; // checked before anything is written
        mkdirSync(dirname(l.boardFile), { recursive: true });
        writeFileSync(l.boardFile, r.text);
        if (e) appendFileSync(join(l.dir, "events.jsonl"), JSON.stringify(e) + "\n");
        console.log(`${r.code} added to «${r.state}»${e ? ` and linked to ${item}` : ""}.`);
      }
    } catch (x) { fail(x.message); }
  } else fail(`Unknown board action «${action}». Try: askflow board add "<title>" · askflow board move <code> "<state>"`);
} else fail(`Unknown command «${command}». Try: askflow help`);
