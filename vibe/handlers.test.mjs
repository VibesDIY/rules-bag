import { test } from "node:test";
import assert from "node:assert/strict";
import { fetch as handle } from "./dist/backend.js";

const PATCH = ["@@ -0,0 +1,3 @@", "+try {", "+  x();", "+} catch (e) {}"].join("\n");

const CLEAN = ["@@ -0,0 +1,1 @@", "+export function ok() {}"].join("\n");
const BOT = { login: "vibes-diy[bot]", type: "Bot" };
const REVIEW_STATE = { REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };

function fakeCtx({ user, routes = [{ repo: "jchris/demo", binderHandle: "jchris" }], docs = {}, refuseReview = false, refuseDismiss = false, reviews = [] } = {}) {
  const calls = [];
  const logs = [];
  const db = {};
  for (const [id, d] of Object.entries(docs)) db["repos/" + id] = { ...d, _id: id, _rev: 1 };
  const ctx = {
    appInfo: { ownerHandle: "jchris", appSlug: "rules-bag-reviewer" },
    userInfo: user === undefined ? null : { userHandle: user },
    log(level, msg) {
      logs.push({ level, msg });
    },
    db: {
      async get(id, opts) {
        return db[opts.db + "/" + id] ?? null;
      },
      async put(doc, opts) {
        const key = opts.db + "/" + opts.id;
        const cur = db[key];
        if (opts.ifRev !== undefined && (cur === undefined ? null : cur._rev) !== opts.ifRev) {
          const e = new Error("conflict");
          e.code = "conflict";
          throw e;
        }
        const { _rev, ...rest } = doc;
        db[key] = { ...rest, _id: opts.id, _rev: (cur?._rev ?? 0) + 1 };
        return opts.id;
      },
    },
    github: {
      async fetch(path, init = {}) {
        calls.push({ path, method: init.method ?? "GET", body: init.body });
        const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
        if (/\/pulls\/7\/files/.test(path)) return ok([{ filename: "src/a.ts", status: "modified", patch: ctx.patch }]);
        const dismiss = /\/pulls\/7\/reviews\/(\d+)\/dismissals$/.exec(path);
        if (dismiss !== null) {
          if (refuseDismiss) return new Response("nope", { status: 422 });
          const r = reviews.find((x) => x.id === Number(dismiss[1]));
          r.state = "DISMISSED";
          return ok(r);
        }
        if (/\/pulls\/7\/reviews/.test(path)) {
          if ((init.method ?? "GET") === "GET") return ok(reviews);
          if (refuseReview) return new Response("nope", { status: 422 });
          const id = 100 + reviews.length;
          reviews.push({ id, user: BOT, state: REVIEW_STATE[init.body.event], body: init.body.body, commit_id: init.body.commit_id });
          return ok({ id, html_url: "https://github.com/jchris/demo/pull/7#pullrequestreview-" + id });
        }
        if (/\/pulls\/7$/.test(path)) return ok({ head: { sha: "abc1234def" }, html_url: "https://github.com/jchris/demo/pull/7" });
        return new Response("{}", { status: 404 });
      },
    },
    calls,
    logs,
    reviews,
    patch: PATCH,
    db_: db,
  };
  ctx.github.routes = async () => routes;
  return ctx;
}

function webhook(headers = {}, association = "OWNER", sha = "abc1234def") {
  return new Request("https://x/github-webhook", {
    method: "POST",
    headers: { "x-vibes-github-event": "pull_request", "x-vibes-github-delivery": "d1", ...headers },
    body: JSON.stringify({
      action: "opened",
      repository: { full_name: "jchris/demo" },
      pull_request: { number: 7, draft: false, head: { sha }, author_association: association, user: { login: "stranger" }, title: "t", html_url: "u" },
    }),
  });
}

test("webhook reviews a PR as the binder, requests changes, and writes the ledger", async () => {
  const ctx = fakeCtx({ user: "jchris" });
  const res = await handle(webhook(), ctx);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.event, "REQUEST_CHANGES");
  const post = ctx.calls.find((c) => c.method === "POST");
  assert.equal(post.body.commit_id, "abc1234def");
  assert.equal(post.body.comments[0].line, 1);
  const led = ctx.db_["reviews/review:jchris/demo#7@abc1234def"];
  assert.equal(led.status, "done");
  assert.equal(led.blocking, 1);
  assert.equal(led.binderHandle, "jchris");
  assert.match(led.reviewUrl, /pullrequestreview/);
});

test("a delivery with no binder identity is refused, not guessed", async () => {
  const res = await handle(webhook(), fakeCtx({}));
  assert.equal(res.status, 422);
});

test("a saved config turns a group off", async () => {
  const ctx = fakeCtx({ user: "jchris", docs: { "repo:jchris/demo": { binderHandle: "jchris", segments: { result: "off" } } } });
  const body = await (await handle(webhook(), ctx)).json();
  assert.equal(body.event, "COMMENT");
  assert.equal(body.findings, 0);
});

