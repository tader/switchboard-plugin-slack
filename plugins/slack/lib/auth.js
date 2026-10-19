import { createWebAuth } from "./web-auth.js";
import { fail } from "./errors.js";
export const READ_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "search:read",
  "reactions:read",
];
export const WRITE_SCOPES = [
  "chat:write",
  "reactions:write",
  "channels:write",
  "groups:write",
  "im:write",
  "mpim:write",
];
export const scopesFor = (access) => [
  ...READ_SCOPES,
  ...(access === "write" ? WRITE_SCOPES : []),
];
const TOKEN_URL = "https://slack.com/api/oauth.v2.user.access";
export function createAuth(ctx, client) {
  const oauth = ctx.require("oauth2");
  const options = {
    clientId: () => ctx.settings.clientId,
    clientSecret: () => ctx.settings.clientSecret,
    tokenUrl: TOKEN_URL,
    tokenAuth: "basic",
  };
  const access = (config) => (config.access === "write" ? "write" : "read");
  async function exchange(params, previous) {
    let data;
    try {
      data = await oauth.tokenRequest(options, {}, params);
    } catch (error) {
      if (
        [
          "invalid_grant",
          "invalid_refresh_token",
          "token_revoked",
          "invalid_client",
          "bad_client_secret",
          "access_denied",
        ].includes(error.code)
      )
        throw fail("reconnect_required", 401);
      throw fail("oauth_unavailable", 503);
    }
    if (data.ok !== true || data.token_type !== "user" || !data.access_token)
      throw fail("invalid_oauth_response", 502);
    const credentials = {
      ...oauth.toCredentials(
        {
          ...data,
          scope: data.scope ?? data.authed_user?.scope ?? previous?.scope,
        },
        previous,
      ),
      clientId: ctx.settings.clientId,
      teamId: data.team?.id ?? previous?.teamId,
      userId: data.authed_user?.id ?? previous?.userId,
    };
    if (
      previous &&
      (credentials.teamId !== previous.teamId ||
        credentials.userId !== previous.userId)
    )
      throw fail("account_mismatch", 403);
    return credentials;
  }
  async function identity(credentials, previous) {
    const result = await client.call(credentials, "auth.test");
    if (!result.team_id || !result.user_id || result.bot_id)
      throw fail("user_token_required", 403);
    if (
      previous &&
      (result.team_id !== previous.teamId || result.user_id !== previous.userId)
    )
      throw fail("account_mismatch", 403);
    credentials.teamId = result.team_id;
    credentials.userId = result.user_id;
    return {
      id: `${result.team_id}:${result.user_id}`,
      label: `${result.user ?? result.user_id} · ${result.team ?? result.team_id}`,
    };
  }
  async function usable(conn, opts = {}) {
    if (conn.methodId === "authentication-source")
      return web.usable(conn, opts);
    const c = conn.credentials;
    if (!c?.accessToken || c.clientId !== ctx.settings.clientId)
      throw fail("reconnect_required", 401);
    if (
      !opts.force &&
      (c.expiresAt === undefined || c.expiresAt > Date.now() + 60_000)
    )
      return c;
    if (!c.refreshToken) {
      if (c.expiresAt === undefined) return c;
      throw fail("reconnect_required", 401);
    }
    const next = await exchange(
      { grant_type: "refresh_token", refresh_token: c.refreshToken },
      c,
    );
    // Persist single-use refresh rotation before the next data request can fail.
    await opts.persistCredentials?.(next);
    return next;
  }
  const method = {
    id: "oauth",
    name: "Sign in with Slack",
    description: "Authorize a Slack app to act as you in one workspace.",
    unavailable:
      ctx.settings.clientId && ctx.settings.clientSecret
        ? undefined
        : "Configure the Slack app client ID and secret in plugin settings.",
    fields: [
      {
        key: "access",
        label: "Access",
        type: "select",
        default: "read",
        options: [
          { value: "read", label: "Read only" },
          { value: "write", label: "Read, reply and update read markers" },
        ],
      },
    ],
    async connect({ config, callbackUrl, state }) {
      if (!ctx.settings.clientId || !ctx.settings.clientSecret)
        throw fail("app_not_configured");
      const url = new URL("https://slack.com/oauth/v2_user/authorize");
      for (const [k, v] of Object.entries({
        client_id: ctx.settings.clientId,
        response_type: "code",
        redirect_uri: callbackUrl,
        state,
        scope: scopesFor(access(config)).join(","),
      }))
        url.searchParams.set(k, v);
      return {
        redirect: url.href,
        pending: { callbackUrl, state, access: access(config) },
      };
    },
    async callback({ params, pending, connection }) {
      if (
        !pending ||
        params.state !== pending.state ||
        !params.code ||
        params.error
      )
        throw fail("invalid_oauth_callback");
      const credentials = await exchange({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: pending.callbackUrl,
      });
      const account = await identity(credentials, connection?.credentials);
      return { credentials, account, config: { access: pending.access } };
    },
  };
  const web = createWebAuth(ctx, client, identity);
  return { method, methods: [web.method, method], usable, identity };
}
