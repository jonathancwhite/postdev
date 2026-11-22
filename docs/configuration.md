# Configuration

PostDev runs as a GitHub Action. You configure it with `with:` inputs in your
workflow file, and either a keyless sign-in or one secret. It does two jobs, each switched on with an input:
the AI review (`review`, on by default) and the blast-radius check
(`blast-radius`, off by default). This page explains every setting — the
`action.yml` input descriptions link straight here.

To get started, copy [`examples/pull-request-review.yml`](../examples/pull-request-review.yml)
into your repository at `.github/workflows/postdev.yml`.

## Signing in to Anthropic

The review needs to call the Anthropic API. Pick one:

- **Keyless (recommended):** GitHub vouches for the run, and Anthropic trades
  that for a short-lived token. Nothing secret is stored in the repository.
- **An API key:** a repository secret, as below.

If both are set up, keyless wins.

### Keyless sign-in with GitHub OIDC

1. In the Claude Console, open **Workload identity → Connect workload →
   GitHub Actions**. Create one rule per repository:
   - **GitHub organization:** the account that owns the repo.
   - **Repository:** the repo's name.
   - **Subject:** `repo:<owner>/<repo>:pull_request`. Don't add a branch
     match such as `refs/heads/main`: pull request runs carry the
     `pull_request` subject, not a branch, so they wouldn't match.
   - **Audience:** `https://api.anthropic.com`.
   - **Scope:** `workspace:inference` is enough for the review.
2. Copy the rule ID (`fdrl_...`) and your organization ID. Neither is a secret.
3. Give the job `id-token: write` and pass the IDs as inputs:

```yaml
permissions:
  contents: read
  pull-requests: write
  id-token: write # lets GitHub issue the run's OIDC token

steps:
  - uses: jonathancwhite/postdev@v1
    with:
      anthropic-federation-rule-id: fdrl_...
      anthropic-organization-id: 00000000-0000-0000-0000-000000000000
```

Pull requests from forks get no OIDC token, so the review skips them with a
clear error rather than running with someone else's code.

| Input | Needed | What it is |
| --- | --- | --- |
| `anthropic-federation-rule-id` | yes | The rule's `fdrl_...` ID. |
| `anthropic-organization-id` | yes | Your organization's UUID. |
| `anthropic-workspace-id` | if the rule covers several workspaces | `wrkspc_...` |
| `anthropic-service-account-id` | no | `svac_...`; must be the rule's account if set. |
| `anthropic-oidc-audience` | no | Defaults to `https://api.anthropic.com`; must match the rule. |

If sign-in fails, the Console's authentication history shows why a token
request was turned down.

### `ANTHROPIC_API_KEY`

Your Anthropic API key, if you don't use keyless sign-in. This is a **secret, not an input** — pass it through
`env` from a repository secret so it is never written into a workflow file or
committed:

```yaml
- uses: jonathancwhite/postdev@v1
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Add the secret under **Settings → Secrets and variables → Actions**. You bring
your own key and pay only for your own usage.

## `github-token`

The token PostDev uses to read the diff and post the review. Defaults to the
built-in `GITHUB_TOKEN`, which is enough for a repo in your own account or org.
You rarely need to set this. The job must grant it `pull-requests: write`:

```yaml
permissions:
  contents: read
  pull-requests: write
```

## `model`

The review model. **Defaults to `claude-sonnet-5-5`** — a strong reviewer that
keeps costs low on a busy repo. For the strongest reviews, set it to
`claude-opus-5-5`:

```yaml
with:
  model: claude-opus-5-5
```

Any Anthropic model id works. The engine is provider-neutral, so other providers
can be added over time — today the shipped model client is Anthropic.

## `fallback-model`

The model tried once if the primary is unavailable. Defaults to
`claude-sonnet-5`, so an outage of the primary is covered by a different model. Leave it unless you have a reason to change it.

## `min-severity`

The lowest severity worth posting: `low`, `medium`, `high`, or `critical`.
Findings below it are skipped. **Defaults to `medium`**, so only `low` findings
are held back. Turn it up to `high` for a quieter bot, or down to `low` to see
everything:

```yaml
with:
  min-severity: high
```

## `bot-login`

The account the review posts under. PostDev reads its own past comments to avoid
repeating a note across pushes, so this must match whoever posts. Defaults to
`github-actions[bot]`, which is correct when you use the built-in `GITHUB_TOKEN`.
Change it only if you post with a different identity (for example a personal
access token belonging to a bot account).

## `review`

Run the AI review. **Defaults to `true`.** Set `false` to run only the
blast-radius check, which needs no model key:

```yaml
with:
  review: false
  blast-radius: true
```

## `blast-radius`

Work out the pull request's blast radius and post it as the
`PostDev blast radius` check, a sticky comment and a `blast:*` label.
**Defaults to `false`.** The job needs `checks: write` and `issues: write` as
well as `pull-requests: write`. See the [blast-radius guide](blast-radius.md).

## `config`

Path of the PostDev config file. **Defaults to `.github/postdev.json`.** It is read
from the base branch, so a pull request cannot change the rules it is judged by.
See the [blast-radius guide](blast-radius.md#config).

## `blast-radius-labels`

Set a `blast:auto`, `blast:review` or `blast:human` label on the pull request.
**Defaults to `true`.** Set `false` if you don't want labels or can't grant
`issues: write`.

## Output: `blast-radius-verdict`

`auto`, `review` or `human`, when the blast-radius check ran. Use it in a later
step, for example `${{ steps.postdev.outputs.blast-radius-verdict }}`.
