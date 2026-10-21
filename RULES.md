# The rules bag

The coding rules the Rules Bag Reviewer checks, in eight groups. Each repo
turns each group off, to a comment, or to "request changes". The rules favor
code that says exactly what it means: failures you can see in the types, values
you've checked, and shapes another person (or model) can read at a glance.

Every rule has room for a considered exception. Put
`// rules-bag-allow: <rule-or-group> <why>` on the line or the line above, and
the review lists it for a person to decide on instead of flagging it.

The rules apply to TypeScript and JavaScript source (`.ts`, `.tsx`, `.js`,
`.jsx` and their `.mjs`/`.cjs`/`.mts`/`.cts` cousins), only to lines a pull
request adds. Comments and string contents are ignored, and generated output
(`*.d.ts`, `dist/`, `node_modules/`, `*.generated.*`) is skipped.

---

## 1. Result, not throw — `result`

**The rule.** Shipped code returns a `Result` instead of throwing, and wraps
calls that might throw in `exception2Result()` instead of `try/catch`.

**Why.** A thrown error is invisible in a function's signature, so every caller
has to remember to guard against it. A `Result` puts the failure in the type,
and the caller decides what happens next. When you turn a failure into a
reason code, keep the original error in your logs, so a handled failure is
still diagnosable.

**Test files are exempt** — inside a test, a throw is how the runner reports a
failure.

```ts
import { Result, exception2Result } from "@adviser/cement";

function readConfig(path: string): Result<string> {
  const text = exception2Result(() => readFileSync(path, "utf8"));
  if (text.isErr()) {
    log.warn("config unreadable", { path, error: text.Err() });
    return Result.Err(text.Err());
  }
  return Result.Ok(text.Ok());
}
```

Checks: `no-try-catch`, `no-throw`.

---

## 2. Cement primitives — `cement`

