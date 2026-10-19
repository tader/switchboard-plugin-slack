import fs from "node:fs/promises";
import { CDP, findBrowser } from "./cdp.js";
import { candidate, identify, fail } from "./session.js";
export function requestToken(request) {
  let u;
  try {
    u = new URL(request.url);
  } catch {
    return;
  }
  if (
    u.protocol !== "https:" ||
    !/^(?:[a-z0-9-]+\.)?slack\.com$/.test(u.hostname) ||
    !u.pathname.startsWith("/api/")
  )
    return;
  const h = Object.entries(request.headers ?? {}).find(
    ([k]) => k.toLowerCase() === "authorization",
  )?.[1];
  const values = [h?.replace(/^Bearer /i, ""), u.searchParams.get("token")];
  if (typeof request.postData === "string") {
    try {
      values.push(JSON.parse(request.postData).token);
    } catch {
      values.push(new URLSearchParams(request.postData).get("token"));
      values.push(
        request.postData.match(
          /name="token"\r?\n\r?\n(xoxc-[A-Za-z0-9-]+)/,
        )?.[1],
      );
    }
  }
  return values.find(
    (v) => typeof v === "string" && /^xoxc-[A-Za-z0-9-]{10,2048}$/.test(v),
  );
}
export async function captureBrowser(
  profile,
  selected,
  {
    silent = false,
    browserPath,
    signal,
    Browser = CDP,
    verify = identify,
  } = {},
) {
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.chmod(profile, 0o700);
  const browser = new Browser(await findBrowser(browserPath), profile, {
    headless: silent,
  });
  const deadline = Date.now() + (silent ? 30000 : 600000);
  let token;
  const unsubscribe = browser.subscribe((event) => {
    if (event.method === "Network.requestWillBeSent")
      token = requestToken(event.params.request) ?? token;
  });
  try {
    const page = await browser.page("about:blank");
    await page.call("Network.enable");
    const version = await browser.call("Browser.getVersion");
    await page.call("Page.navigate", { url: selected.url });
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (token) {
        const { cookies } = await page.call("Network.getCookies", {
          urls: ["https://app.slack.com/", selected.url],
        });
        const cookie = cookies.find(
          (c) =>
            c.name === "d" &&
            [
              ".slack.com",
              "slack.com",
              "app.slack.com",
              selected.host,
            ].includes(c.domain),
        )?.value;
        if (cookie) {
          try {
            return await verify(candidate(token, cookie, version.userAgent), {
              selected,
              signal,
            });
          } catch (error) {
            if (error.code !== "invalid_auth") throw error;
            token = undefined;
          }
        }
      }
      await new Promise((resolve) => {
        const timer = setTimeout(done, 250);
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    throw fail("signin_required");
  } finally {
    unsubscribe();
    await browser.close();
  }
}
