# PostDev

AI code review for your pull requests, run as a GitHub Action. You bring your own
model key. When a pull request opens or gets a push, PostDev reviews the change
and posts its findings before a human looks — inline where it can, a short
summary otherwise. Push a fix and it won't repeat a note it already made.

## Quick start

1. Add your Anthropic key as a repository secret named `ANTHROPIC_API_KEY`
   (**Settings → Secrets and variables → Actions**).
2. Copy [`examples/pull-request-review.yml`](examples/pull-request-review.yml)
   into your repo at `.github/workflows/postdev.yml`.
3. Open a pull request.

```yaml
- uses: jonathancwhite/postdev@v1
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    model: claude-sonnet-5
    min-severity: medium
```

Every input is explained in the [configuration guide](docs/configuration.md).
The key is passed through `env` from a secret, so it never lands in a workflow
file.

## Blast radius: which pull requests can merge themselves

PostDev can also judge how far a pull request could reach if it is wrong, so
coding agents can merge their own low-risk changes and leave the rest for a person.
It needs no model key and posts a `PostDev blast radius` check, a sticky comment
and a label:

- **`auto`:** docs, copy, UI and small core fixes. Safe to merge once CI is green.
- **`review`:** a larger core change.
- **`human`:** migrations, auth, billing, background jobs, deploy config or
  dependencies, or a file the whole app imports.

```yaml
- uses: actions/checkout@v4
- uses: jonathancwhite/postdev@v1
  with:
    blast-radius: true
    review: false   # keep true to also get the AI review
```

Rules live in `.github/postdev.json` on your base branch. See the
[blast-radius guide](docs/blast-radius.md) for the rules, the config and the
agent instructions.

## Cost

PostDev defaults to `claude-sonnet-5` — a strong reviewer that keeps the bill
small on a busy repo. Set `model: claude-opus-4-8` for the strongest reviews, or
raise `min-severity` for a quieter bot. You pay only for your own key's usage.

## How it fits together

One review engine sits behind the Action:

- `src/action/` — the Action front door. It reads what to review from the event,
  builds the engine's collaborators from the workflow inputs and the built-in
  token, and calls the engine.
- `src/review/runReview.ts` — **the seam**. Its collaborators — the GitHub
  client, the review model, and the dedupe store — are injected, so tests drive
  it with fakes and assert on what it posts.
- `src/model/reviewModel.ts` — the provider-neutral review-model interface and
  the Anthropic client behind it. Other providers can be added as new
  implementations of the same interface.
- `src/store/postedFindingsStore.ts` — cross-push dedupe with no database: it
  rebuilds what it already posted from the bot's own prior comments.
- `src/github/client.ts` — the narrow slice of GitHub the bot needs.
- `src/blastRadius/` — the blast-radius check: path rules and fan-out
  (`rules.ts`), the import counter (`importGraph.ts`), and its own seam
  (`runBlastRadius.ts`) with an injected GitHub slice, tested the same way.

## Develop

```sh
pnpm install
pnpm test          # vitest, run once
pnpm typecheck     # tsc --noEmit
pnpm build:action  # bundle the Action into dist/action/
```

Tests assert on external behaviour — what the bot tries to post to GitHub —
through the injected seams, never on internals.

The Action runs the committed bundle in `dist/action/`, so rebuild it with
`pnpm build:action` and commit it with any source change. CI fails if the
bundle is out of date.

## Release

`uses: jonathancwhite/postdev@v1` follows the `v1` tag. After merging to `main`,
tag the release and move `v1` to it:

```sh
git tag v1.1.0 && git tag -f v1 v1.1.0
git push origin v1.1.0 && git push -f origin v1
```

## License

[Apache-2.0](LICENSE).
