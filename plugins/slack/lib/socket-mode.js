import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
const ENDPOINT = "https://slack.com/api/";
export const MESSAGE_EVENTS = new Set([
  "message",
  "reaction_added",
  "reaction_removed",
  "channel_created",
  "channel_deleted",
  "channel_archive",
  "channel_unarchive",
  "channel_rename",
  "channel_marked",
  "group_archive",
  "group_unarchive",
  "group_rename",
  "group_marked",
  "group_deleted",
  "im_created",
  "im_open",
  "im_close",
  "im_marked",
  "mpim_open",
  "mpim_close",
  "mpim_marked",
  "member_joined_channel",
  "member_left_channel",
  "channel_left",
  "group_left",
]);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const unsupported = () => fail("watch_not_supported", 501);
function metadata(raw) {
  if (typeof raw !== "string" || raw.length > 1024 * 1024)
    throw fail("native_payload_invalid", 503);
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    throw fail("native_payload_invalid", 503);
  }
  if (!frame || typeof frame !== "object")
    throw fail("native_payload_invalid", 503);
  if (frame.type === "hello")
    return {
      type: "hello",
      app: frame.connection_info?.app_id,
      connections: frame.num_connections,
    };
  if (frame.type === "disconnect")
    return { type: "disconnect", reason: frame.reason };
  const envelope =
    typeof frame.envelope_id === "string" && frame.envelope_id.length <= 256
      ? frame.envelope_id
      : undefined;
  if (!envelope) throw fail("native_payload_invalid", 503);
  const p = frame.payload ?? {};
  if (Array.isArray(p.authorizations) && p.authorizations.length > 100)
    throw fail("native_payload_invalid", 503);
  // Discard bodies, text, user profiles, channel names and interactive payloads at ingress.
  return {
    envelope,
    type: frame.type,
    callback: p.type,
    app: p.api_app_id,
    eventId: p.event_id,
    context: p.event_context,
    team: p.team_id,
    eventType: p.event?.type,
    authorizations: Array.isArray(p.authorizations)
      ? p.authorizations.slice(0, 100).map((a) => ({
          team_id: a.team_id,
          user_id: a.user_id,
          is_bot: a.is_bot,
        }))
      : [],
  };
}
/** One receive socket for the installed app, fanned out to active authorized users.
 * Multiple sockets for the same app load-balance deliveries rather than broadcast. */
