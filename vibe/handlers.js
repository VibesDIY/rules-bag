// ── Handlers ────────────────────────────────────────────────────────────────
// Rules Bag Reviewer — reviews every pull request on a connected GitHub repo
// against the rules bag (RULES.md at the repo root), with the rule groups each
// repo turns on.
//
// Lanes used (all platform-provided, no tokens in this file):
//   ctx.github.fetch  — the vibes.diy GitHub App's installation, pinned to the
//                       repos bound to THIS vibe
//   POST /github-webhook — platform-verified deliveries for those repos
//   ctx.github.routes() — who connected which repo
// A delivery runs as the person who connected the repo, so its writes (the
// review ledger) pass access.js as them and land in their channel.

export const config = {
  github: {
    bind: "anyone",
    why: "Reviews each pull request in the repos you pick against the rules bag, and comments on the lines that break a rule you turned on.",
  },
};

const REVIEW_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status ?? 200, headers: { "content-type": "application/json" } });
}

function configId(repo) {
  return "repo:" + repo.toLowerCase();
}

function appUrl(ctx) {
  return `https://vibes.diy/vibe/${ctx.appInfo.ownerHandle}/${ctx.appInfo.appSlug}`;
}

// Repos connected to this vibe, with the handle of whoever connected each.
async function boundRepos(ctx) {
  const routes = await ctx.github.routes();
  return routes.map((r) => ({ repo: r.repo, binderHandle: r.binderHandle }));
}

// Only the person who connected a repo sets its rules or runs its reviews.
function mayConfigure(ctx, bound) {
  const me = ctx.userInfo?.userHandle;
  return me !== undefined && bound.binderHandle === me;
}

async function readConfig(ctx, repo) {
  const doc = await ctx.db.get(configId(repo), { db: "repos" });
  return doc;
}

async function listFiles(ctx, repo, number) {
  const files = [];
  for (let page = 1; page <= 3; page++) {
    const res = await ctx.github.fetch(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    if (res.ok === false) return { ok: false, status: res.status };
    const batch = await res.json();
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return { ok: true, files };
}

function ledgerId(repo, number, sha) {
  return `review:${repo.toLowerCase()}#${number}@${sha}`;
}

// Claim the (repo, PR, head SHA) before posting: exactly one delivery wins, a
// redelivery or a second click conflicts and steps aside. A failed run can be
// claimed again.
async function claim(ctx, { repo, number, sha, title, url, binderHandle }) {
  const id = ledgerId(repo, number, sha);
  const prior = await ctx.db.get(id, { db: "reviews" });
  if (prior !== null && prior.status !== "failed" && prior.status !== "waiting") return { won: false, doc: prior };
  const doc = { type: "review", repo, number, sha, title, url, status: "running", startedAt: Date.now(), binderHandle };
  const put = await ctx.db.put(doc, { db: "reviews", id, ifRev: prior === null ? null : prior._rev }).catch((err) => {
    if (err?.code === "conflict") return undefined;
    throw err;
  });
  if (put === undefined) return { won: false, doc: prior };
  return { won: true, id, doc: await ctx.db.get(id, { db: "reviews" }) };
}

async function finish(ctx, claimed, fields) {
  await ctx.db.put({ ...claimed.doc, ...fields, finishedAt: Date.now() }, { db: "reviews", id: claimed.id, ifRev: claimed.doc._rev });
}

// The optional AI pass: rules a line pattern can't see. Same output shape as
// the engine, restricted to added lines so a comment always lands on the diff.
async function aiFindings(ctx, files, cfg) {
  const enabled = Object.keys(SEGMENTS).filter((k) => cfg.segments[k] !== "off");
  if (enabled.length === 0) return [];
  const chunks = [];
  const valid = new Set();
  let budget = 400;
  for (const f of files) {
    if (budget <= 0) break;
    if (CODE_EXT.test(f.filename) === false) continue;
    const lines = addedLines(f.patch).slice(0, budget);
    budget -= lines.length;
    if (lines.length === 0) continue;
    for (const l of lines) valid.add(f.filename + ":" + l.line);
    chunks.push(`### ${f.filename}\n` + lines.map((l) => `${l.line}: ${l.text}`).join("\n"));
  }
  if (chunks.length === 0) return [];
  const rules = enabled.map((k) => `- ${k}: ${SEGMENTS[k].prose}`).join("\n");
  const prompt =
    "You review added lines of a pull request against these coding rules, one group per line:\n" +
    rules +
    "\n\nReport only clear violations in the lines shown, at most 15, citing the exact file and line number given. Skip anything a simple pattern would already catch (try/catch, throw, new URL, any, export default, if (!x)). Return an empty list when nothing is clearly wrong.\n\n" +
    chunks.join("\n\n");
  const raw = await ctx.callAI(prompt, {
    max_tokens: 1500,
    schema: {
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              line: { type: "number" },
              segment: { type: "string", enum: enabled },
              message: { type: "string" },
            },
          },
        },
      },
    },
  });
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed.findings) ? parsed.findings : [];
  return list
    .filter((f) => valid.has(f.path + ":" + f.line) && enabled.includes(f.segment))
    .slice(0, 15)
    .map((f) => ({ path: f.path, line: f.line, rule: "ai-" + f.segment, segment: f.segment, level: "note", message: String(f.message).slice(0, 400) }));
}

