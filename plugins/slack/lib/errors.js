export class SlackError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(
      {
        invalid_auth:
          "Slack rejected the credentials; reconnect this connection.",
        token_revoked: "Slack access was revoked; reconnect this connection.",
        token_expired: "Slack credentials expired; reconnect this connection.",
        missing_scope:
          "The Slack app lacks a required user scope; update the app and reconnect.",
        ratelimited:
          "Slack rate limit reached; retry after the indicated delay.",
        reconnect_required: "Reconnect Slack to obtain a new authorization.",
        permission_denied:
          "This operation exceeds the connection access level.",
        uncertain:
          "The previous write outcome is unknown. Check Slack before making another attempt.",
        idempotency_conflict:
          "This idempotency key was used for different content.",
      }[code] ?? `Slack operation failed (${code}).`,
    );
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
export const fail = (code, status = 400, extra) =>
  new SlackError(code, status, extra);
export function publicError(error) {
  return error instanceof SlackError
    ? {
        code: error.code,
        message: error.message,
        ...(error.retryAfter !== undefined
          ? { retryAfter: error.retryAfter }
          : {}),
      }
    : {
        code: "internal_error",
        message: "The Slack adapter could not finish this operation.",
      };
}
