// Project configuration: everything that is specific to one project lives here, never in the engine.
// The engine reads: idPrefix, origins, protections, done.gapLabel, board.enabled/doneStates/foreign,
// spec.enabled, gaps, backlog.marks and summary.needsInput. The rest is read by the skill and the agents.

export const DEFAULTS = {
  version: 1,
  name: "",
  idPrefix: "A",
  project: {
    root: "",               // absolute path of the working copy
    repo: "",               // e.g. "org/name" on the code host
    integrationBranch: "main",
    mergeAuthority: "",     // who gives the explicit order to merge
    localGate: "",          // what must pass locally before each commit, e.g. "lint, types, tests, build"
    rulesFiles: [],         // files with the project's working rules, e.g. ["CLAUDE.md"]
  },
  origins: {
    client: { isClient: true, requiresVerification: true },
    owner: {},
    finding: {},
    import: {},
  },
  client: {
    name: "",               // who "the client" is
    documents: [],          // where their documents live
    mail: "",               // where their mail is and how it may be accessed
    literalCriteria: true,  // their acceptance criteria are copied, never rewritten
    aliasNote: "",          // how the client numbers their own asks
  },
  done: {
    definition: "",         // what "done" means, e.g. "seen working on screen in production, with a screenshot"
    gapLabel: "closed without verification",
    url: "",                // where to verify (production URL), if any
    testData: "",           // the only data the verifier may touch
    sessionOpenedBy: "",    // who opens the authenticated session; agents never type credentials
    evidenceDir: "evidence",
    alwaysCheck: [],        // what the verifier checks on every screen besides the criteria
  },
  board: {
    enabled: false,
    tool: "", project: "", sprint: "", assignee: "", titleTag: "",
    doneStates: ["done"],
    storyPoints: false,
    nameInRepo: true,       // false: the board is never mentioned in the repository
    foreign: { column: 7, values: [], rule: "" }, // snapshot column that marks tasks owned by someone else
  },
  spec: { enabled: false, tool: "", path: "" },
  gaps: { missingCriteria: true, missingSpec: true, missingTask: true, unknownProtection: true },
  backlog: {
    cutoff: "",
    marks: {
      "NO TRACE": "No trace: no spec, PR or decision closes it",
      "UNSURE": "Unsure: could not be decided from the sources at hand",
      "DEFERRED": "Explicitly deferred",
    },
  },
  review: { rules: [] },    // product and code rules the PR reviewer enforces
  protections: ["unit", "e2e", "manual", "none", "unknown"],
  summary: { needsInput: "decision|decide|confirm|contradict" },
};

const plain = (x) => x && typeof x === "object" && !Array.isArray(x);
const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = plain(v) && plain(base[k]) ? merge(base[k], v) : v;
  return out;
};

// Defaults fill the gaps. Origins and backlog marks are the project's own vocabulary: they replace, never mix.
export const normalize = (raw = {}) => {
  const cfg = merge(structuredClone(DEFAULTS), raw);
  if (raw.origins) cfg.origins = raw.origins;
  if (raw.backlog?.marks) cfg.backlog.marks = raw.backlog.marks;
  return cfg;
};

export const checkConfig = (cfg) => {
  const errors = [];
  if (!cfg.name) errors.push("config: «name» is required");
  if (!/^[A-Z]+$/.test(cfg.idPrefix ?? "")) errors.push("config: «idPrefix» must be capital letters only");
  if (!plain(cfg.origins) || !Object.keys(cfg.origins).length) errors.push("config: at least one origin is required");
  if (!Array.isArray(cfg.protections) || !cfg.protections.length) errors.push("config: «protections» cannot be empty");
  if (!Array.isArray(cfg.board?.doneStates)) errors.push("config: «board.doneStates» must be a list");
  try { new RegExp(cfg.summary?.needsInput ?? ""); } catch { errors.push("config: «summary.needsInput» is not a valid pattern"); }
  return errors;
};

// What `askflow init` writes: the full shape, so every option is visible and editable.
export const template = ({ name, root }) => {
  const t = structuredClone(DEFAULTS);
  t.name = name;
  t.project.root = root;
  return t;
};
