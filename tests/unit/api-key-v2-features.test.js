// Proof for the v2 key features ported to the regular router:
// 1. Model scope   - restricted key is denied for models outside allowedModels
// 2. Request limit - key past its requestLimit is denied
// 3. Token limit   - key past its tokenLimit is denied
// 4. Allocation    - getProviderCredentials returns ONLY connections allocated to the key
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-keyv2-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key v2 features (ported to regular router)", () => {
  it("restricted scope denies non-allowed model, allows allowed model", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, scopeType, allowedModels)
       VALUES(?, ?, ?, ?, 1, ?, ?, 'restricted', ?)`,
      ["k1", "sk-test-1", "scoped", "m1", now, now, JSON.stringify(["gpt-4"])]
    );

    const { validateApiKeyAccess } = await import("@/sse/services/apiKeyLimits.js");
    const denied = await validateApiKeyAccess("sk-test-1", "claude-opus");
    expect(denied.allowed).toBe(false);

    const allowed = await validateApiKeyAccess("sk-test-1", "gpt-4");
    expect(allowed.allowed).toBe(true);
  });

  it("request limit denies once requestsUsed >= requestLimit", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, requestLimit, requestsUsed, scopeType)
       VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, 'global')`,
      ["k2", "sk-test-2", "limited", "m1", now, now, 10, 10]
    );

    const { validateApiKeyAccess } = await import("@/sse/services/apiKeyLimits.js");
    const result = await validateApiKeyAccess("sk-test-2", "gpt-4");
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/Request limit exceeded/i);
  });

  it("token limit denies once tokensUsed >= tokenLimit", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, tokenLimit, tokensUsed, scopeType)
       VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, 'global')`,
      ["k3", "sk-test-3", "toklimited", "m1", now, now, 1000, 1000]
    );

    const { validateApiKeyAccess } = await import("@/sse/services/apiKeyLimits.js");
    const result = await validateApiKeyAccess("sk-test-3", "gpt-4");
    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/Token limit exceeded/i);
  });

  it("usage counters increment when a request is recorded", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, tokensUsed, requestsUsed, scopeType)
       VALUES(?, ?, ?, ?, 1, ?, ?, 0, 0, 'global')`,
      ["k4", "sk-test-4", "counted", "m1", now, now]
    );

    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    await saveRequestUsage({
      timestamp: Date.now(),
      provider: "test",
      model: "gpt-4",
      apiKey: "sk-test-4",
      tokens: { prompt_tokens: 5, completion_tokens: 7 },
    });

    const row = db.get(`SELECT tokensUsed, requestsUsed FROM apiKeys WHERE key='sk-test-4'`);
    expect(row.requestsUsed).toBe(1);
    expect(row.tokensUsed).toBe(12);
  });

  it("connection allocation: key uses only its allocated connections", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, scopeType)
       VALUES(?, ?, ?, ?, 1, ?, ?, 'global')`,
      ["k5", "sk-test-5", "alloc", "m1", now, now]
    );

    // Two connections for the same provider: one allocated to k5, one global
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, assignedToApiKeyId)
       VALUES('c-alloc', 'testprov', 'apikey', 'allocated', null, 1, 1, '{}', ?, ?, 'k5')`,
      [now, now]
    );
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, assignedToApiKeyId)
       VALUES('c-global', 'testprov', 'apikey', 'global', null, 2, 1, 'tok-b', ?, ?, NULL)`,
      [now, now]
    );
    // A connection allocated to a DIFFERENT key must never be usable
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, assignedToApiKeyId)
       VALUES('c-other', 'testprov', 'apikey', 'other', null, 3, 1, 'tok-c', ?, ?, 'other-key-id')`,
      [now, now]
    );

    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const creds = await getProviderCredentials("testprov", null, null, { apiKey: "sk-test-5" });
    expect(creds).not.toBeNull();
    // Only the connection allocated to k5 should be returned
    expect(creds.connectionId).toBe("c-alloc");
  });

  it("connection allocation: key with no allocation uses global pool only", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, scopeType)
       VALUES(?, ?, ?, ?, 1, ?, ?, 'global')`,
      ["k6", "sk-test-6", "unalloc", "m1", now, now]
    );

    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, assignedToApiKeyId)
       VALUES('c-global', 'testprov', 'apikey', 'global', null, 1, 1, '{}', ?, ?, NULL)`,
      [now, now]
    );
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, assignedToApiKeyId)
       VALUES('c-other', 'testprov', 'apikey', 'other', null, 2, 1, 'tok-c', ?, ?, 'other-key-id')`,
      [now, now]
    );

    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const creds = await getProviderCredentials("testprov", null, null, { apiKey: "sk-test-6" });
    expect(creds).not.toBeNull();
    // No allocation → global pool only, must NOT pick c-other (assigned to another key)
    expect(creds.connectionId).toBe("c-global");
  });

  it("getAvailableConnectionsForApiKey returns own + unassigned only", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, assignedToApiKeyId)
       VALUES('own', 'p', 'apikey', null, null, 1, 1, '{}', ?, ?, 'keyA')`, [now, now]);
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, assignedToApiKeyId)
       VALUES('free', 'p', 'apikey', null, null, 2, 1, '{}', ?, ?, NULL)`, [now, now]);
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, assignedToApiKeyId)
       VALUES('foreign', 'p', 'apikey', null, null, 3, 1, '{}', ?, ?, 'keyB')`, [now, now]);

    const { getAvailableConnectionsForApiKey } = await import("@/lib/db/repos/connectionsRepo.js");
    const conns = await getAvailableConnectionsForApiKey("keyA");
    const ids = conns.map(c => c.id).sort();
    expect(ids).toEqual(["free", "own"]);
  });
});