test("settings saved for a previous binder are ignored", async () => {
  const ctx = fakeCtx({ user: "alice", routes: [{ repo: "jchris/demo", binderHandle: "alice" }], docs: { "repo:jchris/demo": { binderHandle: "mallory", segments: { result: "off" } } } });
  const body = await (await handle(webhook(), ctx)).json();
  assert.equal(body.event, "REQUEST_CHANGES");
});

test("redelivery at the same SHA is skipped by the ledger claim", async () => {
  const ctx = fakeCtx({ user: "jchris" });
  await handle(webhook(), ctx);
  const again = await (await handle(webhook(), ctx)).json();
  assert.equal(again.skipped, "already-reviewed");
  assert.equal(ctx.calls.filter((c) => c.method === "POST").length, 1);
});

test("a refused review is recorded as failed and can be claimed again", async () => {
  const ctx = fakeCtx({ user: "jchris", refuseReview: true });
  const body = await (await handle(webhook(), ctx)).json();
  assert.equal(body.ok, false);
  assert.equal(ctx.db_["reviews/review:jchris/demo#7@abc1234def"].status, "failed");
  const retry = await (await handle(webhook(), ctx)).json();
  assert.notEqual(retry.skipped, "already-reviewed");
});

test("non-PR events and drafts are ignored", async () => {
  const ctx = fakeCtx();
  const r1 = await handle(new Request("https://x/github-webhook", { method: "POST", headers: { "x-vibes-github-event": "push" }, body: "{}" }), ctx);
  assert.equal((await r1.json()).ignored, "push");
});

test("config save: binder via routes(), the app owner and strangers refused", async () => {
  const save = (ctx) =>
    handle(new Request("https://x/config", { method: "POST", body: JSON.stringify({ repo: "jchris/demo", config: { segments: { style: "off" } } }) }), ctx);
  const owner = fakeCtx({ user: "jchris" });
  assert.equal((await save(owner)).status, 200);
  assert.equal(owner.db_["repos/repo:jchris/demo"].segments.style, "off");
  assert.equal(owner.db_["repos/repo:jchris/demo"].binderHandle, "jchris");

  const binder = fakeCtx({ user: "sam", routes: [{ repo: "jchris/demo", binderHandle: "sam" }] });
  assert.equal((await save(binder)).status, 200);
  assert.equal(binder.db_["repos/repo:jchris/demo"].binderHandle, "sam");

  const appOwner = fakeCtx({ user: "jchris", routes: [{ repo: "jchris/demo", binderHandle: "sam" }] });
  assert.equal((await save(appOwner)).status, 403);

  const stranger = fakeCtx({ user: "mallory", routes: [{ repo: "jchris/demo", binderHandle: "sam" }] });
  assert.equal((await save(stranger)).status, 403);

  const anon = fakeCtx({});
  assert.equal((await save(anon)).status, 403);
});

test("GET /repos lists only the caller's repos", async () => {
  const ctx = fakeCtx({ user: "sam", routes: [{ repo: "a/one", binderHandle: "sam" }, { repo: "b/two", binderHandle: "zed" }] });
  const body = await (await handle(new Request("https://x/repos"), ctx)).json();
  assert.deepEqual(body.repos.map((r) => r.repo), ["a/one"]);
  assert.equal((await handle(new Request("https://x/repos"), fakeCtx({}))).status, 401);
});

test("review-now runs for the binder", async () => {
  const ctx = fakeCtx({ user: "jchris" });
  const res = await handle(new Request("https://x/review", { method: "POST", body: JSON.stringify({ repo: "jchris/demo", number: 7 }) }), ctx);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.url, "https://github.com/jchris/demo/pull/7");
});

test("a thrown ctx.github refusal becomes a stated reason", async () => {
  const ctx = fakeCtx({ user: "jchris" });
  ctx.github.routes = async () => {
    const e = new Error("no repo");
    e.reason = "not_connected";
    throw e;
  };
  const res = await handle(new Request("https://x/repos"), ctx);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, "not_connected");
});

test("by default only the repo's team gets an automatic review; others wait in the ledger", async () => {
  const ctx = fakeCtx({ user: "jchris" });
  const body = await (await handle(webhook({}, "FIRST_TIME_CONTRIBUTOR"), ctx)).json();
  assert.equal(body.skipped, "outside-team");
  assert.equal(ctx.calls.filter((c) => c.method === "POST").length, 0);
  const led = ctx.db_["reviews/review:jchris/demo#7@abc1234def"];
  assert.equal(led.status, "waiting");
  assert.equal(led.author, "stranger");

  // One tap from the person who connected the repo reviews it anyway.
  const res = await handle(new Request("https://x/review", { method: "POST", body: JSON.stringify({ repo: "jchris/demo", number: 7 }) }), ctx);
  assert.equal((await res.json()).ok, true);
  assert.equal(ctx.db_["reviews/review:jchris/demo#7@abc1234def"].status, "done");
});

