import React, { useState, useEffect, useCallback } from "react";
import { apiFetch, buildGithubInstallUrl, useViewer } from "use-vibes";
import { useFireproof } from "use-fireproof";
import { Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Input, Skeleton } from "@vibes.diy/look";

const LEVEL_LABEL = { off: "Off", note: "Comment", block: "Request changes" };

const c = {
  page: "min-h-screen bg-background text-foreground p-4 md:p-8",
  wrap: "w-full max-w-3xl mx-auto space-y-6",
  hero: "space-y-3 py-6",
  h1: "text-3xl md:text-4xl font-bold tracking-tight",
  lede: "text-lg text-muted-foreground max-w-prose",
  row: "flex flex-wrap items-center gap-3",
  seg: "flex flex-col gap-2 py-3 border-b border-border last:border-b-0",
  segHead: "flex flex-wrap items-center justify-between gap-2",
  pills: "inline-flex rounded-md border border-border overflow-hidden",
  pill: "px-3 py-1.5 text-sm transition-colors",
  muted: "text-sm text-muted-foreground",
  pr: "flex flex-wrap items-center justify-between gap-2 py-2 border-b border-border last:border-b-0",
  select: "h-9 w-full sm:w-auto max-w-full rounded-md border border-input bg-background px-2 text-sm",
  repoRow:
    "w-full cursor-pointer flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  error: "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm",
};

function pillClass(active, level) {
  if (active === false) return c.pill + " bg-card hover:bg-muted";
  if (level === "block") return c.pill + " bg-destructive text-destructive-foreground";
  if (level === "note") return c.pill + " bg-accent text-accent-foreground";
  return c.pill + " bg-muted text-foreground";
}

async function readJson(res) {
  const text = await res.text();
  return text === "" ? {} : JSON.parse(text);
}

function SegmentRow({ id, seg, level, levels, onChange }) {
  return (
    <div className={c.seg}>
      <div className={c.segHead}>
        <span className="font-medium">{seg.title}</span>
        <div className={c.pills} role="group" aria-label={`${seg.title} level`}>
          {levels.map((l) => (
            <button key={l} type="button" className={pillClass(l === level, l)} aria-pressed={l === level} onClick={() => onChange(id, l)}>
              {LEVEL_LABEL[l]}
            </button>
          ))}
        </div>
      </div>
      <p className={c.muted}>{seg.blurb}</p>
    </div>
  );
}

function verdictBadge(r) {
  if (r.status === "waiting") return <Badge variant="outline">From {r.author !== "" ? `@${r.author}` : "outside the team"}</Badge>;
  if (r.status === "running") return <Badge variant="outline">Reviewing…</Badge>;
  if (r.status === "failed") return <Badge variant="destructive">{r.reason ?? "Didn't go through"}</Badge>;
  if (r.findings === 0) return <Badge variant="secondary">Clean</Badge>;
  const label = `${r.findings} finding${r.findings === 1 ? "" : "s"}${r.blocking > 0 ? `, ${r.blocking} blocking` : ""}`;
  return <Badge variant={r.blocking > 0 ? "destructive" : "secondary"}>{label}</Badge>;
}

function timeAgo(ms) {
  if (typeof ms !== "number") return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// "4 ask for changes · 3 comment · 1 off", most forceful first.
function rulesSummary(cfg) {
  const counts = { block: 0, note: 0, off: 0 };
  for (const level of Object.values(cfg.segments)) counts[level] = (counts[level] ?? 0) + 1;
  const parts = [];
  if (counts.block > 0) parts.push(`${counts.block} ask for changes`);
  if (counts.note > 0) parts.push(`${counts.note} comment`);
  if (counts.off > 0) parts.push(`${counts.off} off`);
  return parts.join(" · ");
}

function VerdictLink({ r }) {
  if (r.reviewUrl) {
    return (
      <a href={r.reviewUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {verdictBadge(r)}
      </a>
    );
  }
  return verdictBadge(r);
}

// The ledger: one record per pull request and head commit, written by the
// review itself, so everything below updates live as reviews land. One query
// covers every connected repo; the list and the feed each read from it.
function useReviews(repos) {
  const { useLiveQuery } = useFireproof("reviews");
  const { docs } = useLiveQuery("type", { key: "review" });
  const connected = new Set(repos.map((row) => row.repo.toLowerCase()));
  return [...docs].filter((r) => typeof r.repo === "string" && connected.has(r.repo.toLowerCase())).sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0));
}

