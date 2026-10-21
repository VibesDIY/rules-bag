# The vibe — `jchris/rules-bag-reviewer`

This directory is the source of the Rules Bag Reviewer vibe on vibes.diy. On
every pull request in a connected repo it reviews the added lines against the
[rules bag](../RULES.md) and posts one GitHub review per head commit, with line
comments. Each repo picks a level for each rule group (off / comment / request
changes) on the vibe's own screen, and **whose pull requests get an automatic
review**: the repo's team (owner, org members, collaborators — GitHub's
`author_association`), the default, or anyone. A review runs as the person who
connected the repo, on their credits, so a pull request from outside the team
waits on the vibe's screen for a one-tap review instead.

When a new head has nothing blocking, the reviewer dismisses its own earlier
"request changes" reviews on that pull request ("Resolved at `<sha>`.") and
posts a comment review. It never approves — approval stays with people.

## Build, test, push

The platform stores the deployed copy of a vibe. This directory keeps what the
platform doesn't: the build step, the tests, and the reasons behind the code.
`backend.js` cannot import a sibling file, so `build.mjs` concatenates
`engine.js` + `handlers.js` into `dist/backend.js`. Push from `dist/`.

```sh
node build.mjs                                     # handlers.test.mjs imports dist/backend.js
node --test engine.test.mjs handlers.test.mjs      # no dependencies
cd dist && npx vibes-diy push --vibe jchris/rules-bag-reviewer
node real-diff.mjs ../path/to/a/repo HEAD~40..HEAD 20   # engine over a real git range
```

To run your own copy, remix the vibe on vibes.diy and push to your own slug
(`--vibe <your-handle>/<your-slug>`).

## Shape

| file | what it holds |
| --- | --- |
| `engine.js` | Pure rules engine: the eight groups (`result`, `cement`, `types`, `modules`, `falsy`, `testing`, `style`, `fetch`), diff → added-line mapping, a comment/string blanker, `// rules-bag-allow: <rule> <why>` exception requests, and the review summary and comments |
| `handlers.js` | `POST /github-webhook` (pull_request opened/synchronize/reopened/ready_for_review), `GET /repos`, `POST /config`, `POST /review` (review a PR number now) |
| `access.js` | Settings and review records are written only by `backend.js`. Each lands in the channel of the person who connected that repo |
| `App.jsx` | Connect a repo → per-repo rule levels → live review ledger and any exceptions asked for |

## What it uses from the platform

- `config.github.bind: "anyone"`, so any visitor can connect *their* repo
  through the vibes.diy GitHub App
- `ctx.github.fetch`: the App's installation, limited to the repos connected
  to this vibe
- `ctx.github.routes()`: who connected which repo
- deliveries that run as the person who connected the repo, so the review can
  write its ledger record
