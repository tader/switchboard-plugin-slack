// Use an already-configured Switchboard connection. Never accept Slack tokens here.
const args = process.argv.slice(2),
  url = process.env.SWITCHBOARD_URL,
  token = process.env.SWITCHBOARD_TOKEN,
  connection = process.env.SLACK_CONNECTION;
if (!url || !token || !connection)
  throw Error("Set SWITCHBOARD_URL, SWITCHBOARD_TOKEN and SLACK_CONNECTION.");
const origin = new URL(url);
if (
  origin.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
)
  throw Error("Remote Switchboard requires HTTPS.");
if (args.some((a) => a !== "--write"))
  throw Error("Supported argument: --write");
async function call(method, path, body) {
  const r = await fetch(new URL("/api/call", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      connection,
      method,
      url: path,
      ...(body
        ? {
            body: JSON.stringify(body),
            headers: [["content-type", "application/json"]],
          }
        : {}),
    }),
    redirect: "error",
  });
  if (!r.ok) throw Error(`Switchboard diagnostic failed: HTTP ${r.status}`);
  const value = await r.json();
  if (value.status >= 400)
    throw Error(`Slack diagnostic failed: HTTP ${value.status}`);
  return typeof value.body === "string" ? JSON.parse(value.body) : value.body;
}
const status = await call("GET", "/status");
if (!status.ready) throw Error("Slack is not ready");
console.log("PASS: Slack identity validated");
if (args.includes("--write")) {
  const channel = process.env.SLACK_TEST_CHANNEL;
  if (!channel)
    throw Error(
      "Set SLACK_TEST_CHANNEL to an explicitly selected test conversation.",
    );
  const id = crypto.randomUUID(),
    text = `Switchboard disposable Slack check ${id}`;
  const sent = await call("POST", "/messages", {
    channel,
    text,
    idempotencyKey: `diagnostic-send-${id}`,
  });
  console.log("PASS: disposable message accepted");
  await call("DELETE", "/messages", {
    channel,
    ts: sent.ts,
    expectedText: text,
    idempotencyKey: `diagnostic-delete-${id}`,
  });
  console.log("PASS: disposable message removed");
}
