import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropicAuth } from "../src/action/anthropicAuth.js";

const AUDIENCE = "https://api.anthropic.com";
const OIDC_URL = "https://pipelines.example/token?api-version=2.0";

describe("resolveAnthropicAuth", () => {
  it("uses keyless sign-in when a federation rule is configured", () => {
    const getIdToken = vi.fn();
    const auth = resolveAnthropicAuth(
      { federationRuleId: "fdrl_1", organizationId: "org-uuid", audience: AUDIENCE },
      { oidcRequestUrl: OIDC_URL },
      getIdToken,
    );
    expect(auth.kind).toBe("federation");
    if (auth.kind !== "federation") return;
    expect(typeof auth.options.credentials).toBe("function");
    expect(auth.options.apiKey).toBeNull();
    // Nothing is fetched until the client first needs a token.
    expect(getIdToken).not.toHaveBeenCalled();
  });

  it("prefers the federation rule over an API key that is also set", () => {
    const auth = resolveAnthropicAuth(
      { federationRuleId: "fdrl_1", organizationId: "org-uuid", audience: AUDIENCE },
      { apiKey: "sk-ant-test", oidcRequestUrl: OIDC_URL },
      vi.fn(),
    );
    expect(auth.kind).toBe("federation");
  });

  it("falls back to the API key when no federation rule is set", () => {
    const auth = resolveAnthropicAuth(
      { audience: AUDIENCE },
      { apiKey: "sk-ant-test" },
      vi.fn(),
    );
    expect(auth).toMatchObject({ kind: "api-key", options: { apiKey: "sk-ant-test" } });
  });

  it("says what is missing when the job lacks id-token permission", () => {
    const auth = resolveAnthropicAuth(
      { federationRuleId: "fdrl_1", organizationId: "org-uuid", audience: AUDIENCE },
      {},
      vi.fn(),
    );
    expect(auth.kind).toBe("missing");
    if (auth.kind === "missing") expect(auth.message).toContain("id-token: write");
  });

  it("needs both the rule and the organization", () => {
    const auth = resolveAnthropicAuth(
      { federationRuleId: "fdrl_1", audience: AUDIENCE },
      { oidcRequestUrl: OIDC_URL },
      vi.fn(),
    );
    expect(auth.kind).toBe("missing");
  });

  it("reports missing credentials when neither is set", () => {
    const auth = resolveAnthropicAuth({ audience: AUDIENCE }, {}, vi.fn());
    expect(auth.kind).toBe("missing");
  });

  it("exchanges a fresh GitHub token for an Anthropic token", async () => {
    const getIdToken = vi.fn(async () => "gh.jwt.value");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "sk-ant-oat01-x", token_type: "Bearer", expires_in: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const auth = resolveAnthropicAuth(
        { federationRuleId: "fdrl_1", organizationId: "org-uuid", workspaceId: "wrkspc_1", audience: AUDIENCE },
        { oidcRequestUrl: OIDC_URL },
        getIdToken,
      );
      if (auth.kind !== "federation") throw new Error("expected federation");
      const token = await auth.options.credentials!();
      expect(token.token).toBe("sk-ant-oat01-x");
      expect(getIdToken).toHaveBeenCalledWith(AUDIENCE);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.com/v1/oauth/token");
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: "gh.jwt.value",
        federation_rule_id: "fdrl_1",
        organization_id: "org-uuid",
        workspace_id: "wrkspc_1",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends the federation token, not a stray ANTHROPIC_API_KEY, on API calls", async () => {
    const seen: { url: string; auth: string | null; apiKey: string | null }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), auth: headers.get("authorization"), apiKey: headers.get("x-api-key") });
      const body = String(url).endsWith("/v1/oauth/token")
        ? { access_token: "sk-ant-oat01-fed", token_type: "Bearer", expires_in: 600 }
        : {
            id: "msg_1", type: "message", role: "assistant", model: "m",
            content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const original = globalThis.fetch;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray";
    try {
      const auth = resolveAnthropicAuth(
        { federationRuleId: "fdrl_1", organizationId: "org-uuid", audience: AUDIENCE },
        { apiKey: "sk-ant-stray", oidcRequestUrl: OIDC_URL },
        async () => "gh.jwt.value",
      );
      if (auth.kind !== "federation") throw new Error("expected federation");
      const client = new Anthropic({ ...auth.options, maxRetries: 0 });
      await client.messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      });
      const apiCall = seen.find((call) => call.url.endsWith("/v1/messages"));
      expect(apiCall?.auth).toBe("Bearer sk-ant-oat01-fed");
      expect(apiCall?.apiKey).toBeNull();
    } finally {
      globalThis.fetch = original;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
