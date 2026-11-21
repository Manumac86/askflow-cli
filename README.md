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

## Develop

```
npm test
```

`src/engine.mjs` is pure (no file access) and knows nothing about any project; `bin/askflow.mjs` is the
only place that reads and writes.

## License

MIT. See `LICENSE`.
