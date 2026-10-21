// ── Rules engine ────────────────────────────────────────────────────────────
// Pure functions: no ctx, no fetch, no imports — backend.js cannot import a
// sibling file, so this block is inlined at the top of backend.js by build.mjs
// and unit-tested on its own with `node --test`.

// The major segments a repo can turn on or off. Each maps to a section of the
// rules bag (https://github.com/VibesDIY/rules-bag/blob/main/RULES.md).
export const SEGMENTS = {
  result: {
    title: "Result, not throw",
    blurb: "No try/catch and no throw in shipped code — return a Result and wrap risky calls in exception2Result().",
    prose:
      "Our implementation never throws — use Result. Never use try/catch → exception2Result(). Test files are exempt. Classify the failure, keep the error: at every site that discards r.Err() in favour of an enum, log the error.",
  },
  cement: {
    title: "Cement primitives",
    blurb: "Use @adviser/cement: URI instead of new URL(), ResolveOnce/Lazy instead of singletons, txt.encode instead of TextEncoder.",
    prose:
      "Do not use new URL() → use URI. Never implement a Singleton — use ResolveOnce/Lazy. Never use new TextEncoder or new TextDecoder — use this.txt.encode. Never write encoders/decoders yourself — use libraries, multiformats, cement.",
  },
  types: {
    title: "Types you can trust",
    blurb: "TypeScript only, no any, casts are a last resort, and JSON.parse goes through an arktype validator.",
    prose:
      "Never write JS, always TS. Never use any. Avoid casts — use at least 10 minutes to decide on one cast. Use arktype if you do const x = type({ x: 'string' })(JSON.parse(y)). Don't be shy about making things good — if any[] leaks from a JSON column, validate it.",
  },
  modules: {
    title: "Named exports",
    blurb: "No export default and no default imports.",
    prose: "Never use export default, nor import X from 'y'.",
  },
  falsy: {
    title: "Explicit comparisons",
    blurb: "No if (!x): say which state you mean (=== undefined, .length === 0, === false).",
    prose:
      "Avoid if (!x) falsy checks. Use explicit comparisons: x === undefined, x !== undefined, x === false, arr.length === 0. Our codebase uses undefined as the falsy state; bridge null with Option.from().",
  },
  testing: {
    title: "No mocking",
    blurb: "Never replace a module or global to make a test pass — inject at the caller boundary.",
    prose:
      "Never use mocking — never replace a global, a module, or a module's exports to make a test pass. vi.fn() handed to a prop or constructor is fine; vi.mock() is not.",
  },
  style: {
    title: "Readable shapes",
    blurb: "Function declarations over const arrows, at most 3 parameters, no Proxy, avoid instanceof, no constructor parameter properties.",
    prose:
      "Do not use const fn = () => {} unless you need lexical this (inline callbacks are fine). Never pass more than 3 parameters; use a typed object. Never use Proxy. Avoid instanceof. Never use constructor(private db: X) {}. Never spread a class instance. Use const and readonly by default.",
  },
  fetch: {
    title: "Bound fetch",
    blurb: "Never pass a detached fetch — `deps.fetch ?? fetch.bind(globalThis)`.",
    prose: "const f = deps.fetch ?? fetch then f(...) throws Illegal invocation inside a Cloudflare Worker. Always ?? fetch.bind(globalThis).",
  },
};

export const LEVELS = ["off", "note", "block"];

// Whose pull requests get an automatic review. A review runs as the person who
// connected the repo, on their credits, so the default is the repo's own team.
// GitHub stamps every PR with the author's relationship to the repo
// (`author_association`); the team is the owner, org members and collaborators.
export const WHO = {
  team: "People on the repo's team",
  anyone: "Anyone who opens a pull request",
};
export const TEAM_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

export function authorInScope(association, who) {
  return who === "anyone" || TEAM_ASSOCIATIONS.includes(association);
}

export const DEFAULT_CONFIG = {
  segments: { result: "block", cement: "note", types: "block", modules: "note", falsy: "note", testing: "block", style: "note", fetch: "block" },
  ai: false,
  who: "team",
  ignore: ["**/*.d.ts", "**/dist/**", "**/node_modules/**", "**/*.generated.*"],
};

