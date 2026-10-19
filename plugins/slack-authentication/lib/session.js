export const FORMAT = "slack/web-session/v1";
export const fail = (code, status = 401) =>
  Object.assign(new Error(code), { code, status });
export function workspace(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw fail("invalid_workspace", 400);
  }
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    !/^[a-z0-9-]+\.slack\.com$/.test(u.hostname)
  )
    throw fail("invalid_workspace", 400);
  if (u.hostname === "app.slack.com") {
    const id = u.pathname.match(/^\/client\/(T[A-Z0-9]+)(?:\/|$)/)?.[1];
    if (!id) throw fail("workspace_link_required", 400);
    return { url: `https://app.slack.com/client/${id}`, teamId: id };
  }
  if (
    [
      "api",
      "docs",
      "status",
      "slack",
      "files",
      "downloads",
      "help",
      "slackb",
    ].includes(u.hostname.split(".")[0])
  )
    throw fail("invalid_workspace", 400);
  return { url: `https://${u.hostname}/`, host: u.hostname };
}
export function validateBundle(c, previous) {
  if (
    !c ||
    c.kind !== "web" ||
    !/^xoxc-[A-Za-z0-9-]{10,2048}$/.test(c.accessToken) ||
    !/^xoxd-[A-Za-z0-9%_+\/=-]{10,8192}$/.test(c.cookie) ||
    !/^T[A-Z0-9]+$/.test(c.teamId) ||
    !/^[UW][A-Z0-9]+$/.test(c.userId) ||
    typeof c.userAgent !== "string" ||
    c.userAgent.length > 1024 ||
    /[\r\n]/.test(c.userAgent) ||
    !Number.isFinite(c.validatedAt)
  )
    throw fail("invalid_session");
  if (
    previous &&
    (c.teamId !== previous.teamId || c.userId !== previous.userId)
  )
    throw fail("account_mismatch", 403);
  return c;
}
export function sessionHeaders(c) {
  validateBundle(c);
  return {
    authorization: `Bearer ${c.accessToken}`,
    cookie: `d=${c.cookie}`,
    ...(c.userAgent ? { "user-agent": c.userAgent } : {}),
  };
}
export async function identify(c, { fetcher = fetch, signal, selected } = {}) {
  const res = await fetcher("https://slack.com/api/auth.test", {
    method: "POST",
    headers: sessionHeaders(c),
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw fail(
      res.status === 401 ? "invalid_auth" : "identity_unavailable",
      res.status === 401 ? 401 : 503,
    );
  }
  // auth.test contains identity metadata only, never messages.
  if (!res.body) throw fail("invalid_identity", 502);
  const reader = res.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw fail("invalid_identity", 502);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw fail("invalid_identity", 502);
  }
  if (!d.ok)
    throw fail(
      [
        "invalid_auth",
        "token_expired",
        "token_revoked",
        "not_authed",
        "account_inactive",
      ].includes(d.error)
        ? "invalid_auth"
        : "identity_unavailable",
      [
        "invalid_auth",
        "token_expired",
        "token_revoked",
        "not_authed",
        "account_inactive",
      ].includes(d.error)
        ? 401
        : 503,
    );
  if (
    d.bot_id ||
    !/^T[A-Z0-9]+$/.test(d.team_id) ||
    !/^[UW][A-Z0-9]+$/.test(d.user_id)
  )
    throw fail("invalid_identity", 403);
  if (
    (c.teamId !== "TUNKNOWN" && c.teamId !== d.team_id) ||
    (c.userId !== "UUNKNOWN" && c.userId !== d.user_id)
  )
    throw fail("account_mismatch", 403);
  if (selected?.teamId && selected.teamId !== d.team_id)
    throw fail("workspace_mismatch", 403);
  if (selected?.host) {
    let host;
    try {
      host = new URL(d.url).hostname;
    } catch {}
    if (host !== selected.host) throw fail("workspace_mismatch", 403);
  }
  return {
    credentials: {
      ...c,
      teamId: d.team_id,
      userId: d.user_id,
      validatedAt: Date.now(),
    },
    account: {
      id: `${d.team_id}:${d.user_id}`,
      label: `${d.user ?? d.user_id} · ${d.team ?? d.team_id}`,
    },
  };
}
export const candidate = (accessToken, cookie, userAgent = "") => ({
  kind: "web",
  accessToken,
  cookie,
  userAgent,
  teamId: "TUNKNOWN",
  userId: "UUNKNOWN",
  validatedAt: 0,
});
