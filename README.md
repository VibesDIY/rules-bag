# Rules Bag Reviewer

A friendly second reviewer for every pull request: it reads the lines you
added, checks them against the [rules bag](RULES.md), and leaves line comments
a minute after you push.

## What a review looks like

> **Rules bag** on `3f9c2ab`: 3 findings, 1 blocking.
>
> **`src/load.ts:12`** &nbsp; `try {`
> 🔴 **Result, not throw** — Return a Result instead of try/catch, so the caller sees the failure in the type.
>
> **`src/load.ts:15`** &nbsp; `const u = new URL(raw.href);`
> 🟡 **Cement primitives** — Use cement's URI instead of new URL().
>
> **`src/load.ts:18`** &nbsp; `if (!u) return undefined;`
> 🟡 **Explicit comparisons** — Say what you mean: compare to undefined or check the length.
>
> <sub>Disagree with a rule on one line? Put `// rules-bag-allow: rule-id why` above it and the review lists the exception for a person to look at.</sub>

## Add it to your repo

**[Open Rules Bag Reviewer on vibes.diy →](https://vibes.diy/vibe/jchris/rules-bag-reviewer?utm_source=github&utm_medium=readme&utm_campaign=rules-bag-reviewer)**

Sign in, press **Connect a GitHub repo**, approve the vibes.diy GitHub App,
and tick the repos this vibe should review. Then choose your rules. That's it —
the next pull request gets a review.

## How it works

- **A GitHub App does the posting.** Connecting goes through the vibes.diy
  GitHub App, and you choose exactly which repos it can see.
- **You pick the repos.** Each connection belongs to this vibe, and you can
  connect any repo you can write to. Press **Add or remove repos** any time to
tick or untick them; other vibes on the same repo are unaffected.
- **You set the strength of each rule group.** For each of the eight groups,
  choose **off**, **comment** (a 🟡 note), or **request changes** (🔴, the
  pull request waits on a fix).
- **You choose whose pull requests get an automatic review.** By default it's
  the repo's team — the owner, org members and collaborators. Switch to
  "anyone" to cover outside contributors too; otherwise their pull requests
  wait on the vibe's page for a one-tap review.
- **One review per commit.** Each new head commit gets a fresh review. When a
  commit clears every blocking finding, the reviewer dismisses its own earlier
  "request changes" and leaves a comment. It never approves — that stays with
  people.
- **Exceptions are a comment away.** Put
  `// rules-bag-allow: <rule> <why>` on the line or the line above. The
  finding becomes an exception request, listed in the review for a person to
  decide on.

## The rules

[RULES.md](RULES.md) covers the eight groups the reviewer checks — result,
cement, types, modules, falsy, testing, style and fetch — each with the rule,
the reason, and a short example of the good shape.

## Remix it on vibes.diy

The reviewer is a vibe, and its whole source lives in [`vibe/`](vibe/): the
rules engine, the webhook handlers, the settings screen, and the tests. Remix
it on vibes.diy to make it yours — change the rules, add your own groups, or
point it at a different style guide. See [vibe/README.md](vibe/README.md) to
build, test and push.

## License

[Apache-2.0](LICENSE)
