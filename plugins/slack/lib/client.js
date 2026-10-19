import { fail } from "./errors.js";
export const METHODS = new Set([
  "auth.test",
  "users.info",
  "users.list",
  "users.conversations",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
  "conversations.open",
  "search.messages",
  "chat.getPermalink",
  "chat.postMessage",
  "chat.update",
  "chat.delete",
  "reactions.add",
  "reactions.remove",
  "conversations.mark",
]);
// Slack's legacy read/search endpoints do not consistently parse JSON bodies.
// Keep JSON for mutations, and put read parameters in a form body (never the URL).
const FORM_METHODS = new Set([
  "auth.test",
  "users.info",
  "users.list",
  "users.conversations",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
  "search.messages",
  "chat.getPermalink",
]);
const AUTH = new Set([
  "invalid_auth",
  "token_expired",
  "token_revoked",
  "account_inactive",
  "not_authed",
]);
export class SlackClient {
  constructor(fetcher = fetch) {
    this.fetcher = fetcher;
    this.cooldowns = new Map();
  }
  async call(credentials, method, args = {}, signal) {
    if (!METHODS.has(method)) throw fail("unsupported_method");
    if (
      credentials.kind === "web" &&
      (!/^xoxc-[A-Za-z0-9-]{10,2048}$/.test(credentials.accessToken) ||
        !/^xoxd-[A-Za-z0-9%_+\/=-]{10,8192}$/.test(credentials.cookie) ||
        typeof credentials.userAgent !== "string" ||
        /[\r\n]/.test(credentials.userAgent) ||
        credentials.userAgent.length > 1024)
    )
      throw fail("invalid_session", 401);
    const key = `${credentials.teamId}:${method}`,
      now = Date.now();
    if ((this.cooldowns.get(key) ?? 0) > now)
      throw fail("ratelimited", 429, {
        retryAfter: Math.ceil((this.cooldowns.get(key) - now) / 1000),
        definitive: true,
      });
    const form = FORM_METHODS.has(method);
    const body = form
      ? new URLSearchParams(
          Object.entries(args)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [key, String(value)]),
        ).toString()
      : JSON.stringify(args);
    let response;
    try {
      response = await this.fetcher(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": form
            ? "application/x-www-form-urlencoded"
            : "application/json",
          ...(credentials.kind === "web"
            ? {
                cookie: `d=${credentials.cookie}`,
                ...(credentials.userAgent
                  ? { "user-agent": credentials.userAgent }
                  : {}),
              }
            : {}),
        },
        body,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw fail("upstream_unavailable", 502);
    }
    if (response.status === 429) {
      const raw = Number(response.headers.get("retry-after")),
        retryAfter = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 60;
      this.cooldowns.set(key, Date.now() + retryAfter * 1000);
      await response.body?.cancel();
      throw fail("ratelimited", 429, { retryAfter, definitive: true });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw fail(
        response.status === 401 ? "invalid_auth" : "upstream_unavailable",
        response.status === 401 ? 401 : 502,
        { definitive: response.status === 401 },
      );
    }
    const text = await boundedText(response);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw fail("invalid_response", 502);
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw fail("invalid_response", 502);
    if (data.ok !== true) {
      const code =
        typeof data.error === "string" && /^[a-z_]{1,80}$/.test(data.error)
          ? data.error
          : "upstream_error";
      if (code === "ratelimited") {
        this.cooldowns.set(key, Date.now() + 60_000);
        throw fail(code, 429, { retryAfter: 60, definitive: true });
      }
      throw fail(
        code,
        AUTH.has(code)
          ? 401
          : code === "missing_scope" || code === "no_permission"
            ? 403
            : 400,
        {
          definitive: ![
            "internal_error",
            "fatal_error",
            "request_timeout",
            "upstream_error",
          ].includes(code),
        },
      );
    }
    return data;
  }
}
export async function boundedText(response, max = 4 * 1024 * 1024) {
  if (!response.body) throw fail("invalid_response", 502);
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw fail("response_too_large", 502);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
