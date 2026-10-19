export const credentials = (overrides = {}) => ({
  accessToken: "fixture-access",
  clientId: "fixture-client",
  teamId: "T12345678",
  userId: "U12345678",
  scope:
    "channels:read channels:history groups:read groups:history im:read im:history mpim:read mpim:history users:read search:read reactions:read chat:write reactions:write channels:write groups:write im:write mpim:write",
  ...overrides,
});
export function oauthFixture(
  raw = {
    ok: true,
    access_token: "fixture-access",
    token_type: "user",
    authed_user: { id: "U12345678", scope: credentials().scope },
    team: { id: "T12345678" },
  },
) {
  const calls = [];
  return {
    calls,
    toCredentials: (d, p) => ({
      accessToken: d.access_token,
      refreshToken: d.refresh_token ?? p?.refreshToken,
      expiresAt: d.expires_in ? Date.now() + d.expires_in * 1000 : undefined,
      scope: d.scope ?? p?.scope,
    }),
    async tokenRequest(o, c, p) {
      calls.push(p);
      return raw;
    },
  };
}
export const context = (oauth) => ({
  settings: { clientId: "fixture-client", clientSecret: "fixture-secret" },
  require: (id) => {
    if (id !== "oauth2") throw Error("Unexpected dependency");
    return oauth;
  },
});
