import { fail } from "./errors.js";
export const FORMAT = "slack/web-session/v1";
export function createWebAuth(ctx, client, identity) {
  async function obtain(config, previous, forceAuthentication, signal) {
    if (!ctx.credentials) throw fail("core_upgrade_required", 401);
    const provided = await ctx.credentials.obtain(config.authenticationSource, {
      format: FORMAT,
      forceAuthentication,
      signal,
    });
    const c = provided.bundle;
    if (provided.format !== FORMAT || c?.kind !== "web")
      throw fail("invalid_session", 401);
    const account = await identity(c, previous);
    if (account.id !== provided.account.id) throw fail("account_mismatch", 403);
    return { credentials: c, account };
  }
  return {
    method: {
      id: "authentication-source",
      name: "Use Slack Authentication",
      description:
        "Use a cached browser or Slack desktop session on this device or an explicitly shared authentication connection on a peer. No Slack app required.",
      unavailable: ctx.credentials
        ? undefined
        : "Upgrade Switchboard to enable authentication sources.",
      credentialConsumer: { format: FORMAT, field: "authenticationSource" },
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
        {
          key: "authenticationSource",
          label: "Authentication connection",
          type: "credential-source",
          credentialFormat: FORMAT,
          required: true,
        },
      ],
      async connect({ config, connection }) {
        const result = await obtain(config, connection?.credentials, false);
        return {
          ...result,
          config: {
            authenticationSource: config.authenticationSource,
            access: config.access === "write" ? "write" : "read",
          },
        };
      },
    },
    async usable(conn, opts = {}) {
      const c = conn.credentials;
      if (!opts.force && c?.kind === "web") return c;
      let result;
      // Always obtain the source's current cached session before asking it to reopen a browser/import again.
      try {
        result = await obtain(conn.config, c, false, opts.signal);
      } catch (e) {
        if (e.status !== 401) throw e;
        result = await obtain(conn.config, c, true, opts.signal);
      }
      await opts.persistCredentials?.(result.credentials);
      return result.credentials;
    },
  };
}
