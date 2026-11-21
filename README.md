# askflow

From ask to verified. An append-only ledger of what was asked, plus a five-gate workflow that every piece
of work goes through — built for projects where an AI coding agent does much of the work and nobody wants
to re-read every email, spec and screen to know what was asked and what is really done.

- **The ledger** is an event book that only grows (`events.jsonl`). It records what was asked, when, what
  replaced it, what was decided, what was left half done and why, and what has been verified. State is
  computed from it, never written by hand.
- **The five gates** are Entry (the goal) → Spec → Test first → PR review → Verification. The ledger is
  written at each one.
- **Nothing project-specific is in the tool.** Who the client is, what "done" means, the board, the spec
  tool, the review rules: all of it lives in one configuration file per project.

Zero dependencies. Node 20 or later.

## Install

```
git clone https://github.com/Manumac86/askflow-cli.git && cd askflow-cli && npm link     # puts `askflow` on your PATH
askflow install                                      # copies the skill and agents into ~/.claude
```

`askflow install` adds one Claude Code skill (`askflow`) and three agents (`askflow-archivist`,
`askflow-pr-reviewer`, `askflow-verifier`). Their source of truth is this repository; a file that already
exists and differs is kept as `<name>.bak-<date>`.

## Set a project up

```
cd my-project
askflow init
```

It asks for the project name, whether there are earlier asks to load, and **where the ledger lives**:

| Store | Where | Leaves files in the project? |
|---|---|---|
| `project` | `.askflow/` inside the project (committed, or ignored with `--ignore`) | yes |
| `memory` | `<memory repo>/projects/<slug>/ledger` — a separate repository for notes | no |
| `path` | any folder you name | no |

Non-interactive: `askflow init --yes --name "My project" --store memory --memory-repo ~/notes --slug my-project`.

For `memory` and `path`, the project is registered in `~/.config/askflow/projects.json` so the ledger is
found from anywhere inside the project, including git worktrees.

Then edit `askflow.config.json` in the ledger folder. `askflow config` shows where it is.

## Daily use

```
askflow config                 # where the ledger is and how the project is configured
askflow log '{"type":"opened","title":"…","origin":"client","mode":"replace","goal":"…","criteria":["…"],"surface":["…"],"protection":"unit","verify":true}'
askflow log '{"item":"A-0001","type":"partial","reason":"not seen live yet"}'
askflow show A-0001            # full history of one item
askflow views                  # views/SUMMARY.md, STATUS.md, BACKLOG.md
askflow reconcile              # ledger vs. the latest board snapshot
askflow validate
```

Event types: `opened` · `linked` · `supersedes` · `obsolete` · `decision` · `partial` · `implemented` ·
`reviewed` · `verified` · `closed`.

Phases, computed: open → partial → implemented, unverified → reviewed, unverified → verified → closed.
A later `partial` never moves an item backwards; it stays as pending.

Gaps the ledger points out: no acceptance criteria, no spec, no linked task, protection undetermined,
closed without verification, and "board says done, ledger does not". The spec and board gaps only exist if
the project uses a spec tool and a board.

## Walkthrough: one ask through the five gates

