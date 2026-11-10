import { createHash, randomUUID } from "node:crypto";
import { messagingOperations } from "./messaging-schema.js";
import { MessagingCursors } from "./messaging-cursors.js";
import { DisplayNames, label } from "./display-names.js";
import { fail } from "./errors.js";
const REACTIONS = {"👍":"+1","❤️":"heart","😂":"joy","😮":"open_mouth","😢":"cry","🙏":"pray"};
const REACTION_EMOJI = Object.fromEntries(Object.entries(REACTIONS).map(([emoji,name]) => [name,emoji]));
const CHANNEL = /^[CDG][A-Z0-9]{7,}$/;
const TS = /^\d{1,16}\.\d{6}$/;
const kinds = [
  ["public_channel", "channels"],
  ["private_channel", "groups"],
  ["im", "im"],
  ["mpim", "mpim"],
];
function permissions(c) {
  const scopes = new Set(
    String(c.credentials.scope ?? "")
      .split(/[ ,]+/)
      .filter(Boolean),
  );
  return (name) => c.credentials.kind === "web" || scopes.has(name);
}
function channel(id) {
  if (typeof id !== "string" || !CHANNEL.test(id))
    throw fail("invalid_request");
  return id;
}
function timestamp(id) {
  if (typeof id !== "string" || !TS.test(id)) throw fail("invalid_request");
  return id;
}
function time(ts) {
  if (typeof ts !== "string" || !TS.test(ts)) return null;
  const [seconds, micros] = ts.split(".");
  const date = new Date(Number(seconds) * 1000 + Number(micros.slice(0, 3)));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function messageId(ts, root) {
  timestamp(ts);
  return root && root !== ts
    ? Buffer.from(JSON.stringify([ts, timestamp(root)])).toString("base64url")
    : ts;
}
function target(id) {
  if (typeof id === "string" && TS.test(id)) return { ts: id };
  try {
    const value = JSON.parse(Buffer.from(id, "base64url").toString());
    if (!Array.isArray(value) || value.length !== 2) throw Error();
    return { ts: timestamp(value[0]), threadTs: timestamp(value[1]) };
  } catch {
    throw fail("invalid_request");
  }
}
export function projectConversation(c) {
  if (!c || !CHANNEL.test(c.id)) throw fail("invalid_response", 502);
  return {
    id: c.id,
    title: c.name ?? c.user ?? c.id,
    kind: c.is_im ? "direct" : c.is_mpim ? "group" : "channel",
    unread:
      Number.isSafeInteger(c.unread_count) && c.unread_count >= 0
        ? c.unread_count
        : null,
    updatedAt: time(c.latest?.ts),
  };
}
export function projectMessage(m, conversationId, userId, reactionRead = false) {
  if (!m || !TS.test(m.ts)) throw fail("invalid_response", 502);
  const deleted = m.subtype === "message_deleted" || m.subtype === "tombstone";
  const restricted = m.hidden === true || !!m.is_hidden_by_limit;
  const state = deleted
    ? "deleted"
    : restricted
      ? "restricted"
      : typeof m.text === "string"
        ? "available"
        : "unavailable";
  return {
    id: messageId(m.ts, m.thread_ts),
    conversationId,
    text:
      state === "available"
        ? m.text
            .replaceAll("&lt;", "<")
            .replaceAll("&gt;", ">")
            .replaceAll("&amp;", "&")
        : null,
    authorId:
      typeof m.user === "string"
        ? m.user
        : typeof m.bot_id === "string"
          ? m.bot_id
          : null,
    createdAt: time(m.ts),
    isOwn: m.user ? m.user === userId && !m.bot_id : m.bot_id ? false : null,
    ...(Array.isArray(m.reactions) || reactionRead ? { reactions: (m.reactions ?? []).filter(r => typeof r.name === "string").map(r => ({ emoji: REACTION_EMOJI[r.name] ?? `:${r.name}:`, count: Number.isSafeInteger(r.count) && r.count >= 0 ? r.count : null, me: Array.isArray(r.users) && userId ? (r.users.includes(userId) ? true : Number.isSafeInteger(r.count) && r.users.length >= r.count ? false : null) : null })) } : {}),
    contentState: state,
    contentType:
      m.files?.length || m.attachments?.length
        ? "media"
        : m.subtype && m.subtype !== "thread_broadcast"
          ? "system"
          : "text",
    ...(m.thread_ts || m.reply_count > 0
      ? {
          threadId: m.thread_ts ?? m.ts,
          ...(m.thread_ts && m.thread_ts !== m.ts
            ? { replyToId: m.thread_ts }
            : {}),
        }
      : {}),
  };
}
export function createMessaging(root, nativeWatch) {
  const cursors = new MessagingCursors(root);
  const names = new DisplayNames();
  const userName = (ctx, id) => names.resolve(ctx, id, user => request(ctx, "/users/info", { user }));
  async function namedConversation(ctx, raw) {
    const result = projectConversation(raw);
    if (raw.is_im && raw.user) result.title = await userName(ctx, raw.user) || result.title;
    return result;
  }
  async function namedMessage(ctx, raw, conversationId) {
    const result = projectMessage(raw, conversationId, ctx.connection.credentials.userId, permissions(ctx.connection)("reactions:read"));
    result.authorDisplayName = raw.bot_id
      ? label(raw.bot_profile?.name) || label(raw.username)
      : await userName(ctx, result.authorId);
    return result;
  }
  async function request(ctx, path, input = {}, method = "GET") {
    const query = new URLSearchParams(
      Object.entries(input)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    const response = await ctx.request({
      method,
      url: path + (method === "GET" && query ? "?" + query : ""),
      ...(method === "GET"
        ? {}
        : {
            headers: [["content-type", "application/json"]],
            body: JSON.stringify(input),
          }),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      const e = data.error ?? {};
      if (
        response.status === 401 ||
        [
          "invalid_auth",
          "token_expired",
          "token_revoked",
          "account_inactive",
          "account_mismatch",
          "user_token_required",
          "not_authed",
          "reconnect_required",
        ].includes(e.code)
      )
        throw fail("authentication_required", 401);
      if (response.status === 429)
        throw fail("rate_limited", 429, {
          retryAfterMs: Math.max(
            1000,
            Number(e.retryAfter || response.headers.get("retry-after") || 60) *
              1000,
          ),
        });
      const ambiguous = [
        "internal_error",
        "fatal_error",
        "request_timeout",
        "upstream_error",
        "invalid_response",
        "response_too_large",
        "uncertain",
        "upstream_unavailable",
        "invalid_write_receipt",
        "ledger_locked",
        "ledger_invalid",
      ].includes(e.code);
      if (response.status >= 500 || ambiguous)
        throw fail(
          method === "GET" ? "source_unavailable" : "uncertain",
          method === "GET" ? 502 : 409,
        );
      const code = ["channel_not_found", "message_not_found", "user_not_found", "users_not_found"].includes(e.code)
        ? "not_found"
        : e.code === "idempotency_conflict"
          ? "idempotency_conflict"
          : response.status === 403
            ? "permission_denied"
            : "invalid_request";
      throw fail(
        code,
        {
          not_found: 404,
          idempotency_conflict: 409,
          permission_denied: 403,
          invalid_request: 400,
        }[code],
      );
    }
    return data;
  }
  function available(c) {
    const has = permissions(c),
      names = [];
    if (kinds.some(([, s]) => has(s + ":read")))
      names.push("messaging.conversations.list", "messaging.conversations.get");
    if (kinds.some(([, s]) => has(s + ":read") && has(s + ":history")))
      names.push("messaging.messages.list", "messaging.messages.get");
    if (c.config.access === "write" && has("chat:write"))
      names.push("messaging.messages.send");
    if (c.config.access === "write" && has("reactions:write")) names.push("messaging.reactions.update");
    return names;
  }
  const operations = {};
  function operation(
    name,
    invoke,
    inputSchema = messagingOperations[name].inputSchema,
  ) {
    operations[name] = {
      category: "messaging",
      readOnly: /\.(list|get)$/.test(name),
      ...messagingOperations[name],
      inputSchema,
      async invoke(input, ctx) {
        if (!available(ctx.connection).includes(name))
          throw fail("permission_denied", 403);
        return invoke(input, ctx);
      },
    };
  }
  async function conversation(ctx, id, history = false) {
    const data = await request(ctx, "/conversation", { channel: channel(id) });
    const scope = data.is_im
        ? "im"
        : data.is_mpim
          ? "mpim"
          : data.is_private
            ? "groups"
            : "channels",
      has = permissions(ctx.connection);
    if (!has(scope + ":read") || (history && !has(scope + ":history")))
      throw fail("permission_denied", 403);
    return data;
  }
  async function page(ctx, input, path, extra, type) {
    const binding = [
      ctx.connection.id,
      ctx.connection.credentials.teamId,
      ctx.connection.credentials.userId,
      type,
      extra,
      input.limit ?? 15,
    ];
    const cursor = input.cursor
      ? await cursors.decode(binding, input.cursor)
      : undefined;
    const data = await request(ctx, path, {
      ...extra,
      limit: input.limit ?? 15,
      cursor,
    });
    if (!Array.isArray(data.items)) throw fail("invalid_response", 502);
    const next = data.nextCursor
      ? await cursors.encode(binding, data.nextCursor)
      : undefined;
    return { data, next };
  }
  operation("messaging.conversations.list", async (input, ctx) => {
    const types = kinds
      .filter(([, s]) => permissions(ctx.connection)(s + ":read"))
      .map(([type]) => type)
      .join(",");
    const { data, next } = await page(
      ctx,
      input,
      "/conversations",
      { types },
      "conversations",
    );
    const complete = !next && !data.hasMore && types.split(",").length === 4;
    return {
      items: await Promise.all(data.items.map(c => namedConversation(ctx, c))),
      ...(next ? { nextCursor: next } : {}),
      coverage: {
        complete,
        ...(!complete
          ? {
              reason:
                next || data.hasMore
                  ? "more_conversations"
                  : "granted_conversation_types_only",
            }
          : {}),
      },
    };
  });
  operation("messaging.conversations.get", async (input, ctx) =>
    namedConversation(ctx, await conversation(ctx, input.id)),
  );
  operation(
    "messaging.messages.list",
    async (input, ctx) => {
      await conversation(ctx, input.conversationId, true);
      const { data, next } = await page(
        ctx,
        input,
        input.threadId ? "/thread" : "/messages",
        {
          channel: channel(input.conversationId),
          ...(input.threadId ? { threadTs: timestamp(input.threadId) } : {}),
        },
        "messages",
      );
      // Slack retention and thread replies are not a complete conversation snapshot.
      return {
        items: await Promise.all(data.items.map(m => namedMessage(ctx, m, input.conversationId))),
        ...(next ? { nextCursor: next } : {}),
        coverage: {
          complete: false,
          reason: input.threadId
            ? next || data.hasMore
              ? "more_thread_messages"
              : "retained_thread_history_only"
            : next || data.hasMore
              ? "more_messages_and_threads_not_expanded"
              : "retained_history_only_threads_not_expanded",
        },
      };
    },
    {
      ...messagingOperations["messaging.messages.list"].inputSchema,
      properties: {
        ...messagingOperations["messaging.messages.list"].inputSchema
          .properties,
        limit: { type: "integer", minimum: 1, maximum: 15 },
      },
    },
  );
  operation("messaging.messages.get", async (input, ctx) => {
    await conversation(ctx, input.conversationId, true);
    const data = await request(ctx, "/message", {
      channel: channel(input.conversationId),
      ...target(input.id),
    });
    return namedMessage(ctx, data, input.conversationId);
  });
  const sendSchema = messagingOperations["messaging.messages.send"].inputSchema;
  operation(
    "messaging.messages.send",
    async (input, ctx) => {
      channel(input.conversationId);
      const reply = input.replyToId ? target(input.replyToId) : null;
      const root = input.threadId
        ? timestamp(input.threadId)
        : (reply?.threadTs ?? reply?.ts);
      if (reply && input.threadId && (reply.threadTs ?? reply.ts) !== root)
        throw fail("invalid_request");
      if (root) {
        const has = permissions(ctx.connection);
        if (
          !kinds.some(
            ([, scope]) => has(scope + ":read") && has(scope + ":history"),
          )
        )
          throw fail("permission_denied", 403);
        await conversation(ctx, input.conversationId, true);
      }
      if (typeof ctx.idempotencyKey !== "string" || !ctx.idempotencyKey)
        throw fail("invalid_idempotency_key");
      const idempotencyKey =
        "contract:" +
        createHash("sha256")
          .update(JSON.stringify([ctx.connection.id, ctx.idempotencyKey]))
          .digest("hex");
      try {
        const receipt = await request(
          ctx,
          "/messages",
          {
            channel: input.conversationId,
            text: input.text,
            plainText: true,
            ...(root ? { threadTs: root } : {}),
            idempotencyKey,
          },
          "POST",
        );
        return { status: "accepted", resourceId: messageId(receipt.ts, root) };
      } catch (e) {
        if (e.code === "uncertain") return { status: "uncertain" };
        if (
          [
            "authentication_required",
            "idempotency_conflict",
            "invalid_cursor",
            "rate_limited",
          ].includes(e.code)
        )
          throw e;
        return { status: "rejected", code: e.code };
      }
    },
    {
      ...sendSchema,
      properties: {
        ...sendSchema.properties,
        text: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description:
            "Up to 4000 UTF-16 code units; longer input is rejected without sending.",
        },
      },
    },
  );
  operation("messaging.reactions.update", async (input, ctx) => {
    channel(input.conversationId);
    const { ts } = target(input.messageId);
    const name = REACTIONS[input.emoji] ?? (/^:[a-z0-9_+-]{1,62}:$/.test(input.emoji) ? input.emoji.slice(1,-1) : null);
    if (!name) return { status: "rejected", code: "invalid_request" };
    if (typeof ctx.idempotencyKey !== "string" || !ctx.idempotencyKey) throw fail("invalid_idempotency_key");
    const idempotencyKey = "contract:" + createHash("sha256").update(JSON.stringify([ctx.connection.id, ctx.idempotencyKey])).digest("hex");
    try {
      await request(ctx, "/reactions", { channel: input.conversationId, ts, name, idempotencyKey }, input.remove ? "DELETE" : "POST");
      return { status: "accepted" };
    } catch(e) {
      if (e.code === "uncertain") return { status: "uncertain" };
      if (["authentication_required", "idempotency_conflict", "invalid_cursor", "rate_limited"].includes(e.code)) throw e;
      return { status: "rejected", code: e.code };
    }
  });
  return {
    version: 1,
    ...(nativeWatch
      ? {
          async watch(input, ctx) {
            if (
              !available(ctx.connection).some(
                (name) => operations[name].readOnly,
              )
            )
              throw fail("watch_not_supported", 501);
            await request(ctx, "/status");
            return nativeWatch(input, ctx);
          },
        }
      : {}),
    operations,
    available,
    async collect(_input, ctx) {
      if (!available(ctx.connection).some((name) => operations[name].readOnly))
        throw fail("collector_not_supported", 501);
      await request(ctx, "/status");
      const checkpoint = randomUUID();
      return {
        checkpoint,
        events: [
          {
            sourceId: "slack-reconcile:" + checkpoint,
            event: {
              category: "messaging",
              type: "invalidated",
              resourceType: "scope",
            },
          },
        ],
      };
    },
  };
}