test("collaborators and members count as the team", async () => {
  for (const association of ["MEMBER", "COLLABORATOR"]) {
    const body = await (await handle(webhook({}, association), fakeCtx({ user: "jchris" }))).json();
    assert.equal(body.event, "REQUEST_CHANGES");
  }
});

test("who: anyone reviews every pull request automatically", async () => {
  const ctx = fakeCtx({ user: "jchris", docs: { "repo:jchris/demo": { binderHandle: "jchris", who: "anyone" } } });
  const body = await (await handle(webhook({}, "NONE"), ctx)).json();
  assert.equal(body.event, "REQUEST_CHANGES");
});

// Settle: once a head has nothing blocking, the reviewer's own earlier
// "request changes" stops holding the pull request — it is dismissed, and the
// new head gets a plain comment review. It never approves.
function dismissals(ctx) {
  return ctx.calls.filter((c) => c.method === "PUT" && /\/dismissals$/.test(c.path));
}

test("a clean head after a blocking head dismisses the reviewer's earlier request for changes", async () => {
  const otherVibe = { id: 1, user: BOT, state: "CHANGES_REQUESTED", body: "Reviewed by [Some Other Vibe](https://vibes.diy/vibe/alice/other?utm_source=github)" };
  const human = { id: 2, user: { login: "sam", type: "User" }, state: "CHANGES_REQUESTED", body: "please rename" };
  const ctx = fakeCtx({ user: "jchris", reviews: [otherVibe, human] });
  await handle(webhook({}, "OWNER", "aaaaaaa1111"), ctx);
  assert.equal(ctx.reviews[2].state, "CHANGES_REQUESTED");
  ctx.patch = CLEAN;
  const body = await (await handle(webhook({}, "OWNER", "bbbbbbb2222"), ctx)).json();
  assert.equal(body.event, "COMMENT");
  const put = dismissals(ctx);
  assert.equal(put.length, 1);
  assert.equal(put[0].path, `/repos/jchris/demo/pulls/7/reviews/${ctx.reviews[2].id}/dismissals`);
  assert.deepEqual(put[0].body, { message: "Resolved at bbbbbbb.", event: "DISMISS" });
  assert.equal(otherVibe.state, "CHANGES_REQUESTED");
  assert.equal(human.state, "CHANGES_REQUESTED");
  const events = ctx.calls.filter((c) => c.method === "POST").map((c) => c.body.event);
  assert.deepEqual(events, ["REQUEST_CHANGES", "COMMENT"]);
  assert.equal(events.includes("APPROVE"), false);
  assert.equal(ctx.db_["reviews/review:jchris/demo#7@aaaaaaa1111"].reviewId, ctx.reviews[2].id);
});

test("a head with only non-blocking findings also dismisses the earlier request for changes", async () => {
  const ctx = fakeCtx({ user: "jchris" });
  await handle(webhook({}, "OWNER", "aaaaaaa1111"), ctx);
  ctx.db_["repos/repo:jchris/demo"] = { binderHandle: "jchris", segments: { result: "note" }, _id: "repo:jchris/demo", _rev: 1 };
  const body = await (await handle(webhook({}, "OWNER", "bbbbbbb2222"), ctx)).json();
  assert.equal(body.event, "COMMENT");
  assert.ok(body.findings > 0);
  assert.equal(dismissals(ctx).length, 1);
  assert.equal(ctx.reviews[0].state, "DISMISSED");
});

test("a blocking head leaves the earlier request for changes in place", async () => {
  const ctx = fakeCtx({ user: "jchris" });
  await handle(webhook({}, "OWNER", "aaaaaaa1111"), ctx);
  const body = await (await handle(webhook({}, "OWNER", "bbbbbbb2222"), ctx)).json();
  assert.equal(body.event, "REQUEST_CHANGES");
  assert.equal(dismissals(ctx).length, 0);
  assert.equal(ctx.calls.filter((c) => c.method === "GET" && /\/reviews/.test(c.path)).length, 0);
});

test("a refused dismissal logs a warning and the review still posts", async () => {
  const ctx = fakeCtx({ user: "jchris", refuseDismiss: true });
  await handle(webhook({}, "OWNER", "aaaaaaa1111"), ctx);
  ctx.patch = CLEAN;
  const res = await handle(webhook({}, "OWNER", "bbbbbbb2222"), ctx);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.event, "COMMENT");
  assert.ok(ctx.logs.some((l) => l.level === "warn" && /dismiss/.test(l.msg)));
  assert.equal(ctx.db_["reviews/review:jchris/demo#7@bbbbbbb2222"].status, "done");
});