// Settle a pull request once a head has nothing blocking: GitHub keeps an
// earlier REQUEST_CHANGES in force until it is dismissed, so a plain comment
// review on a clean head would leave the pull request held. Dismiss only the
// reviews THIS vibe posted — the GitHub App is shared by many vibes, so a
// review counts as ours when it comes from the App's bot user and carries this
// vibe's own link in its footer. Never approve. A failure here is logged and
// the review goes on.
async function dismissOwnRequests(ctx, { repo, number, sha }) {
  const res = await ctx.github.fetch(`/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  if (res.ok === false) {
    ctx.log("warn", "could not list reviews to dismiss", { repo, number, status: res.status });
    return;
  }
  const reviews = await res.json();
  const marker = appUrl(ctx) + "?";
  const ours = (Array.isArray(reviews) ? reviews : []).filter(
    (r) =>
      r.state === "CHANGES_REQUESTED" &&
      r.user?.type === "Bot" &&
      typeof r.user?.login === "string" &&
      r.user.login.endsWith("[bot]") &&
      typeof r.body === "string" &&
      r.body.includes(marker)
  );
  for (const r of ours) {
    const put = await ctx.github.fetch(`/repos/${repo}/pulls/${number}/reviews/${r.id}/dismissals`, {
      method: "PUT",
      body: { message: `Resolved at ${sha.slice(0, 7)}.`, event: "DISMISS" },
    });
    if (put.ok === false) ctx.log("warn", "could not dismiss an earlier review", { repo, number, review: r.id, status: put.status });
  }
}

// Review one pull request at one head SHA, as the person who connected the
// repo. Returns a small outcome record the caller logs or hands to the page.
export async function reviewPull(ctx, { repo, number, sha, title, url, binderHandle }) {
  const stored = await readConfig(ctx, repo);
  // Settings count only when they were saved for this repo's current binder.
  const cfg = normalizeConfig(stored !== null && stored.binderHandle === binderHandle ? stored : undefined);
  const claimed = await claim(ctx, { repo, number, sha, title, url, binderHandle });
  if (claimed.won === false) return { ok: true, skipped: "already-reviewed" };
  const listed = await listFiles(ctx, repo, number);
  if (listed.ok === false) {
    const reason = `could not read the pull request files (GitHub ${listed.status})`;
    await finish(ctx, claimed, { status: "failed", reason });
    return { ok: false, reason };
  }
  const result = reviewFiles(listed.files, cfg);
  if (cfg.ai) {
    const extra = await aiFindings(ctx, listed.files, cfg).catch((err) => {
      ctx.log("warn", "ai pass failed", { message: String(err?.message ?? err) });
      return [];
    });
    const seen = new Set(result.findings.map((f) => `${f.path}:${f.line}:${f.segment}`));
    for (const f of extra) if (seen.has(`${f.path}:${f.line}:${f.segment}`) === false) result.findings.push(f);
  }
  const summary = summarize({ findings: result.findings, exceptions: result.exceptions, sha, repo, appUrl: appUrl(ctx) });
  const comments = reviewComments(result.findings);
  if (summary.event !== "REQUEST_CHANGES") {
    await dismissOwnRequests(ctx, { repo, number, sha }).catch((err) => {
      ctx.log("warn", "dismissing earlier reviews failed", { repo, number, message: String(err?.message ?? err) });
    });
  }
  const res = await ctx.github.fetch(`/repos/${repo}/pulls/${number}/reviews`, {
    method: "POST",
    body: { commit_id: sha, event: summary.event, body: summary.body, comments },
  });
  if (res.ok === false) {
    const detail = (await res.text()).slice(0, 300);
    ctx.log("warn", "review refused", { repo, number, status: res.status, detail });
    const reason = `GitHub refused the review (${res.status})`;
    await finish(ctx, claimed, { status: "failed", reason });
    return { ok: false, reason };
  }
  const posted = await res.json();
  const bySegment = {};
  for (const f of result.findings) bySegment[f.segment] = (bySegment[f.segment] ?? 0) + 1;
  await finish(ctx, claimed, {
    status: "done",
    event: summary.event,
    findings: result.findings.length,
    blocking: result.findings.filter((f) => f.level === "block").length,
    bySegment,
    exceptions: result.exceptions,
    reviewId: posted.id,
    reviewUrl: posted.html_url,
  });
  return { ok: true, event: summary.event, findings: result.findings.length, exceptions: result.exceptions.length };
}

async function noteWaiting(ctx, { repo, pr, association, binderHandle }) {
  const id = ledgerId(repo, pr.number, pr.head.sha);
  const doc = {
    type: "review",
    repo,
    number: pr.number,
    sha: pr.head.sha,
    title: pr.title,
    url: pr.html_url,
    status: "waiting",
    author: pr.user?.login ?? "",
    association,
    startedAt: Date.now(),
    binderHandle,
  };
  await ctx.db.put(doc, { db: "reviews", id, ifRev: null }).catch((err) => {
    if (err?.code === "conflict") return undefined; // already recorded or reviewed
    throw err;
  });
}

async function handleWebhook(request, ctx) {
  const event = request.headers.get("x-vibes-github-event");
  if (event === "ping") return json({ ok: true, pong: true });
  if (event !== "pull_request") return json({ ok: true, ignored: event });
  const payload = await request.json();
  const pr = payload.pull_request;
  if (REVIEW_ACTIONS.includes(payload.action) === false || pr === undefined) return json({ ok: true, ignored: payload.action });
  if (pr.draft === true) return json({ ok: true, ignored: "draft" });
  const repo = payload.repository?.full_name;
  if (typeof repo !== "string" || REPO_RE.test(repo) === false) return json({ ok: false, reason: "no repository in delivery" }, 400);
  // The platform delivers as the person who connected the repo.
  const binderHandle = ctx.userInfo?.userHandle;
  if (binderHandle === undefined) return json({ ok: false, reason: "delivery arrived without the person who connected the repo" }, 422);
  const stored = await readConfig(ctx, repo);
  const cfg = normalizeConfig(stored !== null && stored.binderHandle === binderHandle ? stored : undefined);
  const association = typeof pr.author_association === "string" ? pr.author_association : "NONE";
  if (authorInScope(association, cfg.who) === false) {
    // Outside the setting: post nothing, keep a record so the person who
    // connected the repo can see it and review it with one tap.
    await noteWaiting(ctx, { repo, pr, association, binderHandle });
    return json({ ok: true, skipped: "outside-team", association });
  }
  ctx.log("info", "reviewing", { repo, number: pr.number, sha: pr.head.sha, delivery: request.headers.get("x-vibes-github-delivery") });
  const outcome = await reviewPull(ctx, { repo, number: pr.number, sha: pr.head.sha, title: pr.title, url: pr.html_url, binderHandle });
  ctx.log(outcome.ok ? "info" : "warn", "review outcome", { repo, number: pr.number, ...outcome });
  // A refusal from GitHub is a 4xx-shaped end: redelivering won't change it.
  return json(outcome, outcome.ok ? 200 : 422);
}

async function handleRepos(ctx) {
  const me = ctx.userInfo?.userHandle;
  if (me === undefined) return json({ ok: false, reason: "sign in to see your repos" }, 401);
  const bound = await boundRepos(ctx);
  const mine = bound.filter((b) => mayConfigure(ctx, b));
  const rows = [];
  for (const b of mine) {
    const stored = await readConfig(ctx, b.repo);
    rows.push({ repo: b.repo, binderHandle: b.binderHandle, config: normalizeConfig(stored ?? undefined), saved: stored !== null });
  }
  return json({ ok: true, repos: rows, segments: SEGMENTS, levels: LEVELS, who: WHO });
}

async function findBound(ctx, repo) {
  const bound = await boundRepos(ctx);
  return bound.find((b) => b.repo.toLowerCase() === repo.toLowerCase());
}

async function handleSaveConfig(request, ctx) {
  const input = await request.json();
  const repo = typeof input.repo === "string" ? input.repo : "";
  if (REPO_RE.test(repo) === false) return json({ ok: false, reason: "pick a repo" }, 400);
  const bound = await findBound(ctx, repo);
  if (bound === undefined) return json({ ok: false, reason: "that repo isn't connected to this app" }, 404);
  if (mayConfigure(ctx, bound) === false) return json({ ok: false, reason: "only the person who connected this repo can change its rules" }, 403);
  const cfg = normalizeConfig(input.config);
  const existing = await readConfig(ctx, repo);
  await ctx.db.put(
    { type: "repo-config", repo: bound.repo, binderHandle: bound.binderHandle, ...cfg, updatedBy: ctx.userInfo.userHandle, updatedAt: Date.now() },
    { db: "repos", id: configId(repo), ifRev: existing === null ? null : existing._rev }
  );
  return json({ ok: true, config: cfg });
}

async function handleReviewNow(request, ctx) {
  const input = await request.json();
  const repo = typeof input.repo === "string" ? input.repo : "";
  const number = Number(input.number);
  if (REPO_RE.test(repo) === false || Number.isInteger(number) === false || number < 1) return json({ ok: false, reason: "pick a repo and a pull request number" }, 400);
  const bound = await findBound(ctx, repo);
  if (bound === undefined) return json({ ok: false, reason: "that repo isn't connected to this app" }, 404);
  if (mayConfigure(ctx, bound) === false) return json({ ok: false, reason: "only the person who connected this repo can run a review" }, 403);
  const prRes = await ctx.github.fetch(`/repos/${bound.repo}/pulls/${number}`);
  if (prRes.ok === false) return json({ ok: false, reason: `couldn't open pull request #${number} (GitHub ${prRes.status})` }, 404);
  const pr = await prRes.json();
  const outcome = await reviewPull(ctx, { repo: bound.repo, number, sha: pr.head.sha, title: pr.title, url: pr.html_url, binderHandle: bound.binderHandle });
  return json({ ...outcome, url: pr.html_url }, outcome.ok ? 200 : 502);
}

export async function fetch(request, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const route = `${request.method} ${path}`;
  const run = async () => {
    switch (true) {
      case route === "POST /github-webhook":
        return handleWebhook(request, ctx);
      case route === "GET /repos":
        return handleRepos(ctx);
      case route === "POST /config":
        return handleSaveConfig(request, ctx);
      case route === "POST /review":
        return handleReviewNow(request, ctx);
      default:
        return json({ ok: false, reason: "not found" }, 404);
    }
  };
  return run().catch((err) => {
    const reason = err?.reason ?? err?.code ?? "error";
    ctx.log("error", "route failed", { route, reason, message: String(err?.message ?? err) });
    const status = reason === "not_connected" ? 409 : 500;
    return json({ ok: false, reason, message: String(err?.message ?? err).slice(0, 200) }, status);
  });
}