const CODE_EXT = /\.(c|m)?(t|j)sx?$/;
const TS_EXT = /\.(c|m)?tsx?$/;
const TEST_PATH = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.(c|m)?(t|j)sx?$/;

// Each rule: id, segment, test(line, file) → boolean, message.
// Lines arrive with comments and string contents already blanked (see codeOnly).
export const RULES = [
  {
    id: "no-try-catch",
    segment: "result",
    skipTests: true,
    test: (l) => /(^|[^\w$.])try\s*\{/.test(l),
    message: "`try/catch` — wrap the risky call in `exception2Result()` and branch on the Result.",
  },
  {
    id: "no-throw",
    segment: "result",
    skipTests: true,
    test: (l) => /(^|[^\w$.])throw\s+(new\s+)?[\w$({`'"]/.test(l),
    message: "`throw` in shipped code — return `Result.Err(...)` so the caller decides.",
  },
  {
    id: "uri-not-url",
    segment: "cement",
    test: (l) => /\bnew\s+URL\s*\(/.test(l),
    message: "`new URL()` — use cement's `URI` (and check `protocol` before reading `hostname`).",
  },
  {
    id: "txt-not-textencoder",
    segment: "cement",
    test: (l) => /\bnew\s+Text(En|De)coder\s*\(/.test(l),
    message: "`new TextEncoder/TextDecoder` — use `this.txt.encode` / `TxtEnDecoderSingleton()`.",
  },
  {
    id: "no-singleton",
    segment: "cement",
    test: (l) => /\b(static\s+(instance|_instance)\b|getInstance\s*\()/.test(l),
    message: "Hand-rolled singleton — use `ResolveOnce` or `Lazy`.",
  },
  {
    id: "no-any",
    segment: "types",
    tsOnly: true,
    test: (l) => /(:\s*any\b|\bas\s+any\b|<any>|\bany\[\])/.test(l),
    message: "`any` — name the type, or validate the value with arktype at the boundary.",
  },
  {
    id: "avoid-cast",
    segment: "types",
    tsOnly: true,
    test: (l) => /\)\s*as\s+(?!const\b)[A-Z{\w]|\w\s+as\s+(?!const\b)(unknown\b|[A-Z])/.test(l) && !/^\s*(import|export)\b/.test(l),
    message: "Type cast — a cast is a decision worth ten minutes; prefer a validator or a narrower type.",
  },
  {
    id: "json-parse-validate",
    segment: "types",
    test: (l) => /\bJSON\.parse\s*\(/.test(l) && !/\btype\s*\(|\)\s*\(\s*JSON\.parse/.test(l),
    message: "`JSON.parse` result used unvalidated — feed it through an arktype `type({...})`.",
  },
  {
    id: "no-export-default",
    segment: "modules",
    test: (l) => /^\s*export\s+default\b/.test(l),
    message: "`export default` — export by name.",
  },
  {
    id: "no-default-import",
    segment: "modules",
    test: (l) => /^\s*import\s+(?!type\b)[\w$]+\s*(,|from\b)/.test(l),
    message: "Default import — use a named import (`import { X } from`).",
  },
  {
    id: "no-falsy-if",
    segment: "falsy",
    test: (l) => /\bif\s*\(\s*!(?!=)\s*[\w$.()[\]?]+\s*\)/.test(l),
    message: "`if (!x)` — say which state you mean: `=== undefined`, `.length === 0`, `=== false`.",
  },
  {
    id: "no-module-mock",
    segment: "testing",
    test: (l) => /\b(vi|jest)\.(mock|doMock|stubGlobal)\s*\(/.test(l),
    message: "Module/global mock — inject the dependency at the caller boundary instead.",
  },
  {
    id: "function-declaration",
    segment: "style",
    test: (l) => /^\s*(export\s+)?const\s+[\w$]+\s*(:\s*[^=]+)?=\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*(:\s*[^=]+)?=>/.test(l),
    message: "`const fn = () =>` — write `function fn()` unless you need lexical `this`.",
  },
  {
    id: "max-three-params",
    segment: "style",
    test: (l) => {
      const m = /\bfunction\s*[\w$]*\s*\(([^)]*)\)/.exec(l);
      if (m === null || m[1].trim().length === 0) return false;
      return m[1].split(",").filter((p) => p.trim().length > 0).length > 3;
    },
    message: "More than 3 parameters — pass one typed object (`fn({ a, b, c, d })`).",
  },
  {
    id: "no-proxy",
    segment: "style",
    test: (l) => /\bnew\s+Proxy\s*\(/.test(l),
    message: "`Proxy` — never. Make the behaviour explicit.",
  },
  {
    id: "avoid-instanceof",
    segment: "style",
    test: (l) => /\binstanceof\b/.test(l),
    message: "`instanceof` — prefer a `type` discriminant or a type guard.",
  },
  {
    id: "no-param-properties",
    segment: "style",
    tsOnly: true,
    test: (l) => /\bconstructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w/.test(l),
    message: "Constructor parameter properties are bundle-unfriendly — declare the field and assign it.",
  },
  {
    id: "bound-fetch",
    segment: "fetch",
    test: (l) => /\?\?\s*fetch\b(?!\.bind)|[=:]\s*fetch\s*[;,]/.test(l) && !/\bfetch\s*\(/.test(l.replace(/\?\?\s*fetch\b/, "")),
    message: "Detached `fetch` — use `fetch.bind(globalThis)` or it throws `Illegal invocation` in a Worker.",
  },
];

// File-level rule: a new .js/.jsx file where the repo is TypeScript.
export const FILE_RULES = [
  {
    id: "typescript-only",
    segment: "types",
    test: (f) => f.status === "added" && /\.(c|m)?jsx?$/.test(f.filename) && !/(^|\/)(\.|config|scripts\/)|\.config\./.test(f.filename),
    message: "New JavaScript file — write it in TypeScript.",
  },
];

// Blank out string literals and comments so a rule never fires on prose.
// A tiny state machine is enough because we only look at one line at a time;
// block comments carry their state across lines through `state.inBlock`.
export function codeOnly(line, state) {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < line.length) {
    const c = line[i];
    const n = line[i + 1];
    if (state.inBlock === true) {
      if (c === "*" && n === "/") {
        state.inBlock = false;
        out += "  ";
        i += 2;
      } else {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (quote !== "") {
      if (c === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === quote) quote = "";
      out += c === quote || quote === "" ? c : " ";
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") break;
    if (c === "/" && n === "*") {
      state.inBlock = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Parse a unified-diff patch (GitHub's `files[].patch`) into the ADDED lines
// with their new-file line numbers — the only lines a review may comment on
// with side RIGHT, and the only lines the author is answerable for.
export function addedLines(patch) {
  const out = [];
  if (typeof patch !== "string") return out;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h !== null) {
      newLine = Number(h[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // removed line or "\ No newline" marker: the new file does not advance
    } else {
      newLine += 1;
    }
  }
  return out;
}

// `// rules-bag-allow: <rule-id> <reason>` on the line itself or the line
// above turns a finding into an EXCEPTION REQUEST — the 1% a human rules on.
const ALLOW = /rules-bag-allow:\s*([\w-]+)(?:\s+(.*))?/;

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 1;
      if (glob[i + 1] === "/") i += 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function normalizeConfig(input) {
  const cfg = input !== null && typeof input === "object" ? input : {};
  const segments = {};
  for (const key of Object.keys(SEGMENTS)) {
    const v = cfg.segments !== undefined && cfg.segments !== null ? cfg.segments[key] : undefined;
    segments[key] = LEVELS.includes(v) ? v : DEFAULT_CONFIG.segments[key];
  }
  const ignore = Array.isArray(cfg.ignore) ? cfg.ignore.filter((g) => typeof g === "string").slice(0, 50) : DEFAULT_CONFIG.ignore;
  const who = Object.keys(WHO).includes(cfg.who) ? cfg.who : DEFAULT_CONFIG.who;
  return { segments, ai: cfg.ai === true, who, ignore };
}

// files: GitHub `GET /pulls/{n}/files` rows ({ filename, status, patch }).
// Returns { findings, exceptions } — each finding carries the level of its segment.
export function reviewFiles(files, configInput) {
  const config = normalizeConfig(configInput);
  const ignore = config.ignore.map(globToRegExp);
  const findings = [];
  const exceptions = [];
  for (const f of files) {
    const path = f.filename;
    if (typeof path !== "string" || CODE_EXT.test(path) === false) continue;
    if (ignore.some((re) => re.test(path))) continue;
    const isTest = TEST_PATH.test(path);
    const isTs = TS_EXT.test(path);
    for (const rule of FILE_RULES) {
      const level = config.segments[rule.segment];
      if (level === "off" || rule.test(f) === false) continue;
      findings.push({ path, line: undefined, rule: rule.id, segment: rule.segment, level, message: rule.message });
    }
    const lines = addedLines(f.patch);
    const state = { inBlock: false };
    let prevText = "";
    for (const { line, text } of lines) {
      const code = codeOnly(text, state);
      for (const rule of RULES) {
        const level = config.segments[rule.segment];
        if (level === "off") continue;
        if (rule.skipTests === true && isTest) continue;
        if (rule.tsOnly === true && isTs === false) continue;
        if (rule.test(code) === false) continue;
        const allow = ALLOW.exec(text) ?? ALLOW.exec(prevText);
        if (allow !== null && (allow[1] === rule.id || allow[1] === rule.segment)) {
          exceptions.push({ path, line, rule: rule.id, segment: rule.segment, reason: (allow[2] ?? "").trim() });
          continue;
        }
        findings.push({ path, line, rule: rule.id, segment: rule.segment, level, message: rule.message });
      }
      prevText = text;
    }
  }
  return { findings, exceptions };
}

// One review per head SHA. `event` is what GitHub's review API takes.
export function summarize({ findings, exceptions, sha, repo, appUrl }) {
  const blocking = findings.filter((f) => f.level === "block");
  const bySegment = {};
  for (const f of findings) bySegment[f.segment] = (bySegment[f.segment] ?? 0) + 1;
  const event = blocking.length > 0 ? "REQUEST_CHANGES" : "COMMENT";
  const lines = [];
  if (findings.length === 0 && exceptions.length === 0) {
    lines.push(`**Rules bag: clean** on \`${sha.slice(0, 7)}\` — nothing to fix.`);
  } else {
    lines.push(
      `**Rules bag** on \`${sha.slice(0, 7)}\`: ${findings.length} finding${findings.length === 1 ? "" : "s"}` +
        (blocking.length > 0 ? `, ${blocking.length} blocking` : "") +
        (exceptions.length > 0 ? `, ${exceptions.length} exception request${exceptions.length === 1 ? "" : "s"}` : "") +
        "."
    );
    lines.push("");
    for (const [seg, n] of Object.entries(bySegment)) lines.push(`- ${SEGMENTS[seg].title}: ${n}`);
    for (const e of exceptions)
      lines.push(`- Exception asked: \`${e.rule}\` at \`${e.path}:${e.line}\`${e.reason !== "" ? ` — “${e.reason}”` : ""}`);
  }
  lines.push("");
  const invite = `${appUrl}?utm_source=github&utm_medium=review&utm_campaign=rules-bag-reviewer`;
  lines.push(
    `<sub>Reviewed by [Rules Bag Reviewer](${invite}), a vibe on vibes.diy. Add it to your own repo in a few clicks. ` +
      `\`${repo}\`'s admins pick its rules on the same page · [the rules bag](https://github.com/VibesDIY/rules-bag/blob/main/RULES.md)</sub>`
  );
  return { event, body: lines.join("\n") };
}

// Map findings to GitHub review comments; file-level ones go in the body.
// GitHub caps a review's comments, so keep the first 50 and say so.
export function reviewComments(findings) {
  return findings
    .filter((f) => f.line !== undefined)
    .slice(0, 50)
    .map((f) => ({
      path: f.path,
      line: f.line,
      side: "RIGHT",
      body: `${f.level === "block" ? "🔴" : "🟡"} **${f.rule}** (${SEGMENTS[f.segment].title}) — ${f.message}\n\n<sub>Disagree? Add \`// rules-bag-allow: ${f.rule} <why>\` above the line and a human will rule on it.</sub>`,
    }));
}
