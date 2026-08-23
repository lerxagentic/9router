import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalEnableRequestLogs = process.env.ENABLE_REQUEST_LOGS;
const originalObservabilityEnabled = process.env.OBSERVABILITY_ENABLED;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-observability-precedence-"));
  process.env.DATA_DIR = tempDir;
  // Match production: the legacy env flag is false while the Settings toggle is true.
  process.env.ENABLE_REQUEST_LOGS = "false";
  process.env.OBSERVABILITY_ENABLED = "false";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    enableObservability: true,
    observabilityBatchSize: 1,
    observabilityFlushIntervalMs: 25,
  });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalEnableRequestLogs === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalEnableRequestLogs;
  if (originalObservabilityEnabled === undefined) delete process.env.OBSERVABILITY_ENABLED;
  else process.env.OBSERVABILITY_ENABLED = originalObservabilityEnabled;
});

describe("request detail observability setting precedence", () => {
  it("records details when the UI toggle is enabled despite legacy env=false", async () => {
    const id = "observability-precedence-red-green";
    await db.saveRequestDetail({
      id,
      provider: "openai-compatible-chat",
      model: "claude-opus-4-8",
      connectionId: "conn-1",
      status: "success",
      tokens: { prompt_tokens: 12, completion_tokens: 4 },
      request: { method: "POST" },
      response: { status: 200 },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const saved = await db.getRequestDetailById(id);
    expect(saved?.id).toBe(id);
    expect(saved?.provider).toBe("openai-compatible-chat");
  });
});
