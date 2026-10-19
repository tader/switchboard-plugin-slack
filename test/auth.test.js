import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAuth,
  READ_SCOPES,
  WRITE_SCOPES,
} from "../plugins/slack/lib/auth.js";
import { context, credentials, oauthFixture } from "./fixture.js";
const client = {
  call: async () => ({
    ok: true,
    team_id: "T12345678",
    user_id: "U12345678",
    team: "Fixture",
    user: "fixture",
  }),
};
test("official user-only OAuth binds state, scopes and workspace identity", async () => {
  const oauth = oauthFixture(),
    auth = createAuth(context(oauth), client);
  const start = await auth.method.connect({
      config: { access: "write" },
      callbackUrl: "https://switchboard.test/oauth/callback",
      state: "fixture-state",
    }),
    url = new URL(start.redirect);
  assert.equal(url.origin, "https://slack.com");
  assert.equal(url.pathname, "/oauth/v2_user/authorize");
  assert(!url.href.includes("fixture-secret"));
  assert.equal(url.searchParams.has("code_challenge"), false);
  assert(
    WRITE_SCOPES.every((s) =>
      url.searchParams.get("scope").split(",").includes(s),
    ),
  );
  const result = await auth.method.callback({
    params: { state: "fixture-state", code: "fixture-code" },
    pending: start.pending,
  });
  assert.equal(result.account.id, "T12345678:U12345678");
  assert.equal(result.credentials.scope, credentials().scope);
  assert.deepEqual(result.config, { access: "write" });
  assert.equal(
    oauth.calls[0].redirect_uri,
    "https://switchboard.test/oauth/callback",
  );
  assert.equal(oauth.calls[0].code_verifier, undefined);
  await assert.rejects(
    auth.method.callback({
      params: { state: "wrong", code: "fixture-code" },
      pending: start.pending,
    }),
    { code: "invalid_oauth_callback" },
  );
  assert.equal(oauth.calls.length, 1);
  const readonly = await auth.method.connect({
    config: { access: "read" },
    callbackUrl: "http://localhost/oauth/callback",
    state: "state",
  });
  assert.deepEqual(
    new URL(readonly.redirect).searchParams.get("scope").split(","),
    READ_SCOPES,
  );
});
test("OAuth cannot reconnect an existing connection to another user or workspace", async () => {
  const auth = createAuth(context(oauthFixture()), client),
    start = await auth.method.connect({
      config: {},
      callbackUrl: "https://example.test/callback",
      state: "state",
    });
  for (const old of [
    credentials({ userId: "U99999999" }),
    credentials({ teamId: "T99999999" }),
  ])
    await assert.rejects(
      auth.method.callback({
        pending: start.pending,
        params: { state: "state", code: "code" },
        connection: { credentials: old },
      }),
      { code: "account_mismatch" },
    );
});
test("refresh rotations persist before later requests and retain the grant scopes", async () => {
  const oauth = oauthFixture({
      ok: true,
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      token_type: "user",
    }),
    auth = createAuth(context(oauth), client),
    saved = [];
  const old = credentials({ expiresAt: 1, refreshToken: "old-refresh" }),
    next = await auth.usable(
      { credentials: old },
      { persistCredentials: (c) => saved.push(c) },
    );
  assert.equal(next.refreshToken, "new-refresh");
  assert.equal(next.scope, old.scope);
  assert.equal(next.teamId, old.teamId);
  assert.equal(next.userId, old.userId);
  assert.deepEqual(saved, [next]);
  assert.equal(oauth.calls[0].refresh_token, "old-refresh");
  assert.equal(await auth.usable({ credentials: next }), next);
  assert.equal(oauth.calls.length, 1);
});
test("expired credentials, changed apps, bot responses and transient OAuth failures are distinct", async () => {
  const oauth = oauthFixture(),
    auth = createAuth(context(oauth), client);
  await assert.rejects(
    auth.usable({ credentials: credentials({ expiresAt: 1 }) }),
    { code: "reconnect_required" },
  );
  await assert.rejects(
    auth.usable({ credentials: credentials({ clientId: "different" }) }),
    { code: "reconnect_required" },
  );
  const start = await auth.method.connect({
    config: {},
    callbackUrl: "https://example.test/callback",
    state: "state",
  });
  const bot = createAuth(
    context(
      oauthFixture({ ok: true, access_token: "bot-secret", token_type: "bot" }),
    ),
    client,
  );
  await assert.rejects(
    bot.method.callback({
      pending: start.pending,
      params: { state: "state", code: "code" },
    }),
    { code: "invalid_oauth_response" },
  );
  oauth.tokenRequest = async () => {
    throw Error("private secret must not appear");
  };
  await assert.rejects(
    auth.usable({
      credentials: credentials({ refreshToken: "refresh", expiresAt: 1 }),
    }),
    (e) =>
      e.code === "oauth_unavailable" && !e.message.includes("private secret"),
  );
  oauth.tokenRequest = async () => {
    const e = Error("private");
    e.code = "invalid_refresh_token";
    throw e;
  };
  await assert.rejects(
    auth.usable({
      credentials: credentials({ refreshToken: "refresh", expiresAt: 1 }),
    }),
    { code: "reconnect_required" },
  );
});