**The rule.** Reach for the [`@adviser/cement`](https://www.npmjs.com/package/@adviser/cement)
building blocks: `URI` instead of `new URL()`, `ResolveOnce` or `Lazy` instead
of a hand-rolled singleton, and cement's text encoder instead of
`new TextEncoder()` / `new TextDecoder()`.

**Why.** `URL` behaves differently across runtimes and throws on bad input;
`URI` returns a `Result`. Singletons hide shared state and are hard to reset in
tests; `ResolveOnce` and `Lazy` make "compute once" explicit. A shared encoder
avoids allocating one per call. More broadly: lean on well-tested libraries for
encodings and formats rather than writing your own.

When parsing an untrusted URL, check `protocol` is `http:` or `https:` before
reading `hostname`.

```ts
import { URI, ResolveOnce } from "@adviser/cement";

const endpoint = URI.from(raw);
const client = new ResolveOnce<Client>();
function getClient(): Promise<Client> {
  return client.once(() => createClient(endpoint));
}
```

Checks: `uri-not-url`, `no-singleton`, `txt-not-textencoder`.

---

## 3. Types you can trust — `types`

**The rule.** Write TypeScript, not JavaScript. Never use `any`. Treat a type
cast as a last resort worth real thought. Feed every `JSON.parse` result
through a runtime validator such as [arktype](https://arktype.io).

**Why.** Types only help when they're true. `any` and casts tell the compiler
to stop checking; unvalidated JSON is `any` in disguise. Validate at the
boundary once, and everything downstream can trust the type. If you see a
loose type leaking in, fix it now — type debt compounds quietly.

```ts
import { type } from "arktype";

// A typed { theme, fontSize }, or arktype errors saying what didn't match.
const settings = type({ theme: "'light' | 'dark'", fontSize: "number" })(JSON.parse(raw));
```

Checks: `typescript-only` (a newly added `.js`/`.jsx` file outside config and
scripts), `no-any`, `avoid-cast`, `json-parse-validate`.

---

## 4. Named exports — `modules`

**The rule.** No `export default` and no default imports. Export and import by
name.

**Why.** A named export has one name everywhere it's used, so search, rename
and auto-import all work, and a typo is a compile error instead of a silently
different binding. Default exports also resolve inconsistently across bundlers
and import maps.

```ts
// load.ts
export function loadSettings() { /* … */ }

// app.ts
import { loadSettings } from "./load.js";
```

(If a framework requires a default export — some route and story formats do —
mark that one line with `rules-bag-allow`.)

Checks: `no-export-default`, `no-default-import`.

---

## 5. Explicit comparisons — `falsy`

**The rule.** Avoid `if (!x)`. Say which state you mean.

**Why.** `!x` lumps `undefined`, `null`, `0`, `""`, `false` and `NaN` into one
branch, which hides bugs when an empty string or a zero is a perfectly good
value. An explicit comparison documents what you expected. Prefer `undefined`
as the "nothing here" value, and bridge `null` from other APIs at the edge
(cement's `Option.from()` helps).

```ts
if (user === undefined) return signIn();
if (items.length === 0) return renderEmpty();
if (result.isOk() === false) return showError(result.Err());
const name = input.name ?? "Untitled";
```

Checks: `no-falsy-if`.

---

## 6. No mocking — `testing`

**The rule.** Never replace a module or a global to make a test pass
(`vi.mock`, `jest.mock`, `vi.stubGlobal`). Inject the dependency at the caller
boundary instead.

**Why.** Module mocks swap code for everyone in the process, so tests start
depending on each other's order and flake. Needing one usually means a
dependency is hard-wired; passing it in makes the code easier to test *and*
easier to reuse. A spy handed to a function's own argument or a component's
prop replaces nothing shared — that's ordinary and fine. Fake timers are fine
too.

```ts
function createSync({ fetch }: { fetch: typeof globalThis.fetch }) { /* … */ }

test("retries once", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 }));
  const sync = createSync({ fetch });
  // …
});
```

Checks: `no-module-mock`.

---

## 7. Readable shapes — `style`

**The rule.**

- Write `function name() {}` rather than `const name = () => {}`, unless you
  need lexical `this`. Inline callbacks (`list.map((x) => …)`) are fine.
- Take at most three parameters; pass one typed object beyond that.
- Never use `Proxy`.
- Avoid `instanceof`; prefer a `type` field or a type guard.
- Don't use constructor parameter properties (`constructor(private db: Db)`);
  declare the field and assign it.

**Why.** Code is read far more than it's written. Function declarations hoist
and show up by name in stack traces. A typed object can't have its arguments
swapped by accident. `Proxy` makes ordinary property access do invisible work.
`instanceof` breaks across realms and duplicate package copies. Parameter
properties compile to code that bundlers handle poorly. Default to `const` and
`readonly`, and never spread a class instance (spread copies only own fields,
not getters).

```ts
type Greeting = { first: string; last: string; locale: string; formal: boolean };

function greet(g: Greeting): string {
  return g.formal ? `Dear ${g.first} ${g.last}` : `Hi ${g.first}`;
}

class Store {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }
}
```

Checks: `function-declaration`, `max-three-params`, `no-proxy`,
`avoid-instanceof`, `no-param-properties`.

---

## 8. Bound fetch — `fetch`

**The rule.** Never pass `fetch` around detached. When you default an
injectable fetch, bind it: `deps.fetch ?? fetch.bind(globalThis)`.

**Why.** In Cloudflare Workers (and some other runtimes) calling a detached
`fetch` throws `Illegal invocation`. Tests usually inject their own fetch, so
the fallback branch is the one path they never exercise — the bug only shows up
once deployed.

```ts
function createClient(deps: { fetch?: typeof globalThis.fetch }) {
  const doFetch = deps.fetch ?? fetch.bind(globalThis);
  return { get: (url: string) => doFetch(url) };
}
```

Checks: `bound-fetch`.

---

## Beyond the checks

When the reviewer's optional AI pass is on, it also reads added lines for the
spirit of these groups — things a line pattern can't see — and leaves those as
comments, never as blocking findings.