function Exceptions({ reviews }) {
  const exceptions = reviews.slice(0, 12).flatMap((r) => (r.exceptions ?? []).map((e) => ({ ...e, number: r.number, url: r.url })));
  if (exceptions.length === 0) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">Exceptions asked for</h4>
      {exceptions.map((e) => (
        <p key={`${e.number}:${e.path}:${e.line}:${e.rule}`} className={c.muted}>
          <a className="underline" href={e.url} target="_blank" rel="noreferrer">
            #{e.number}
          </a>{" "}
          <code>{e.rule}</code> at{" "}
          <code>
            {e.path}:{e.line}
          </code>
          {e.reason ? ` — “${e.reason}”` : ""}
        </p>
      ))}
    </div>
  );
}

// One feed across every connected repo, newest first, plus "review a PR now"
// with a repo picker that follows whichever repo is open in the list above.
function RecentPulls({ repos, reviews, defaultRepo }) {
  const [pick, setPick] = useState(defaultRepo);
  const [number, setNumber] = useState("");
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const multi = repos.length > 1;

  useEffect(() => setPick(defaultRepo), [defaultRepo]);

  async function reviewNow(repo, n) {
    setRunning(true);
    setNote("");
    const res = await apiFetch("/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, number: Number(n) }),
    });
    const body = await readJson(res);
    setRunning(false);
    if (body.skipped === "already-reviewed") setNote(`${multi ? repo : ""}#${n} is already reviewed at its latest commit.`);
    else if (res.ok === false) setNote(body.reason ?? "The review didn't go through.");
  }

  const feed = reviews.slice(0, 20);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Recent pull requests</CardTitle>
        <CardDescription>{multi ? `Across all ${repos.length} repos, newest first.` : "Newest first."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={c.row}>
          {multi && (
            <select className={c.select} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Repo to review in">
              {repos.map((row) => (
                <option key={row.repo} value={row.repo}>
                  {row.repo}
                </option>
              ))}
            </select>
          )}
          <Input
            className="w-28"
            inputMode="numeric"
            placeholder="PR #"
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/[^0-9]/g, ""))}
            aria-label="Pull request number"
          />
          <Button variant="outline" disabled={number === "" || running} onClick={() => reviewNow(pick, number)}>
            {running ? "Reviewing…" : "Review it now"}
          </Button>
          {note !== "" && <span className={c.muted}>{note}</span>}
        </div>
        {feed.length === 0 ? (
          <p className={c.muted}>No reviews yet. Open a pull request and the review lands here and on GitHub.</p>
        ) : (
          <div>
            {feed.map((r) => (
              <div key={r._id} className={c.pr}>
                <div className="min-w-0 flex-1">
                  {multi && <div className="truncate text-xs text-muted-foreground">{r.repo}</div>}
                  <a href={r.url} target="_blank" rel="noreferrer" className="block truncate hover:underline">
                    #{r.number} {r.title} <span className={c.muted}>@{r.sha.slice(0, 7)}</span>
                  </a>
                </div>
                <span className={c.row}>
                  <span className="text-xs text-muted-foreground">{timeAgo(r.startedAt)}</span>
                  <VerdictLink r={r} />
                  {r.status === "waiting" && (
                    <Button size="sm" variant="ghost" disabled={running} onClick={() => reviewNow(r.repo, r.number)}>
                      Review it
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RepoSettings({ row, reviews, segments, levels, who, onSaved }) {
  const [cfg, setCfg] = useState(row.config);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(row.saved ? "" : "Using the default rules until you save.");
  const [ignoreText, setIgnoreText] = useState(row.config.ignore.join(", "));

  function setLevel(id, level) {
    setCfg((prev) => ({ ...prev, segments: { ...prev.segments, [id]: level } }));
    setMsg("");
  }

  async function save() {
    setSaving(true);
    const ignore = ignoreText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const res = await apiFetch("/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: row.repo, config: { ...cfg, ignore } }),
    });
    const body = await readJson(res);
    setSaving(false);
    setMsg(res.ok ? "Saved. The next pull request uses these rules." : (body.reason ?? "Couldn't save."));
    if (res.ok) onSaved();
  }

  return (
    <div className="space-y-4 border-t border-border bg-muted/20 px-4 py-4">
      <p className={c.muted}>Pick how hard each part of the rules bag pushes on this repo.</p>
      <div>
        {Object.entries(segments).map(([id, seg]) => (
          <SegmentRow key={id} id={id} seg={seg} level={cfg.segments[id]} levels={levels} onChange={setLevel} />
        ))}
      </div>
      <div className="space-y-2">
        <span className="text-sm font-medium">Review pull requests from</span>
        <div className={c.pills} role="group" aria-label="Whose pull requests get reviewed">
          {Object.entries(who).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={pillClass(cfg.who === id, "note")}
              aria-pressed={cfg.who === id}
              onClick={() => setCfg((p) => ({ ...p, who: id }))}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={c.muted}>
          {cfg.who === "team"
            ? "The repo's owner, org members and collaborators get a review on every push. Anyone else's pull request waits here for you to review with one tap."
            : "Every pull request gets a review on every push. Reviews run on your vibes.diy credits."}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={cfg.ai} onChange={(e) => setCfg((p) => ({ ...p, ai: e.target.checked }))} />
        Also ask AI about the rules a pattern can't see (comments only)
      </label>
      <div className="space-y-1">
        <span className="text-sm font-medium">Skip these paths</span>
        <Input value={ignoreText} onChange={(e) => setIgnoreText(e.target.value)} placeholder="**/dist/**, lab/**" aria-label="Paths to skip" />
      </div>
      <div className={c.row}>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save rules"}
        </Button>
        {msg !== "" && <span className={c.muted}>{msg}</span>}
      </div>
      <Exceptions reviews={reviews} />
    </div>
  );
}

// One compact row per repo: what its rules do, whose pull requests it reviews,
// and how its latest review came out. A row opens to that repo's settings;
// one open at a time, and a lone repo starts open.
function RepoRow({ row, latest, open, onToggle, children }) {
  const short = row.config.who === "anyone" ? "anyone" : "team";
  function onKey(e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  }
  return (
    <div className="border-b border-border last:border-b-0">
      <div role="button" tabIndex={0} aria-expanded={open} className={c.repoRow} onClick={onToggle} onKeyDown={onKey}>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="text-muted-foreground">
              {open ? "▾" : "▸"}
            </span>
            <a
              href={`https://github.com/${row.repo}`}
              target="_blank"
              rel="noreferrer"
              className="font-medium break-all hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.repo}
            </a>
            {row.saved === false && <Badge variant="outline">defaults</Badge>}
          </div>
          <p className={c.muted}>
            {rulesSummary(row.config)} · auto-reviews: {short}
          </p>
        </div>
        <div className="flex items-center gap-2 pl-6 sm:pl-0">
          {latest ? (
            <>
              <VerdictLink r={latest} />
              <span className="text-xs text-muted-foreground">{timeAgo(latest.startedAt)}</span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No reviews yet</span>
          )}
        </div>
      </div>
      {open && children}
    </div>
  );
}

function Dashboard({ repos, segments, levels, who, onSaved }) {
  const reviews = useReviews(repos);
  const [openRepo, setOpenRepo] = useState(repos.length === 1 ? repos[0].repo : "");

  useEffect(() => {
    if (repos.length === 1) setOpenRepo(repos[0].repo);
  }, [repos]);

  const byRepo = (repo) => reviews.filter((r) => r.repo.toLowerCase() === repo.toLowerCase());
  const defaultRepo = repos.some((row) => row.repo === openRepo) ? openRepo : repos[0].repo;

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="text-lg">{repos.length === 1 ? "Your repo" : "Your repos"}</CardTitle>
          <CardDescription>
            {repos.length === 1 ? "Rules and who gets an automatic review." : "Tap a repo to set its rules and who gets an automatic review."}
          </CardDescription>
        </CardHeader>
        <div className="border-t border-border">
          {repos.map((row) => {
            const mine = byRepo(row.repo);
            const open = openRepo === row.repo;
            return (
              <RepoRow key={row.repo} row={row} latest={mine[0]} open={open} onToggle={() => setOpenRepo(open ? "" : row.repo)}>
                <RepoSettings row={row} reviews={mine} segments={segments} levels={levels} who={who} onSaved={onSaved} />
              </RepoRow>
            );
          })}
        </div>
      </Card>
      <RecentPulls repos={repos} reviews={reviews} defaultRepo={defaultRepo} />
    </>
  );
}

// What a visitor gets, shown before they sign in: a review as it lands on a
// pull request, so the first screen is the product rather than a promise.
const EXAMPLE = [
  { line: 12, code: "  try {", rule: "Result, not throw", note: "Return a Result instead of try/catch, so the caller sees the failure in the type." },
  { line: 15, code: "    const u = new URL(raw.href);", rule: "Cement primitives", note: "Use cement's URI instead of new URL()." },
  { line: 18, code: "    if (!u) return undefined;", rule: "Explicit comparisons", note: "Say what you mean: compare to undefined or check the length." },
];

function ExampleReview() {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardDescription>On your pull request, a minute after you push</CardDescription>
        <CardTitle className="text-base">
          <span className="font-semibold">Rules bag</span> on <code className="text-sm">3f9c2ab</code>: 3 findings, 1 blocking
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {EXAMPLE.map((e) => (
          <div key={e.line} className="rounded-md border border-border">
            <div className="flex items-center gap-3 border-b border-border bg-muted px-3 py-1.5 font-mono text-xs">
              <span className="text-muted-foreground">src/load.ts:{e.line}</span>
              <span className="truncate">{e.code}</span>
            </div>
            <div className="space-y-1 px-3 py-2 text-sm">
              <Badge variant="outline">{e.rule}</Badge>
              <p>{e.note}</p>
            </div>
          </div>
        ))}
        <p className={c.muted}>
          Disagree with a rule on one line? Put <code>// rules-bag-allow: rule-id why</code> above it and the review lists the exception for a person to look
          at.
        </p>
      </CardContent>
    </Card>
  );
}

export default function App() {
  const { viewer, isViewerPending, requestLogin } = useViewer();
  const [state, setState] = useState({ loading: true, repos: [], segments: {}, levels: [], who: {}, error: "" });

  const load = useCallback(async () => {
    const res = await apiFetch("/repos");
    const body = await readJson(res);
    if (res.ok === false) {
      setState({ loading: false, repos: [], segments: {}, levels: [], who: {}, error: res.status === 401 ? "" : (body.reason ?? "couldn't load your repos") });
      return;
    }
    setState({ loading: false, repos: body.repos, segments: body.segments, levels: body.levels, who: body.who, error: "" });
  }, []);

  useEffect(() => {
    if (viewer) load();
    else setState((s) => ({ ...s, loading: false }));
  }, [viewer, load]);

  const connected = viewer ? state.repos.length : 0;

  return (
    <div className={c.page}>
      <div className={c.wrap}>
        <header className={c.hero}>
          <h1 className={c.h1}>Rules Bag Reviewer</h1>
          <p className={c.lede}>
            Connect a GitHub repo and every pull request gets a review against the{" "}
            <a className="underline" href="https://github.com/VibesDIY/rules-bag/blob/main/RULES.md" target="_blank" rel="noreferrer">
              rules bag
            </a>
            : Result over throw, cement primitives, honest types and readable shapes. You choose which rules comment and which ask for changes.
          </p>
          <div className={c.row}>
            {viewer ? (
              <a href={buildGithubInstallUrl()} target="_blank" rel="noopener">
                <Button size="lg">{connected > 0 ? "Add or remove repos" : "Connect a GitHub repo"}</Button>
              </a>
            ) : (
              <Button size="lg" disabled={isViewerPending} onClick={() => requestLogin()}>
                Sign in to connect a repo
              </Button>
            )}
            <span className={c.muted}>
              {connected > 0
                ? `${connected} repo${connected === 1 ? "" : "s"} connected. Tick or untick repos to change which ones this vibe reviews.`
                : "One click through GitHub; you pick the repos."}
            </span>
          </div>
        </header>

        {viewer === undefined || viewer === null ? <ExampleReview /> : null}

        {state.error !== "" && <div className={c.error}>{state.error}</div>}

        {viewer && state.loading && <Skeleton className="h-40 w-full" />}

        {viewer && state.loading === false && state.repos.length === 0 && state.error === "" && (
          <Card>
            <CardContent className="py-6 space-y-2">
              <p className="font-medium">No repos connected yet.</p>
              <p className={c.muted}>
                Press Connect, tick the repos this vibe should review, and choose the rules here. A disagreement with a rule is a comment away: put{" "}
                <code>// rules-bag-allow: rule-id why</code> above the line and the review lists it for a human.
              </p>
            </CardContent>
          </Card>
        )}

        {viewer && state.repos.length > 0 && <Dashboard repos={state.repos} segments={state.segments} levels={state.levels} who={state.who} onSaved={load} />}
      </div>
    </div>
  );
}
