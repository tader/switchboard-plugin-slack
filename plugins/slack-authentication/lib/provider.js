import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  FORMAT,
  fail,
  workspace,
  validateBundle,
  identify,
  sessionHeaders,
} from "./session.js";
import { captureBrowser } from "./browser.js";
import { importDesktop } from "./desktop.js";
export function setupProvider(
  ctx,
  { capture = captureBrowser, desktop = importDesktop, verify = identify } = {},
) {
  const pending = new Map(),
    controllers = new Set(),
    locks = new Map();
  const profilePath = (id) => {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw fail("invalid_profile", 400);
    return path.join(ctx.dataDir, "profiles", id);
  };
  async function acquire(
    kind,
    selected,
    profile,
    previous,
    signal,
    interactive,
  ) {
    let result;
    if (kind === "desktop") result = await desktop(selected, { signal });
    else {
      try {
        result = await capture(profilePath(profile), selected, {
          silent: true,
          browserPath: ctx.settings.browserPath,
          signal,
        });
      } catch (error) {
        if (
          signal?.aborted ||
          error.code === "account_mismatch" ||
          !interactive
        )
          throw error;
        result = await capture(profilePath(profile), selected, {
          silent: false,
          browserPath: ctx.settings.browserPath,
          signal,
        });
      }
    }
    validateBundle(result.credentials, previous);
    return result;
  }
  async function usable(conn, opts = {}) {
    const c = conn.credentials;
    validateBundle(c?.bundle);
    // Cache survives restarts in Switchboard's encrypted credential store.
    if (!opts.forceAuthentication) {
      try {
        return {
          ...(await verify(c.bundle, { signal: opts.signal })),
          credentials: c,
        };
      } catch (e) {
        if (e.status !== 401) throw e;
      }
    }
    const key = c.profile ?? `desktop:${c.bundle.teamId}:${c.bundle.userId}`;
    if (!locks.has(key))
      locks.set(
        key,
        (async () => {
          let next;
          try {
            next = await acquire(
              conn.methodId,
              c.selected,
              c.profile,
              c.bundle,
              opts.signal,
              false,
            );
          } catch (e) {
            if (opts.signal?.aborted) throw opts.signal.reason;
            if (e.code === "account_mismatch" || e.status === 503) throw e;
            throw fail("signin_required");
          }
          const credentials = { ...c, bundle: next.credentials };
          await opts.persistCredentials?.(credentials);
          return { credentials, account: next.account };
        })().finally(() => locks.delete(key)),
      );
    return locks.get(key);
  }
  function method(kind) {
    return {
      id: kind,
      name:
        kind === "desktop"
          ? "Use local Slack desktop session (macOS)"
          : "Sign in through local browser",
      description:
        kind === "desktop"
          ? "Explicitly import this workspace session from Slack and its macOS Keychain key. No app installation required."
          : "Sign in normally in a dedicated Chrome or Edge profile. The browser closes after authentication.",
      unavailable:
        kind === "desktop" && process.platform !== "darwin"
          ? "Desktop import currently supports macOS. Use browser sign-in on this device."
          : undefined,
      fields: [
        {
          key: "workspaceUrl",
          label: "Workspace URL",
          required: true,
          description:
            "https://your-workspace.slack.com or https://app.slack.com/client/T…",
        },
      ],
      async connect({ config, connection }) {
        const selected = workspace(config.workspaceUrl),
          profile = connection?.credentials?.profile ?? randomUUID();
        const id = randomUUID(),
          controller = new AbortController();
        controllers.add(controller);
        const flow = { controller, profile, expires: Date.now() + 600000 };
        pending.set(id, flow);
        void acquire(
          kind,
          selected,
          profile,
          connection?.credentials?.bundle,
          controller.signal,
          true,
        )
          .then((result) => {
            flow.result = {
              credentials: { profile, selected, bundle: result.credentials },
              account: result.account,
              config: { workspaceUrl: selected.url },
            };
          })
          .catch((error) => {
            const known = [
              "account_mismatch",
              "workspace_mismatch",
              "slack_keychain_access_required",
              "desktop_session_unavailable_open_workspace_or_use_browser",
              "slack_desktop_not_found",
              "desktop_import_macos_only",
            ];
            flow.error = fail(
              known.includes(error.code)
                ? error.code
                : kind === "desktop"
                  ? "desktop_import_failed_use_browser_or_check_keychain"
                  : "signin_failed_reconnect",
            );
          })
          .finally(() => controllers.delete(controller));
        return {
          device: {
            userCode: kind === "desktop" ? "LOCAL-SLACK" : "LOCAL-BROWSER",
            verificationUri: selected.url,
            expiresIn: 600,
            interval: 3,
          },
          pending: { id },
        };
      },
      async poll({ pending: state }) {
        const f = pending.get(state.id);
        if (!f || f.expires < Date.now()) throw fail("signin_expired");
        if (f.error) {
          pending.delete(state.id);
          throw f.error;
        }
        if (!f.result) return { wait: true };
        pending.delete(state.id);
        return f.result;
      },
      async authorize(req, conn, opts = {}) {
        if (
          req.url.origin === "https://slack.com" &&
          req.url.pathname === "/api/auth.test/"
        )
          req.url.pathname = "/api/auth.test";
        if (
          !["GET", "HEAD"].includes(req.method) ||
          req.url.origin !== "https://slack.com" ||
          req.url.pathname !== "/api/auth.test" ||
          req.url.search ||
          req.url.username ||
          req.url.password
        )
          throw fail("request_forbidden", 403);
        const result = await usable(conn, opts);
        for (const [k, v] of Object.entries(
          sessionHeaders(result.credentials.bundle),
        ))
          req.headers.set(k, v);
        return { credentials: result.credentials };
      },
      credentialProvider: {
        format: FORMAT,
        async provide(conn, opts) {
          const result = await usable(conn, opts);
          return {
            bundle: validateBundle(result.credentials.bundle),
            credentials: result.credentials,
            account: result.account,
          };
        },
      },
      async revoke(conn) {
        for (const [id, f] of pending)
          if (f.profile === conn.credentials.profile) {
            f.controller.abort();
            pending.delete(id);
          }
        if (conn.credentials.profile)
          await fs.rm(profilePath(conn.credentials.profile), {
            recursive: true,
            force: true,
          });
      },
    };
  }
  const timer = setInterval(() => {
    for (const [id, f] of pending)
      if (f.expires < Date.now()) {
        f.controller.abort();
        pending.delete(id);
      }
  }, 30000);
  timer.unref();
  return {
    services: [
      {
        id: "slack-authentication",
        name: "Slack Authentication",
        description:
          "Local Slack sessions for this device and explicitly authorized peers.",
        icon: "icon.svg",
        baseUrl: "https://slack.com/api/auth.test",
        allowedHosts: ["slack.com"],
        authMethods: [method("browser"), method("desktop")],
      },
    ],
    dispose() {
      clearInterval(timer);
      for (const c of controllers) c.abort();
      pending.clear();
    },
  };
}
