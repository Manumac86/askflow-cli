// Sets a project up: creates the ledger folder where the user chose, never overwriting anything.
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { template } from "./config.mjs";
import { CONFIG, IN_PROJECT, expand, readIndex, writeIndex, readSettings, writeSettings } from "./resolve.mjs";

export const STORES = ["project", "memory", "path"];
export const slugify = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const dayZeroText = (today, events, items) =>
  `Day zero declared on ${today} with ${events} events and ${items} items.\nFrom here on events.jsonl only grows: it is written with \`askflow log\`.\n`;

const readme = (name, history) => `# Ledger — ${name}

An event book that only grows. It says what was asked, when, what replaced it, what was decided,
what was left half done and why, and what is verified. State is computed from it, never written.

| File | What it is | Edited? |
|---|---|---|
| \`events.jsonl\` | The book: one event per line | Only by appending, through \`askflow log\` |
| \`${CONFIG}\` | Everything specific to this project | By hand |
| \`board-*.tsv\` | Board snapshot (code, state, created, closed, type, title, …) | Replaced by a newer one |
| \`views/\` | Computed views | Never by hand |
| \`evidence/\` | Screenshots and recordings from verification | Added to |

\`\`\`
askflow validate            # checks the book
askflow views               # regenerates views/
askflow show A-0001         # full history of one item
askflow log '<json>'        # the only way to write
askflow reconcile           # ledger vs. the latest board snapshot
askflow config              # where this ledger is and how the project is configured
\`\`\`

Rules: nothing is edited or deleted; a correction is a new event. The first event of an item is its
\`opened\`. Event types: opened · linked · supersedes · obsolete · decision · partial · implemented ·
reviewed · verified · closed.
${history ? `
## Initial load (day zero not declared yet)

This project has history from before the ledger. Until day zero is declared, \`askflow log\` refuses to
write and the book is filled in batches:

1. Have the \`askflow-archivist\` agent read the old material (client documents, mail, closed tasks,
   archived specs) and propose a batch: one JSON event per line in a \`.jsonl\` file kept in \`load/\`.
   Openings carry \`"imported": true\`, \`"backlog": true\`, a local \`"ref"\` and the original date; later
   lines point at them with \`"item": "@ref"\`. Imported items link what already existed: they never
   create or reopen a task.
2. \`askflow import load/<batch>.jsonl\` is a dry run: it validates and shows what would be added.
   Repeat with \`--apply\` to append. A batch cannot be loaded twice.
3. What the load cannot close stays open with a \`partial\` whose reason starts with one of the backlog
   marks in the configuration; \`views/BACKLOG.md\` lists them as possible omissions.
4. When the book is right, \`askflow day-zero\`. From then on it only grows through \`askflow log\`.
` : ""}`;

// Where the ledger goes: inside the project, in a memory repo (projects/<slug>/ledger) or at any path.
export const ledgerPath = ({ root, store, path, memoryRepo, slug, name }) => {
  if (store === "project") return join(root, IN_PROJECT);
  if (store === "memory") {
    if (!memoryRepo) throw new Error("Storing the ledger in a memory repo needs its path (--memory-repo).");
    return join(resolve(expand(memoryRepo)), "projects", slug || slugify(name || basename(root)), "ledger");
  }
  if (store === "path") {
    if (!path) throw new Error("Storing the ledger elsewhere needs the path (--path).");
    return resolve(expand(path));
  }
  throw new Error(`Unknown store «${store}» (one of: ${STORES.join(", ")}).`);
};

export const init = ({ root, name, store = "project", path, memoryRepo, slug, gitignore = false, history = false, home, today }) => {
  root = resolve(expand(root));
  if (!existsSync(root)) throw new Error(`Project folder not found: ${root}`);
  name = name || basename(root);
  const settings = readSettings(home);
  if (store === "memory") memoryRepo = memoryRepo || settings.memoryRepo;
  const ledger = ledgerPath({ root, store, path, memoryRepo, slug, name });
  if (existsSync(join(ledger, CONFIG))) throw new Error(`There is already a ledger at ${ledger}. Nothing was changed.`);
  const index = readIndex(home);
  if (index[root] && existsSync(join(index[root], CONFIG))) throw new Error(`This project already has a ledger at ${index[root]}. Nothing was changed.`);

  mkdirSync(join(ledger, "views"), { recursive: true });
  writeFileSync(join(ledger, CONFIG), JSON.stringify(template({ name, root }), null, 2) + "\n");
  if (!existsSync(join(ledger, "events.jsonl"))) writeFileSync(join(ledger, "events.jsonl"), "");
  writeFileSync(join(ledger, "README.md"), readme(name, history));
  if (history) mkdirSync(join(ledger, "load"), { recursive: true });
  else writeFileSync(join(ledger, "DAY-ZERO"), dayZeroText(today, 0, 0));

  if (store === "project") {
    if (gitignore) {
      const file = join(root, ".gitignore");
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!current.split("\n").includes(`${IN_PROJECT}/`)) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${IN_PROJECT}/\n`);
    }
  } else {
    writeIndex(home, { ...index, [root]: ledger });
    if (store === "memory") writeSettings(home, { ...settings, memoryRepo: resolve(expand(memoryRepo)) });
  }
  return { ledger, root, name, store, dayZero: !history };
};
