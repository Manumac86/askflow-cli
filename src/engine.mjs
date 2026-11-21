// The ledger engine: an event book that only grows. State is computed, never written.
// Pure functions only (no file access) and no knowledge of any project: everything comes from the config.

export const TYPES = ["opened", "linked", "supersedes", "obsolete", "decision", "partial", "implemented", "reviewed", "verified", "closed"];
export const MODES = ["preserve", "replace"];
const PHASES = { opened: "open", partial: "partial", implemented: "implemented", reviewed: "reviewed", verified: "verified", closed: "closed" };
const DONE = ["verified", "closed"];
export const BOARD_GAP = "board says done, ledger does not";

export const parse = (text) =>
  text.split("\n").map((l, i) => [l.trim(), i + 1]).filter(([l]) => l && !l.startsWith("//")).map(([l, n]) => {
    try { return JSON.parse(l); } catch { throw new Error(`Line ${n}: invalid JSON`); }
  });

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const count = (list, key) => list.reduce((o, x) => { const k = key(x); o[k] = (o[k] ?? 0) + 1; return o; }, {});

export const createLedger = (cfg) => {
  const idRe = new RegExp(`^${cfg.idPrefix}-\\d{4,}$`);
  const origins = Object.keys(cfg.origins);
  const doneStates = cfg.board.doneStates;
  const boardDone = (states) => states.length > 0 && states.every((s) => doneStates.includes(s));
  const marks = Object.entries(cfg.backlog.marks);
  const needsInput = new RegExp(cfg.summary.needsInput, "i");

  const validate = (events) => {
    const errors = [];
    const seen = new Set();
    const ids = new Set(events.filter((e) => e.type === "opened").map((e) => e.item));
    events.forEach((e, i) => {
      const err = (m) => errors.push(`Event ${i + 1} (${e.item ?? "?"} ${e.type ?? "?"}): ${m}`);
      if (!idRe.test(e.item ?? "")) err("invalid item identifier");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "")) err("invalid date (yyyy-mm-dd)");
      if (!TYPES.includes(e.type)) return err("unknown type");
      if (e.type === "opened") {
        if (seen.has(e.item)) err("duplicate opening");
        if (!e.title) err("title is missing");
        if (!e.goal) err("goal is missing");
        if (!origins.includes(e.origin)) err(`unknown origin (one of: ${origins.join(", ")})`);
        if (!MODES.includes(e.mode)) err("invalid mode (preserve or replace)");
        if (!cfg.protections.includes(e.protection)) err(`invalid protection (one of: ${cfg.protections.join(", ")})`);
        if (!Array.isArray(e.surface)) err("surface is missing");
        if (typeof e.verify !== "boolean") err("must declare whether it requires verification");
        if (cfg.origins[e.origin]?.requiresVerification && e.verify === false) err(`origin «${e.origin}» requires verification`);
        if (!e.criteria?.length && !e.imported) err("acceptance criteria are missing");
      } else if (!seen.has(e.item)) err("the first event of an item must be its opening");
      if (e.type === "supersedes" && !ids.has(e.target)) err("«supersedes» needs an existing target item");
      if (e.type === "partial" && !e.reason) err("«partial» needs a reason");
      if (e.type === "decision" && !(e.text && e.why)) err("«decision» needs text and why");
      if (e.type === "implemented" && !(e.pr || e.commit)) err("«implemented» needs a PR or commit");
      if (e.type === "verified" && !e.evidence) err("«verified» needs evidence");
      seen.add(e.item);
    });
    return errors;
  };

  // Board snapshot (TSV by position: code, state, created, closed, type, title, …) → Map code → { state, title, tag }.
  // `tag` is the column the project uses to mark tasks that belong to someone else (board.foreign.column, 1-based).
  const parseBoard = (tsv) =>
    new Map(tsv.split("\n").filter(Boolean).map((l) => { const c = l.split("\t"); return [c[0], { state: c[1], title: c[5] ?? "", tag: c[cfg.board.foreign.column - 1] ?? "" }]; }));

  const compute = (events, board = new Map()) => {
    const items = new Map();
    for (const e of events) {
      if (e.type === "opened") {
        items.set(e.item, { ...e, id: e.item, phase: "open", obsolete: false, supersededBy: null, splitInto: [],
          specs: e.spec ? [e.spec] : [], tasks: e.task ? [e.task] : [], prs: [], pending: [], decisions: [], history: [e], verified: false });
        continue;
      }
      const a = items.get(e.item);
      if (!a) continue;
      a.history.push(e);
      if (e.spec && !a.specs.includes(e.spec)) a.specs.push(e.spec);
      if (e.task && !a.tasks.includes(e.task)) a.tasks.push(e.task);
      if (e.pr && !a.prs.includes(e.pr)) a.prs.push(e.pr);
      // A later pending note never moves the phase backwards: it stays as pending.
      if (e.type === "partial") { if (a.phase === "open") a.phase = "partial"; a.pending.push(e.reason); }
      else if (e.type === "implemented" || e.type === "reviewed") a.phase = `${PHASES[e.type]}, unverified`;
      else if (PHASES[e.type]) a.phase = PHASES[e.type];
      if (e.type === "verified") { a.verified = true; a.pending = []; }
      if (e.type === "decision") a.decisions.push(e);
      if (e.type === "obsolete") a.obsolete = true;
      if (e.type === "supersedes") {
        const old = items.get(e.target);
        if (old) { old.obsolete = true; old.supersededBy = e.item; old.splitInto.push(e.item); }
      }
    }
    for (const a of items.values()) {
      a.gaps = [];
      // Backlog (asked before the ledger existed, loaded read-only): closed = archived, not live work;
      // open = a possible omission. Either way it raises no process gaps.
      a.archived = !!a.backlog && a.phase === "closed" && !a.obsolete;
      if (a.backlog) continue;
      if (cfg.gaps.missingCriteria && !a.criteria?.length) a.gaps.push("no acceptance criteria");
      if (cfg.spec.enabled && cfg.gaps.missingSpec && !a.specs.length) a.gaps.push("no spec");
      if (cfg.board.enabled && cfg.gaps.missingTask && !a.tasks.length) a.gaps.push("no linked task");
      if (cfg.gaps.unknownProtection && a.protection === "unknown") a.gaps.push("protection undetermined");
      if (a.phase === "closed" && a.verify && !a.verified) a.gaps.push(cfg.done.gapLabel);
      if (!cfg.board.enabled) continue;
      a.boardDone = boardDone(a.tasks.map((t) => board.get(t)?.state).filter(Boolean));
      if (a.boardDone && !a.obsolete && !DONE.includes(a.phase)) a.gaps.push(BOARD_GAP);
    }
    return items;
  };

  const live = (items) => [...items.values()].filter((a) => !a.obsolete && !a.archived);
  const totals = (items) => ({ obsolete: [...items.values()].filter((a) => a.obsolete).length, archived: [...items.values()].filter((a) => a.archived).length });

  const statusView = (items, today) => {
    const alive = live(items);
    const open = alive.filter((a) => !DONE.includes(a.phase));
    const t = totals(items);
    const L = [`# Ledger status`, ``, `> Generated on ${today}. Do not edit: computed from \`events.jsonl\`.`, ``,
      `Items: ${items.size} · open: ${open.length} · obsolete: ${t.obsolete} · archived backlog: ${t.archived}`, ``,
      `## Open`, ``, `| Item | Aliases | Title | Origin | Phase | Spec | Task | PR |`, `|---|---|---|---|---|---|---|---|`];
    for (const a of open)
      L.push(`| ${a.id} | ${cell((a.aliases ?? []).join(", "))} | ${cell(a.title)} | ${a.origin} | ${a.phase} | ${cell(a.specs.join(", "))} | ${cell(a.tasks.join(", "))} | ${cell(a.prs.join(", "))} |`);
    L.push(``, `## What is left and why`, ``);
    for (const a of open.filter((x) => x.pending.length)) {
      L.push(`**${a.id} — ${a.title}**`);
      for (const p of a.pending) L.push(`- ${p}`);
      L.push(``);
    }
    L.push(`## Gaps`, ``);
    for (const a of alive.filter((x) => x.gaps.length)) L.push(`- ${a.id}: ${a.gaps.join("; ")}`);
    return L.join("\n") + "\n";
  };

  // Short summary: what to read when a session starts. Detail lives in STATUS.md and in each item.
  const summaryView = (items, today) => {
    const alive = live(items);
    const current = alive.filter((a) => !a.backlog);
    const open = current.filter((a) => !DONE.includes(a.phase));
    const t = totals(items);
    const L = [`# Ledger summary`, ``, `> Generated on ${today}. Do not edit. Detail: \`STATUS.md\`; one item: \`askflow show ${cfg.idPrefix}-0000\`.`, ``,
      `**${current.length} live items** · ${Object.entries(count(current, (a) => a.phase)).map(([k, v]) => `${v} ${k}`).join(" · ")} · ${t.obsolete} obsolete · ${t.archived} archived backlog`, ``];
    const old = alive.filter((a) => a.backlog);
    if (old.length) {
      const n = (mark) => old.filter((a) => a.pending.some((p) => p.startsWith(mark))).length;
      L.push(`**Open backlog (${old.length})**: ${marks.map(([m]) => `${n(m)} ${m.toLowerCase()}`).join(" · ")}. List: \`BACKLOG.md\`.`, ``);
    }
    if (cfg.spec.enabled) {
      L.push(`## By spec`, ``, `| Spec | Items | Verified | Unverified | Partial |`, `|---|---|---|---|---|`);
      const bySpec = new Map();
      for (const a of current) { const s = a.specs[0] ?? "(no spec)"; bySpec.set(s, [...(bySpec.get(s) ?? []), a]); }
      for (const [s, list] of [...bySpec].sort((x, y) => x[0].localeCompare(y[0]))) {
        const n = (re) => list.filter((a) => re.test(a.phase)).length;
        L.push(`| ${cell(s)} | ${list.length} | ${n(/^(verified|closed)$/)} | ${n(/unverified/)} | ${n(/^(partial|open)$/)} |`);
      }
      L.push(``);
    }
    const input = open.flatMap((a) => a.pending.filter((p) => needsInput.test(p)).map((p) => `- ${a.id} ${a.title}: ${p}`));
    L.push(`## Needs a decision, a confirmation or a contradiction resolved (${input.length})`, ``, ...input, ``);
    if (cfg.board.enabled) {
      const b = alive.filter((a) => a.gaps.includes(BOARD_GAP));
      L.push(`## Board says done, ledger does not (${b.length})`, ``, ...b.map((a) => `- ${a.id} (${a.tasks.join(", ")}) ${a.title}`), ``);
    }
    L.push(`## Gaps`, ``, ...Object.entries(count(alive.flatMap((a) => a.gaps), (g) => g)).map(([k, v]) => `- ${v} · ${k}`));
    return L.join("\n") + "\n";
  };

  // What the backlog leaves open: possible omissions, grouped by the project's own marks.
  const backlogView = (items, today) => {
    const old = live(items).filter((a) => a.backlog);
    const L = [`# Open backlog`, ``, `> Generated on ${today}. Do not edit. Asks from before the ledger${cfg.backlog.cutoff ? ` (cutoff ${cfg.backlog.cutoff})` : ""} that the load could not close.`, ``];
    const marked = new Set();
    for (const [mark, title] of marks) {
      const list = old.filter((a) => a.pending.some((p) => p.startsWith(mark)));
      L.push(`## ${title} (${list.length})`, ``);
      for (const a of list) { marked.add(a.id); L.push(`- **${a.id}** (${a.date}) ${a.title} — ${a.pending.find((p) => p.startsWith(mark)).slice(mark.length).replace(/^[:\s]+/, "")}`); }
      L.push(``);
    }
    const rest = old.filter((a) => !marked.has(a.id));
    L.push(`## Unmarked (${rest.length})`, ``, ...rest.map((a) => `- **${a.id}** (${a.date}) ${a.title} — ${a.pending.at(-1) ?? a.phase}`), ``);
    return L.join("\n") + "\n";
  };

  const itemView = (a) => {
    const L = [`# ${a.id} — ${a.title}`, ``,
      `- Origin: ${a.origin} · mode: ${a.mode} · phase: ${a.phase}${a.obsolete ? ` · OBSOLETE${a.splitInto.length ? ` (superseded by ${a.splitInto.join(", ")})` : ""}` : ""}`,
      `- Aliases: ${(a.aliases ?? []).join(", ") || "—"}`, `- Goal: ${a.goal}`,
      `- Criteria:${a.criteria?.length ? "" : " none yet"}`, ...(a.criteria ?? []).map((c) => `  - ${c}`),
      `- Surface: ${a.surface.join(", ") || "—"} · protection: ${a.protection} · verification required: ${a.verify ? "yes" : "no"}`,
      `- Specs: ${a.specs.join(", ") || "—"} · tasks: ${a.tasks.join(", ") || "—"} · PRs: ${a.prs.join(", ") || "—"}`,
      ...(a.pending.length ? [`- Pending:`, ...a.pending.map((p) => `  - ${p}`)] : []),
      ...(a.gaps.length ? [`- Gaps: ${a.gaps.join("; ")}`] : []), ``, `## History`, ``];
    for (const e of a.history) {
      const text = e.reason ?? e.text ?? e.evidence ?? e.note ?? e.title ?? e.pr ?? e.commit ?? e.spec ?? e.task ?? e.target ?? "";
      L.push(`- ${e.date} · ${e.type}${e.imported ? " (imported)" : ""} — ${text}${e.why ? ` Why: ${e.why}` : ""}${e.source ? ` [${e.source}]` : ""}`);
    }
    return L.join("\n") + "\n";
  };

  // Read-only comparison with the board. It never proposes reopening: the ledger rules and the board comment is corrected.
  const reconcile = (items, board) => {
    const alive = live(items);
    const done = (a) => DONE.includes(a.phase);
    const linked = new Set([...items.values()].flatMap((a) => a.tasks));
    const foreign = new Set(cfg.board.foreign.values);
    const states = (a) => a.tasks.map((t) => board.get(t)?.state).filter(Boolean);
    return {
      boardDoneLedgerNot: alive.filter((a) => !done(a) && boardDone(states(a))),
      ledgerDoneBoardNot: alive.filter((a) => done(a) && states(a).some((s) => !doneStates.includes(s))),
      itemsWithoutTask: alive.filter((a) => !a.tasks.length && !a.backlog),
      unknownTasks: alive.flatMap((a) => a.tasks.filter((t) => !board.has(t)).map((t) => `${a.id} → ${t}`)),
      tasksWithoutItem: [...board].filter(([c, t]) => !linked.has(c) && !foreign.has(t.tag) && !doneStates.includes(t.state)).map(([c, t]) => `${c} (${t.state}) ${t.title}`),
    };
  };

  const reconciliationView = (r, snapshot) => {
    const row = (a) => `- ${a.id} [${a.tasks.join(", ")}] ${a.phase} — ${a.title}`;
    const block = (title, lines) => [`## ${title} (${lines.length})`, ...(lines.length ? lines : ["- nothing"]), ``];
    return [`# Reconciliation with the board`, ``, `> Snapshot: ${snapshot}. Read-only: it reopens and closes nothing.`, ``,
      ...block("Board says done, ledger does not", r.boardDoneLedgerNot.map(row)),
      ...block("Ledger says done, board does not", r.ledgerDoneBoardNot.map(row)),
      ...block("Open board tasks with no item", r.tasksWithoutItem.map((t) => `- ${t}`)),
      ...block("Items linked to a task missing from the snapshot", r.unknownTasks.map((t) => `- ${t}`)),
      ...block("Live items with no task", r.itemsWithoutTask.map((a) => `- ${a.id} (${a.specs.join(", ") || "no spec"}) — ${a.title}`))].join("\n");
  };

  const nextId = (events) => {
    const last = Math.max(0, ...events.filter((x) => x.type === "opened").map((x) => Number(String(x.item).slice(cfg.idPrefix.length + 1)) || 0));
    return `${cfg.idPrefix}-${String(last + 1).padStart(4, "0")}`;
  };

  // The single write path: completes the event (date and, on an opening, the next identifier) and returns it
  // only if the ledger is still valid with it. Nothing already written is touched.
  const log = (events, incoming, today) => {
    const e = { ...incoming, date: incoming.date ?? today };
    if (e.type === "opened" && !e.item) e.item = nextId(events);
    const before = validate(events).length;
    const errors = validate([...events, e]);
    if (errors.length > before) throw new Error(errors.slice(before).join("\n"));
    return e;
  };

  // Batch load (initial load or backlog). An opening may carry a local `ref`; later lines point at it with
  // "@ref" in `item` or `target`. The ref is kept as an alias, which is also what stops a second load.
  const importBatch = (events, lines, today) => {
    const book = [...events];
    const refs = new Map();
    const known = new Set(events.flatMap((e) => e.aliases ?? []));
    const resolve = (v) => {
      if (typeof v !== "string" || !v.startsWith("@")) return v;
      if (!refs.has(v.slice(1))) throw new Error(`unknown reference ${v}`);
      return refs.get(v.slice(1));
    };
    for (const raw of lines) {
      const { ref, ...e } = raw;
      if (ref !== undefined) {
        if (known.has(ref)) throw new Error(`already imported: ${ref}`);
        e.aliases = [...(e.aliases ?? []), ref];
      }
      if (e.item !== undefined) e.item = resolve(e.item);
      if (e.target !== undefined) e.target = resolve(e.target);
      const done = log(book, e, today);
      if (ref !== undefined) { refs.set(ref, done.item); known.add(ref); }
      book.push(done);
    }
    return book.slice(events.length);
  };

  return { validate, compute, parseBoard, log, importBatch, reconcile, statusView, summaryView, backlogView, itemView, reconciliationView };
};
