---
name: askflow
description: The five-gate workflow for projects that have an askflow ledger (a `.askflow/` folder, or a ledger registered with `askflow init`). In such a project use it before touching code, when a new request from the client arrives, when updating the board, when opening or reviewing a PR, and before calling anything done. Also with /askflow. In a project with no ledger it does nothing except offer `askflow init`.
---

# askflow — the five gates

## 0. Is this project on askflow?

Run `askflow config` from the working directory.

- **Exit code 3 ("No askflow ledger")**: this project does not use askflow. Stop: follow the project's own
  workflow and do not apply anything below. Offer `askflow init` only if the user asked to set it up.
- **Otherwise** it prints JSON: `ledger` (the ledger folder), `dayZero`, `boardSnapshot` and `config`.
  Everything project-specific below comes from `config`. Never assume a value that is not there; an empty
  field means the project has not defined it, so ask the user rather than invent it.

Names used below, all from `config`:

| Here | Field |
|---|---|
| the client | `client.name`; their asks are the items whose origin has `isClient: true` in `origins` |
| the client's sources | `client.documents`, `client.mail` |
| the merge authority | `project.mergeAuthority` |
| the integration branch | `project.integrationBranch` |
| the local gate | `project.localGate` |
| done | `done.definition`, verified at `done.url`, touching only `done.testData` |
| the board | `board.*`, only if `board.enabled` |
| the spec tool | `spec.*`, only if `spec.enabled` |

## The ledger

No work starts, advances or closes outside these gates. The **ledger** is the memory: consult it before
re-reading documents, code or the live system, and write to it at every gate.

- Read at the start of a session: `<ledger>/views/SUMMARY.md` (short). One item: `askflow show <id>`.
  Search: `grep -i "<word>" <ledger>/events.jsonl`.
- Write **only** with `askflow log '<json>'` from the main session, then `askflow views`. Never edit or
  delete a line of `events.jsonl`. A mistake is corrected with a `decision` event that explains it.
- If `dayZero` is false the project is still doing its initial load: `askflow log` refuses to write. Follow
  the "Initial load" section of `<ledger>/README.md` (`askflow import`, then `askflow day-zero`).

Event types: `opened` · `linked` (spec, task or PR) · `supersedes` (with `target`) · `obsolete` ·
`decision` (`text` and `why`) · `partial` (`reason`) · `implemented` (`pr` or `commit`) · `reviewed` ·
`verified` (`evidence`) · `closed`.

## Rules that are never skipped

1. **When in doubt about what was asked, read the client's sources** before deciding. If the doubt remains,
   ask the user. Never decide on the client's behalf.
2. The client's latest word rules; what came before becomes obsolete through an event, never by deletion.
3. Backwards compatible: never duplicate or reopen a closed board task or an archived spec. If something
   already delivered is broken, that is a **new item** linked to the old one.
4. "Done" for an item that requires verification (`verify: true`; mandatory for origins with
   `requiresVerification`) means exactly `done.definition`. `done.sessionOpenedBy` opens any authenticated
   session; an agent never types credentials.
5. Merge only on the explicit order of the merge authority.
6. Heavy reading (client packages, mail threads, whole specs) is a subagent's job, returning a structured
   summary; the main session does not absorb that context.
7. Only the main session writes to the ledger and to the board. Agents read and report.

## Gate 1 — Entry: the goal

First search the ledger for the item (by the client's alias, title or surface).

- **It exists**: work on it. If the new request changes what was asked, open a new item and log
  `supersedes` on the old one.
- **It does not exist**: log `opened` with `title`, `origin` (one of `config.origins`), `mode`, `goal`,
  `criteria`, `surface` (list), `protection` (one of `config.protections`), `verify` and `source`. One item
  per thing the client can accept separately; their own numbering goes in `aliases`. If
  `client.literalCriteria` is true, the client's criteria are copied word for word, not rewritten.
- `mode: "preserve"` (refactor, design, internal improvement): business rules, screens and flows do not
  change; it is protected by existing tests, which the opening names. `mode: "replace"`: it changes what
  exists and **requires acceptance criteria of its own**.
- A new delivery from the client: launch the `askflow-archivist` agent with the path of the material. It
  returns the proposed items; the main session reviews and logs them.

**Board** (if enabled): create the task only if it does not exist yet, following `board.titleTag`,
`board.sprint` and `board.assignee`, with the item's acceptance criteria in the description and story
points if `board.storyPoints`. Log `linked` with the task code. Tasks matching `board.foreign` belong to
someone else: never touch them. If `board.nameInRepo` is false, the board is never mentioned in the
repository (code, commits, PRs).

## Gate 2 — Before working: the spec

- If `spec.enabled`: a change in the spec tool (`spec.tool`, under `spec.path`) that cites the item id. If
  an active one already covers the item, continue it. Log `linked` with `spec`.
- If not: the item's goal and criteria are the spec; make sure they are precise enough to test.
- Read the client's current specification for the area and the state of the code. If they differ, the
  specification wins; if it is not specified, ask.
- Decisions taken are logged as `decision` with their why.

**Board:** task in progress.

## Gate 3 — Each unit: the test first

- TDD: failing test → minimum code → green. For `mode: "preserve"`, the existing tests of the surface are
  green before and after.
- The local gate passes before every commit.
- If anything is left half done when the session ends: `partial` with the exact reason and what is
  missing. This is what saves walking through everything again.
- Keep the spec's task list up to date as work advances.

**Board:** a comment on the task if the scope changes or a blocker appears.

## Gate 4 — PR review

- PR from the working branch into the integration branch, with the item id in the description.
- Review by the `askflow-pr-reviewer` agent, which has not seen the conversation. Give it **only** the PR
  number and the item id — not your explanation, conclusions or history: the review is worth something
  because it is not anchored on yours. Do not review the same thing yourself while it runs.
- Check every blocking or important finding (file and line) before accepting it; discard, with the reason,
  any that does not hold. Fix what is confirmed on the same branch, with its test, and pass the local gate
  again. Present the verdict, confirmed findings, fixes and what remains.
- Log `implemented` (with the PR) and `reviewed`; `partial` with the reason if changes are still pending.
- Publish nothing on the code host (comments, approvals) unless the user asks.

**Board:** a comment with the PR and the verdict. The task is **not** done yet.

## Gate 5 — Close: verification

- With the change live, check every criterion. Items with `verify: true`: by the `askflow-verifier` agent,
  with evidence saved under `<ledger>/<done.evidenceDir>/<id>/`. Other items: whatever the opening declares.
- Log `verified` with the evidence and, when everything is in, `closed`.
- Archive the spec change when it has no live items left.
- `askflow views`.

**Board:** now the task goes to done, with a comment carrying the evidence and the PR. If the board says
done and the ledger does not, the ledger rules: correct the board comment, without reopening.

## When updating the board

Refresh the snapshot in the ledger folder (`board-<sprint>-<date>.tsv`, tab-separated: code, state, created,
closed, type, title, then any extra columns; the one at `board.foreign.column` marks whose task it is) and
run `askflow reconcile`. `views/RECONCILIATION.md` says what differs each way, which open tasks have no
item and which items have no task. Correct the board to say what the ledger says, without reopening
closed tasks.

## When any session ends

`askflow validate && askflow views`, and commit the ledger wherever it lives. If something is not logged,
the session is not over.