Sam, the client, asks for a PDF export of the monthly report (their request R-12). The project uses the
example configuration shown under [Configuration](#configuration): a board, a spec tool, and "done" meaning
seen in production. With Claude Code the `askflow` skill runs these steps; they are shown here as the bare
commands so you can see what ends up in the ledger.

**Gate 1 — Entry.** Search the ledger first (`grep -i "pdf" .askflow/events.jsonl`). It is not there, so
open it, copying the client's criteria word for word. The ledger assigns the id.

```
askflow log '{"type":"opened","title":"Export the monthly report as PDF","aliases":["R-12"],
  "origin":"client","mode":"replace","goal":"Sam can download the monthly report as a PDF",
  "criteria":["A «Download PDF» button appears on the monthly report page",
              "The PDF shows the same totals as the screen"],
  "surface":["reports"],"protection":"e2e","verify":true,
  "source":"docs/client/deliveries/2026-03-01.md, point 3"}'
# A-0001 · opened logged.
```

Create the board task with those criteria in its description and link it:

```
askflow log '{"item":"A-0001","type":"linked","task":"PORTAL-88"}'
```

**Gate 2 — Spec.** Write the spec change, citing `A-0001`, and link it. Decisions go in with their reason,
so nobody has to rediscover them:

```
askflow log '{"item":"A-0001","type":"linked","spec":"report-pdf-export"}'
askflow log '{"item":"A-0001","type":"decision","text":"Render the PDF on the server",
  "why":"the totals must match the stored figures, not what the browser recalculates"}'
```

**Gate 3 — Test first.** Failing test, minimum code, green; the local gate passes before each commit. The
session ends with work half done, so say exactly what is missing:

```
askflow log '{"item":"A-0001","type":"partial","reason":"PDF renders; totals row still missing"}'
```

The next session starts by reading `views/SUMMARY.md` and `askflow show A-0001` instead of re-reading the
client's mail and the code.

**Gate 4 — PR review.** Open the PR into the integration branch with `A-0001` in its description. The
`askflow-pr-reviewer` agent gets only the PR number and the item id, and checks the diff against the
item's criteria and the project's `review.rules`. Fix what it finds, then:

```
askflow log '{"item":"A-0001","type":"implemented","pr":"#41"}'
askflow log '{"item":"A-0001","type":"reviewed","note":"approve with minor changes, both fixed"}'
askflow views
```

The item is now `reviewed, unverified`. It is **not** done, and neither is the board task:

```
**1 live items** · 1 reviewed, unverified · 0 obsolete · 0 archived backlog

| Spec | Items | Verified | Unverified | Partial |
|---|---|---|---|---|
| report-pdf-export | 1 | 0 | 1 | 0 |
```

**Gate 5 — Verification.** Once the change is live, the `askflow-verifier` agent checks each criterion at
`done.url`, touching only `done.testData`, and saves a screenshot per criterion. Only then:

```
askflow log '{"item":"A-0001","type":"verified",
  "evidence":"evidence/A-0001/A-0001-c1-button.png, A-0001-c2-totals.png"}'
askflow log '{"item":"A-0001","type":"closed"}'
askflow views
```

Now the board task goes to done. `askflow show A-0001` is the whole story:

```
# A-0001 — Export the monthly report as PDF

- Origin: client · mode: replace · phase: closed
- Aliases: R-12
- Goal: Sam can download the monthly report as a PDF
- Criteria:
  - A «Download PDF» button appears on the monthly report page
  - The PDF shows the same totals as the screen
- Surface: reports · protection: e2e · verification required: yes
- Specs: report-pdf-export · tasks: PORTAL-88 · PRs: #41

## History

- 2026-03-02 · opened — Export the monthly report as PDF [docs/client/deliveries/2026-03-01.md, point 3]
- 2026-03-02 · linked — PORTAL-88
- 2026-03-02 · linked — report-pdf-export
- 2026-03-02 · decision — Render the PDF on the server Why: the totals must match the stored figures, not what the browser recalculates
- 2026-03-02 · partial — PDF renders; totals row still missing
- 2026-03-02 · implemented — #41
- 2026-03-02 · reviewed — approve with minor changes, both fixed
- 2026-03-02 · verified — evidence/A-0001/A-0001-c1-button.png, A-0001-c2-totals.png
- 2026-03-02 · closed —
```

Had the item been closed without the `verified` event, the ledger would report the gap
"closed without seeing it in production" (the project's `done.gapLabel`) until someone checked.

If Sam later changes the request, nothing is edited: open a new item and log
`{"item":"A-0002","type":"supersedes","target":"A-0001"}`. The old one becomes obsolete and stays readable.

The JSON is wrapped over several lines here for reading; each `askflow log` takes one JSON argument.

## A project with history

`askflow init --history` leaves day zero undeclared. Until it is declared `askflow log` refuses to write,
and the book is filled in batches:

```
askflow import load/batch-1.jsonl            # dry run
askflow import load/batch-1.jsonl --apply
askflow day-zero                             # from here on the book only grows
```

A batch is one event per line. Openings carry `"imported": true`, `"backlog": true` and a local `"ref"`;
later lines point at them with `"item": "@ref"`. Closed backlog is archived and does not count as live
work; what the load could not close is listed in `views/BACKLOG.md` as possible omissions.

## Configuration

`askflow init` writes the full shape with defaults; see `src/config.mjs` for what each field means.

| Section | What it holds |
|---|---|
| `name`, `idPrefix` | project name; prefix of item ids (`A-0001`) |
| `project` | root, repo, integration branch, who orders merges, the local gate, rules files |
| `origins` | where asks come from; which is the client's and which require verification |
| `client` | who the client is, where their documents and mail are, whether criteria are copied literally |
| `done` | what "done" means, where to verify, allowed test data, who opens sessions, always-check list |
| `board` | tool, project, sprint, assignee, title tag, done states, foreign-task marker, whether it may be named in the repo |
| `spec` | whether a spec tool (e.g. OpenSpec) is used and where its changes live |
| `gaps` | which gaps are reported |
| `backlog` | cutoff date and the marks for asks that could not be closed |
| `review` | the product and code rules the PR reviewer enforces |

### Example: a filled-in configuration

A web product built for an external client, with a board, a spec tool and "done" meaning seen in
production. It is the configuration the walkthrough above uses.

```json
{
  "name": "Acme Portal",
  "idPrefix": "A",
  "project": {
    "root": "/home/dev/acme-portal",
    "repo": "acme/portal",
    "integrationBranch": "develop",
    "mergeAuthority": "Dana (tech lead)",
    "localGate": "npm run lint && npm run typecheck && npm test && npm run build",
    "rulesFiles": ["CLAUDE.md", "docs/conventions.md"]
  },
  "origins": {
    "client": { "isClient": true, "requiresVerification": true },
    "team": {},
    "finding": {},
    "import": {}
  },
  "client": {
    "name": "Northwind (Sam, product owner)",
    "documents": ["docs/client/index.md", "docs/client/deliveries/"],
    "mail": "shared inbox, read-only",
    "literalCriteria": true,
    "aliasNote": "Sam numbers requests as R-<n>"
  },
  "done": {
    "definition": "seen working on screen in production, with a screenshot per criterion",
    "gapLabel": "closed without seeing it in production",
    "url": "https://portal.example.com",
    "testData": "only the demo tenant «Sandbox Ltd»",
    "sessionOpenedBy": "Dana",
    "evidenceDir": "evidence",
    "alwaysCheck": ["no internal ids or keys on screen", "dates shown as dd/mm/yyyy"]
  },
  "board": {
    "enabled": true,
    "tool": "Linear",
    "project": "PORTAL",
    "sprint": "current cycle",
    "assignee": "dana",
    "titleTag": "[Portal]",
    "doneStates": ["Done"],
    "storyPoints": true,
    "nameInRepo": true,
    "foreign": { "column": 7, "values": ["mobile"], "rule": "tasks labelled «mobile» belong to another team" }
  },
  "spec": { "enabled": true, "tool": "openspec", "path": "openspec/changes" },
  "gaps": { "missingCriteria": true, "missingSpec": true, "missingTask": true, "unknownProtection": true },
  "backlog": {
    "cutoff": "2026-01-01",
    "marks": { "NO TRACE": "No trace: nothing closes it", "DEFERRED": "Explicitly deferred" }
  },
  "review": {
    "rules": ["every query is scoped to the current tenant", "no `any` in TypeScript", "user-facing text goes through i18n"]
  }
}
```

What changes for other kinds of project:

- **No client** (your own tool or library): keep only origins such as `owner` and `finding`, none with
  `requiresVerification`, and leave `client` empty. Each item then declares `verify` itself.
- **Nothing to look at on a screen** (a CLI, a library, a data pipeline): write `done.definition` for what
  proof means there — "the command runs against the sample dataset and its output is attached" — and leave
  `done.url` empty.
- **No board or no spec tool**: set `board.enabled` or `spec.enabled` to `false`. The matching gates are
  skipped and their gaps are not reported.

## Develop

```
npm test
```

`src/engine.mjs` is pure (no file access) and knows nothing about any project; `bin/askflow.mjs` is the
only place that reads and writes.

## License

MIT. See `LICENSE`.