export class SocketMode {
  constructor(
    settings,
    {
      fetcher = fetch,
      createSocket = (url) => new WebSocket(url),
      refreshDelayMs = 5000,
    } = {},
  ) {
    this.settings = settings;
    this.fetcher = fetcher;
    this.createSocket = createSocket;
    this.refreshDelayMs = refreshDelayMs;
    this.members = new Set();
    this.closed = false;
  }
  configured() {
    return (
      this.settings.socketMode === true &&
      /^xapp-[A-Za-z0-9-]{10,4096}$/.test(this.settings.socketAppToken ?? "") &&
      /^A[A-Z0-9]{5,}$/.test(this.settings.socketAppId ?? "")
    );
  }
  async api(method, args, signal) {
    if (
      !["apps.connections.open", "apps.event.authorizations.list"].includes(
        method,
      )
    )
      throw unsupported();
    let response;
    try {
      response = await this.fetcher(ENDPOINT + method, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: {
          authorization: "Bearer " + this.settings.socketAppToken,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(args),
      });
    } catch {
      signal.throwIfAborted();
      throw fail("native_source_unavailable", 503);
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw fail("native_rate_limited", 503, {
        retryAfterMs:
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(86400000, seconds * 1000)
            : 60000,
      });
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw fail("native_source_unavailable", 503);
    }
    signal.throwIfAborted();
    if (!response.ok || data.ok !== true) {
      // A separate app-level credential failure must not pause working user OAuth/polling.
      if (
        [
          "invalid_auth",
          "not_authed",
          "token_revoked",
          "token_expired",
          "missing_scope",
          "not_allowed_token_type",
          "auth_mismatch",
        ].includes(data.error)
      )
        throw unsupported();
      throw fail("native_source_unavailable", 503);
    }
    return data;
  }
  async authorizations(frame, signal) {
    if (
      !frame.context ||
      [...this.members].every((m) =>
        frame.authorizations.some(
          (a) =>
            a.team_id === m.team &&
            a.user_id === m.user &&
            (a.is_bot === false || a.is_bot === "false"),
        ),
      )
    )
      return frame.authorizations;
    if (typeof frame.context !== "string" || frame.context.length > 2048)
      throw fail("native_payload_invalid", 503);
    const found = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const data = await this.api(
        "apps.event.authorizations.list",
        {
          event_context: frame.context,
          limit: "100",
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      if (!Array.isArray(data.authorizations))
        throw fail("native_payload_invalid", 503);
      found.push(
        ...data.authorizations.map((a) => ({
          team_id: a.team_id,
          user_id: a.user_id,
          is_bot: a.is_bot,
        })),
      );
      const next = data.response_metadata?.next_cursor;
      if (!next) return found;
      if (typeof next !== "string" || next.length > 4096 || seen.has(next))
        throw fail("native_payload_invalid", 503);
      seen.add(next);
      cursor = next;
    }
    // Never quietly acknowledge incomplete installation routing.
    throw fail("native_authorizations_bounded", 503);
  }
  async publish(member, event, sourceId) {
    if (member.signal.aborted || !this.members.has(member)) return true;
    try {
      await member.send({
        checkpoint: sourceId,
        events: [{ sourceId, event }],
      });
      return true;
    } catch (error) {
      if (member.signal.aborted || !this.members.has(member)) return true;
      member.done.reject(error);
      this.members.delete(member);
      return false;
    }
  }
  async resync(sourceId) {
    await Promise.all(
      [...this.members].map((member) =>
        this.publish(
          member,
          {
            category: "messaging",
            type: "resync.required",
            resourceType: "scope",
          },
          sourceId,
        ),
      ),
    );
  }
  async handle(frame, signal, send) {
    if (frame.app !== this.settings.socketAppId) {
      if (frame.app !== undefined) throw fail("native_app_mismatch", 503);
      // Unsupported non-Events envelopes are acknowledged, never acted on.
      if (frame.type !== "events_api") {
        send(frame.envelope);
        return;
      }
      throw fail("native_payload_invalid", 503);
    }
    if (frame.type !== "events_api") {
      send(frame.envelope);
      return;
    }
    if (frame.callback === "app_rate_limited") {
      const results = await Promise.all(
        [...this.members]
          .filter((m) => m.team === frame.team)
          .map((m) =>
            this.publish(
              m,
              {
                category: "messaging",
                type: "resync.required",
                resourceType: "scope",
              },
              "slack-rate-resync:" + randomUUID(),
            ),
          ),
      );
      if (results.every(Boolean)) send(frame.envelope);
      return;
    }
    if (
      frame.callback !== "event_callback" ||
      !MESSAGE_EVENTS.has(frame.eventType)
    ) {
      send(frame.envelope);
      return;
    }
    if (
      typeof frame.eventId !== "string" ||
      !/^Ev[A-Za-z0-9_-]{1,125}$/.test(frame.eventId)
    )
      throw fail("native_payload_invalid", 503);
    const authorized = await this.authorizations(frame, signal);
    const targets = [...this.members].filter((m) =>
      authorized.some(
        (a) =>
          a.team_id === m.team &&
          a.user_id === m.user &&
          (a.is_bot === false || a.is_bot === "false"),
      ),
    );
    const results = await Promise.all(
      targets.map((m) =>
        this.publish(
          m,
          { category: "messaging", type: "invalidated", resourceType: "scope" },
          "slack-event:" + frame.eventId,
        ),
      ),
    );
    signal.throwIfAborted();
    if (results.every(Boolean)) send(frame.envelope);
  }
  async cycle(signal) {
    const data = await this.api("apps.connections.open", {}, signal);
    let url;
    try {
      url = new URL(data.url);
    } catch {
      throw fail("native_endpoint_invalid", 503);
    }
    if (
      url.protocol !== "wss:" ||
      !url.hostname.endsWith(".slack.com") ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      throw fail("native_endpoint_invalid", 503);
    signal.throwIfAborted();
    const socket = this.createSocket(url.href),
      done = deferred(),
      queue = [];
    let reading = false,
      hello = false,
      ended = false,
      refresh = false,
      timer;
    const finish = (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      error ? done.reject(error) : done.resolve();
    };
    const send = (id) => {
      signal.throwIfAborted();
      if (ended || socket.readyState !== 1)
        throw fail("native_source_unavailable", 503);
      socket.send(JSON.stringify({ envelope_id: id }));
    };
    const drain = async () => {
      if (reading || ended) return;
      reading = true;
      try {
        while (queue.length && !ended) {
          signal.throwIfAborted();
          const frame = queue.shift();
          if (frame.type === "hello") {
            if (hello || frame.app !== this.settings.socketAppId)
              throw fail("native_app_mismatch", 503);
            if (typeof frame.connections === "number" && frame.connections > 1)
              throw fail("native_shared_app_socket", 503);
            hello = true;
            clearTimeout(timer);
            await this.resync("slack-connect-resync:" + randomUUID());
          } else if (frame.type === "disconnect") {
            if (frame.reason === "refresh_requested") {
              refresh = true;
              finish();
            } else if (frame.reason !== "warning")
              throw fail("native_socket_disabled", 503);
          } else {
            if (!hello) throw fail("native_payload_invalid", 503);
            await this.handle(frame, signal, send);
          }
        }
      } catch (error) {
        finish(error);
      } finally {
        reading = false;
      }
    };
    const onMessage = (event) => {
      try {
        const frame = metadata(event.data);
        if (queue.length >= 256) throw fail("native_receive_overflow", 503);
        queue.push(frame);
        void drain();
      } catch (error) {
        finish(error);
      }
    };
    const onClose = () =>
      finish(
        signal.aborted ? signal.reason : fail("native_socket_closed", 503),
      );
    const onError = () => finish(fail("native_source_unavailable", 503));
    const onAbort = () =>
      finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(fail("native_hello_timeout", 503)), 20000);
    timer.unref?.();
    if (signal.aborted) onAbort();
    try {
      await done.promise;
      return refresh;
    } finally {
      ended = true;
      queue.length = 0;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {}
    }
  }
  start() {
    if (this.running || this.closed || !this.members.size) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = (async () => {
      try {
        while (!controller.signal.aborted && this.members.size) {
          await this.cycle(controller.signal);
          await new Promise((resolve, reject) => {
            const off = () => {
              clearTimeout(timer);
              reject(controller.signal.reason);
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener("abort", off);
              resolve();
            }, this.refreshDelayMs);
            controller.signal.addEventListener("abort", off, { once: true });
            if (controller.signal.aborted) off();
          });
        }
      } catch (error) {
        if (!controller.signal.aborted)
          for (const m of this.members) m.done.reject(error);
      } finally {
        this.running = undefined;
      }
    })();
  }
  async watch(_input, ctx) {
    if (this.closed || !this.configured()) throw unsupported();
    const { teamId, userId } = ctx.connection.credentials;
    if (typeof teamId !== "string" || typeof userId !== "string")
      throw unsupported();
    ctx.signal.throwIfAborted();
    const done = deferred();
    let tail = Promise.resolve();
    const member = {
      team: teamId,
      user: userId,
      signal: ctx.signal,
      done,
      send: (batch) => {
        tail = tail.then(() => {
          ctx.signal.throwIfAborted();
          return ctx.publish(batch);
        });
        return tail;
      },
    };
    const abort = () => done.resolve();
    ctx.signal.addEventListener("abort", abort, { once: true });
    this.members.add(member);
    try {
      const initial = this.publish(
        member,
        {
          category: "messaging",
          type: "resync.required",
          resourceType: "scope",
        },
        "slack-watch-resync:" + randomUUID(),
      );
      // Wait for the pre-existing generation to finish closing before starting a fresh socket.
      if (this.controller?.signal.aborted && this.running) await this.running;
      await initial;
      if (!this.members.has(member)) return await done.promise;
      if (!ctx.signal.aborted) this.start();
      else done.resolve();
      await done.promise;
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      this.members.delete(member);
      if (!this.members.size) {
        this.controller?.abort();
        await this.running;
      }
    }
  }
  async dispose() {
    this.closed = true;
    for (const member of this.members) member.done.resolve();
    this.controller?.abort();
    await this.running;
  }
}
