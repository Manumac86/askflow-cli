// The Markdown board: for projects that keep their tasks in a file instead of a board tool.
// Pure text in, text out. One `## <state>` section per state; one task per line:
//   - [ ] T-1 · Title (A-0001)
// Indented lines under a task are its notes and travel with it. The file can also be edited by hand.

const TASK = /^- \[( |x|X)\] (\S+) · (.*)$/;
const HEAD = /^(#{1,6}) +(.*?)\s*$/;
const ITEM = /\s*\(([A-Z]+-\d+)\)\s*$/;
const NOTE = /^\s+\S/;

const toLines = (text) => { const l = text.split("\n"); while (l.length && l.at(-1) === "") l.pop(); return l; };
const toText = (lines) => lines.join("\n") + "\n";
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

const canon = (b, state) => {
  const found = b.states.find((s) => same(s, String(state ?? "")));
  if (!found) throw new Error(`Unknown state «${state}». This board has: ${b.states.join(", ")}.`);
  return found;
};

export const newBoard = (name, b) => toText([
  `# Board — ${name}`, "",
  "<!-- Kept with `askflow board add` and `askflow board move`. One task per line:",
  `     "- [ ] ${b.taskPrefix}-1 · Title (A-0001)". Indented lines under a task are its notes: acceptance`,
  "     criteria, the PR, the evidence. The ledger rules; this file says where each task stands. -->",
  ...b.states.flatMap((s) => ["", `## ${s}`]),
]);

// code → { state, title, tag, item }: the same shape the engine reads from a board snapshot.
export const parseBoardFile = (text) => {
  const tasks = new Map();
  let state = "";
  for (const line of toLines(text)) {
    const h = HEAD.exec(line);
    if (h) { if (h[1].length <= 2) state = h[1].length === 2 ? h[2] : ""; continue; }
    const t = TASK.exec(line);
    if (!t) continue;
    const item = ITEM.exec(t[3]);
    tasks.set(t[2], { state, title: t[3].replace(ITEM, ""), tag: "", item: item ? item[1] : "" });
  }
  return tasks;
};

// Puts a task (its line and its notes) at the end of the tasks of a state, creating the section if missing.
const insert = (lines, state, block) => {
  const h = lines.findIndex((l) => { const m = HEAD.exec(l); return m && m[1].length === 2 && same(m[2], state); });
  if (h < 0) { while (lines.length && lines.at(-1) === "") lines.pop(); return [...lines, "", `## ${state}`, "", ...block]; }
  let end = lines.findIndex((l, i) => i > h && HEAD.test(l));
  if (end < 0) end = lines.length;
  let last = -1;
  for (let i = h + 1; i < end; i++) if (TASK.test(lines[i])) { last = i; while (last + 1 < end && NOTE.test(lines[last + 1])) last++; }
  if (last >= 0) return [...lines.slice(0, last + 1), ...block, ...lines.slice(last + 1)];
  const rest = lines.slice(h + 1);
  while (rest.length && rest[0] === "") rest.shift();
  return [...lines.slice(0, h + 1), "", ...block, ...(rest.length ? ["", ...rest] : [])];
};

const tick = (b, state) => (b.doneStates.includes(state) ? "x" : " ");

export const addTask = (text, b, { title, state, item } = {}) => {
  title = String(title ?? "").trim();
  if (!title) throw new Error("A task needs a title.");
  state = canon(b, state ?? b.states[0]);
  const numbers = [...parseBoardFile(text).keys()].map((c) => new RegExp(`^${b.taskPrefix}-(\\d+)$`).exec(c)).filter(Boolean).map((m) => Number(m[1]));
  const code = `${b.taskPrefix}-${Math.max(0, ...numbers) + 1}`;
  const line = `- [${tick(b, state)}] ${code} · ${title}${item ? ` (${item})` : ""}`;
  return { text: toText(insert(toLines(text), state, [line])), code, state };
};

export const moveTask = (text, b, code, state) => {
  state = canon(b, state);
  const lines = toLines(text);
  const at = lines.findIndex((l) => TASK.exec(l)?.[2] === code);
  if (at < 0) throw new Error(`No task ${code} on the board.`);
  let end = at + 1;
  while (end < lines.length && NOTE.test(lines[end])) end++;
  const block = lines.slice(at, end);
  block[0] = block[0].replace(/^- \[.\]/, `- [${tick(b, state)}]`);
  return { text: toText(insert([...lines.slice(0, at), ...lines.slice(end)], state, block)), code, state };
};
