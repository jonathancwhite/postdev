# Blast radius

PostDev can tell you, and your coding agents, how far a pull request could reach
if it is wrong. It puts each pull request in one of three buckets:

| Verdict | Meaning | Check conclusion |
|---|---|---|
| `auto` | Low blast radius. An agent may merge it once every other check is green. | success |
| `review` | Core code changed beyond the small-change limit. A person looks. | neutral |
| `human` | Touches high-risk code, or someone added the override label. A person always looks. | neutral |

The check never fails a build. A risky pull request is not a broken one, so CI
stays green and the verdict is read from the check itself.

It needs no model key and makes no model calls. It is deterministic: the same
diff and config always give the same verdict.

## Turn it on

Copy [`examples/blast-radius.yml`](../examples/blast-radius.yml) into your repo
at `.github/workflows/postdev-blast-radius.yml`:

```yaml
permissions:
  contents: read       # read the config and the checkout
  pull-requests: write # post the sticky comment
  checks: write        # write the "PostDev blast radius" check
  issues: write        # set the blast:* label

steps:
  - uses: actions/checkout@v4   # optional, enables fan-out (see below)
  - uses: jonathancwhite/postdev@v1
    with:
      blast-radius: true
      review: false             # or keep the AI review on and pass ANTHROPIC_API_KEY
```

Then add a `.github/postdev.json` with your repo's rules. Without one, PostDev uses
its built-in rules, and every file they don't recognise counts as core code.

## What it posts

Each run publishes the verdict three ways:

- **A check run** called `PostDev blast radius` on the head commit. Its title
  starts with the verdict word, e.g. `auto: low blast radius, safe to merge once CI is green`.
- **One sticky comment** with the reasons and every file grouped by tier. It is
  updated in place on each push.
- **A label:** `blast:auto`, `blast:review` or `blast:human`.

## How a pull request is judged

Every changed file gets a tier. A file takes the first tier that matches, in this order:

1. **High:** built-in high-risk paths, plus your `high` list.
2. **Low:** built-in docs, images, fonts and tests (`*.md`, `docs/**`, `*.png`, `*.test.*`, `__tests__/**` …).
3. **High, by keyword:** any other file whose name contains a risky word, such as auth, login,
   session, billing, payment, stripe, webhook, migrat, cron, worker or permission.
4. **Medium:** lockfiles, plus your `medium` list.
5. **Low:** your `low` list.
6. Otherwise `unmatched` (medium by default).

Two adjustments follow:

- **Fan-out:** a file the pull request edits or deletes lines in moves up one tier
  when many files import it. Low becomes medium above 15 direct importers, and
  medium becomes high above 25. Purely additive edits never bump, so adding a
  constant to a widely used file stays low.
- **Deletes and renames:** deleting a source file makes it at least medium, and a
  rename is judged on its old path as well as its new one.

Then the verdict:

- **`human`** if any file is high, or the pull request has the override label (`needs-human` by default).
- **`review`** if more than 6 medium files changed, or more than 150 lines across them.
- **`auto`** otherwise. That covers docs and UI of any size, and small core fixes.

The built-in high-risk paths are:

- CI and deploy config: `.github/**`, Dockerfiles, `docker-compose*`, `railway*`, `vercel.json`, `netlify.toml`, `fly.toml`, `Procfile`
- Dependencies and build config: every `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `tsconfig*.json`, `turbo.json`, `nx.json`
- Database: `*.sql`, `**/migrations/**`, `schema.prisma`
- Env files: `.env*`
- Agent instructions: `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.cursor/**`, `.cursorrules`

Agent instructions are high because they hold the merge rules. An agent that
could edit them and merge the change itself could loosen its own gate.

`.github/**` includes the PostDev config itself, so a pull request that changes
the rules always goes to a person.

## Config

`.github/postdev.json` (comments and trailing commas are fine):

```jsonc
{
  "blastRadius": {
    // Added to the built-in high-risk paths.
    "high": ["backend/src/middleware/**", "backend/src/services/billing*"],
    // Core code: counts toward the small-change limit.
    "medium": ["backend/**", "frontend/src/hooks/**"],
    // Safe at any size, unless fan-out bumps a file.
    "low": ["frontend/src/components/**", "frontend/src/pages/**"],

    "extraKeywords": ["payout"],                 // add to the keyword net
    "keywordIgnore": ["src/components/session-badge.tsx"], // names that only look risky
    // "keywords": false,                        // or turn the keyword net off

    "unmatched": "medium",          // tier for files no rule matches
    "overrideLabel": "needs-human", // a person adds this to force `human`
    "fanout": true,                 // count importers (needs actions/checkout)
    "limits": { "coreFiles": 6, "coreLines": 150, "fanoutMedium": 15, "fanoutHigh": 25 }
  }
}
```

The config is always read from the **base branch** at the pull request's base
commit, never from the pull request, so a pull request cannot loosen its own gate.

If the config can't be parsed, the verdict is `human` and the comment says why.

## Fan-out

With the repo checked out (`actions/checkout`), PostDev scans every JS/TS source
file as text and counts how many files import each one directly. It resolves:

- relative imports, including NodeNext-style `.js` specifiers that point at `.ts`
- tsconfig `paths` aliases such as `@/*`
- workspace packages imported by name, pointed at their `src/`

It never runs, bundles or installs your code.

On three real apps it matched dependency-cruiser's direct-importer counts on 469
of 470, 432 of 433 and all 33 comparable files. The only differences were CSS
imports, which PostDev ignores.

Without a checkout the path rules still run, and the comment notes that fan-out
was skipped.

## Letting an agent merge on the verdict

Put this in your agent instructions (`AGENTS.md`, `CLAUDE.md`):

> Before merging a pull request you opened, wait until every check on its head
> commit has finished. Merge only if all of them succeeded and the
> `PostDev blast radius` check's title starts with `auto:`. That check must be on
> the current head commit, and the pull request must not carry the `needs-human`
> label. Otherwise leave it open for a person and say why.

To read the verdict for the current head:

```sh
sha=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
gh api "repos/{owner}/{repo}/commits/$sha/check-runs?check_name=PostDev%20blast%20radius" \
  -q '.check_runs[0].output.title'
```

A missing check, or one on an older commit, means "not judged yet". Treat it as
`human`.

### Enforcing it on GitHub

On public repos, and on private repos with GitHub Pro or above, you can make the
`PostDev blast radius` check required in branch protection. On GitHub Free,
private repos have no branch protection, so the agent's own instructions are the
gate.
