// Tabitoken browser proxy transport — Cloudflare edge rejects native TLS, so the
// Tabitoken target must go through the got-scraping transport with browser headers
// while keeping the configured proxy. Regression guard for the r4/r5 fix.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("got-scraping", () => {
  const calls = [];
  const streamCalls = [];
  const gotScraping = vi.fn(async (url, options) => {
    calls.push({ url, options });
    return {
      statusCode: 200,
      statusMessage: "OK",
      headers: { "content-type": "application/json" },
      rawBody: Buffer.from(JSON.stringify({ ok: true })),
    };
  });
  gotScraping.stream = vi.fn((url, options) => {
    streamCalls.push({ url, options });
    const { Readable } = require("stream");
    const s = Readable.from([Buffer.from("data: {}\n\n")]);
    setImmediate(() => s.emit("response", { statusCode: 200, statusMessage: "OK", headers: { "content-type": "text/event-stream" } }));
    return s;
  });
  gotScraping.__calls = calls;
  gotScraping.__streamCalls = streamCalls;
  return { gotScraping, default: gotScraping };
});

describe("Tabitoken browser proxy transport", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("wraps HTTP/2 responses and adds browser origin headers", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const mod = await import("got-scraping");

    const res = await proxyAwareFetch("https://tabitoken.com/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer test" },
    }, { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9999" });

    expect(res.status).toBe(200);
    expect(mod.gotScraping.__calls.length).toBe(1);
    const { options } = mod.gotScraping.__calls[0];
    expect(options.proxyUrl).toBe("http://127.0.0.1:9999");
    expect(options.headers.Origin).toBe("https://tabitoken.com");
    expect(options.headers.Referer).toBe("https://tabitoken.com/");
    expect(options.headers["Sec-Fetch-Mode"]).toBe("cors");
    expect(options.headers.Authorization).toBe("Bearer test");
  });

  it("keeps SSE streaming through the browser transport", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const mod = await import("got-scraping");

    const res = await proxyAwareFetch("https://tabitoken.com/v1/chat/completions", {
      method: "POST",
      headers: { Accept: "text/event-stream", Authorization: "Bearer test" },
      body: JSON.stringify({ stream: true }),
    }, { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9999" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(mod.gotScraping.__streamCalls.length).toBe(1);
    const { options } = mod.gotScraping.__streamCalls[0];
    expect(options.proxyUrl).toBe("http://127.0.0.1:9999");
    expect(options.headers["Sec-Fetch-Mode"]).toBe("cors");
  });
});
