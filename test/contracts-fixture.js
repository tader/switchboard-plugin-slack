import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "../plugins/slack/lib/adapter.js";
import { credentials, context, oauthFixture } from "./fixture.js";
export const channelId = "C12345678",
  ownId = "U12345678",
  rootId = "1700000000.000001",
  replyId = "1700000001.000001";
export async function contractsFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-contract-"));
  const calls = [];
  let custom;
  const client = {
    async call(c, method, args, signal) {
      calls.push({ method, args, signal });
      if (custom) {
        const result = await custom(method, args);
        if (result !== undefined) return result;
      }
      if (method === "auth.test")
        return { team_id: c.teamId, user_id: c.userId };
      if (method === "users.conversations")
        return { channels: [{ id: channelId, name: "team" }] };
      if (method === "conversations.info")
        return {
          channel: {
            id: args.channel,
            name: "team",
            ...(args.channel.startsWith("D") ? { is_im: true } : {}),
          },
        };
      if (method === "conversations.history")
        return { messages: [{ ts: rootId, text: "Hello", user: ownId }] };
      if (method === "conversations.replies")
        return {
          messages: [
            {
              ts: args.oldest ?? rootId,
              thread_ts: rootId,
              text: "Reply",
              user: ownId,
            },
          ],
        };
      if (method === "chat.postMessage")
        return { channel: args.channel, ts: args.thread_ts ? replyId : rootId };
      throw Error("Unexpected fixture method: " + method);
    },
  };
  const ctx = { ...context(oauthFixture()), dataDir: dir };
  const adapter = await createAdapter(ctx, { client }),
    service = adapter.services[0];
  t.after(async () => {
    await adapter.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const connection = {
    id: "fixture-connection",
    serviceId: "slack",
    methodId: "oauth",
    name: "Fixture",
    config: { access: "write" },
    credentials: credentials(),
  };
  const invocation = (conn = connection, key = "core-fixture-key") => ({
    connection: conn,
    idempotencyKey: key,
    signal: new AbortController().signal,
    async request(input) {
      const req = {
        method: input.method ?? "GET",
        url: new URL(input.url, "http://slack.localhost"),
        headers: new Headers(input.headers),
        body: input.body,
      };
      await service.authMethods
        .find((m) => m.id === conn.methodId)
        .authorize(req, conn);
      return fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    },
  });
  return {
    dir,
    calls,
    ctx,
    client,
    adapter,
    service,
    connection,
    invocation,
    respond(fn) {
      custom = fn;
    },
  };
}
