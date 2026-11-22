import type { ClientOptions } from "@anthropic-ai/sdk";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";

/**
 * How the review signs in to the Anthropic API.
 *
 * Keyless (workload identity federation) wins when a federation rule is
 * configured: the Action asks GitHub for a short-lived OIDC token for this run
 * and trades it for an Anthropic access token, so no long-lived secret sits in
 * the repository. An `ANTHROPIC_API_KEY` secret still works on its own, as
 * before, for anyone who has not set up federation.
 */
export type AnthropicAuth =
  | { kind: "federation"; options: ClientOptions; summary: string }
  | { kind: "api-key"; options: ClientOptions; summary: string }
  | { kind: "missing"; message: string };

export type FederationSettings = {
  federationRuleId?: string;
  organizationId?: string;
  workspaceId?: string;
  serviceAccountId?: string;
  audience: string;
};

export type AuthEnvironment = {
  apiKey?: string;
  /** Set by GitHub only when the job has `permissions: id-token: write`. */
  oidcRequestUrl?: string;
  baseURL?: string;
};

/** Fetches a GitHub OIDC token for the given audience (core.getIDToken). */
export type GitHubIdTokenFetcher = (audience: string) => Promise<string>;

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Pick the sign-in method from the Action's inputs and environment. Pure apart
 * from the token fetcher it closes over, so the choice is unit-tested without
 * GitHub or the network.
 */
export function resolveAnthropicAuth(
  settings: FederationSettings,
  env: AuthEnvironment,
  getIdToken: GitHubIdTokenFetcher,
): AnthropicAuth {
  const ruleId = settings.federationRuleId?.trim();
  const orgId = settings.organizationId?.trim();

  if (ruleId || orgId) {
    if (!ruleId || !orgId) {
      return {
        kind: "missing",
        message:
          "Keyless sign-in needs both `anthropic-federation-rule-id` and `anthropic-organization-id`. One of them is empty.",
      };
    }
    if (!env.oidcRequestUrl) {
      return {
        kind: "missing",
        message:
          "Keyless sign-in needs `permissions: id-token: write` on the job, so GitHub can issue an OIDC token for this run.",
      };
    }
    const workspaceId = settings.workspaceId?.trim() || undefined;
    const serviceAccountId = settings.serviceAccountId?.trim() || undefined;
    const audience = settings.audience;
    const credentials = oidcFederationProvider({
      // A fresh GitHub token on every exchange: GitHub's tokens are short-lived
      // and the SDK re-exchanges when its Anthropic token nears expiry.
      identityTokenProvider: () => getIdToken(audience),
      federationRuleId: ruleId,
      organizationId: orgId,
      workspaceId,
      serviceAccountId,
      baseURL: env.baseURL || DEFAULT_ANTHROPIC_BASE_URL,
      fetch: globalThis.fetch,
    });
    return {
      kind: "federation",
      // apiKey: null keeps a stray ANTHROPIC_API_KEY in the environment from
      // outranking the federation credentials inside the SDK.
      options: { credentials, apiKey: null, authToken: null },
      summary: `Signing in to Anthropic without a stored key (federation rule ${ruleId}).`,
    };
  }

  const apiKey = env.apiKey?.trim();
  if (apiKey) {
    return {
      kind: "api-key",
      options: { apiKey },
      summary: "Signing in to Anthropic with the ANTHROPIC_API_KEY secret.",
    };
  }

  return {
    kind: "missing",
    message:
      "No Anthropic credentials. Either set `anthropic-federation-rule-id` and `anthropic-organization-id` (keyless, with `permissions: id-token: write`), or pass ANTHROPIC_API_KEY via `env` from a repository secret. To run only the blast-radius check, set `review: false`.",
  };
}
