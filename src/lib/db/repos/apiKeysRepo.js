import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;

  // Parse JSON fields
  const allowedModels = row.allowedModels ? JSON.parse(row.allowedModels) : null;
  const allowedCombos = row.allowedCombos ? JSON.parse(row.allowedCombos) : null;

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Limits
    tokenLimit: row.tokenLimit,
    requestLimit: row.requestLimit,
    tokensUsed: row.tokensUsed || 0,
    requestsUsed: row.requestsUsed || 0,
    // Reset period
    resetPeriod: row.resetPeriod || 'monthly',
    customResetDays: row.customResetDays,
    resetAt: row.resetAt,
    // Scope
    scopeType: row.scopeType || 'global',
    allowedModels,
    allowedCombos,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);

  const now = new Date();
  const createdAt = now.toISOString();
  const updatedAt = createdAt;

  // Calculate initial resetAt based on resetPeriod
  const resetPeriod = options.resetPeriod || 'monthly';
  let resetAt = null;

  if (resetPeriod === 'daily') {
    resetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  } else if (resetPeriod === 'monthly') {
    const next = new Date(now);
    next.setMonth(next.getMonth() + 1);
    resetAt = next.toISOString();
  } else if (resetPeriod === 'custom' && options.customResetDays) {
    resetAt = new Date(now.getTime() + options.customResetDays * 24 * 60 * 60 * 1000).toISOString();
  }
  // If 'never', resetAt remains null

  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt,
    updatedAt,
    // Limits
    tokenLimit: options.tokenLimit !== undefined ? options.tokenLimit : null,
    requestLimit: options.requestLimit !== undefined ? options.requestLimit : null,
    tokensUsed: 0,
    requestsUsed: 0,
    // Reset period
    resetPeriod,
    customResetDays: options.customResetDays || null,
    resetAt,
    // Scope
    scopeType: options.scopeType || 'global',
    allowedModels: options.allowedModels ? JSON.stringify(options.allowedModels) : null,
    allowedCombos: options.allowedCombos ? JSON.stringify(options.allowedCombos) : null,
  };

  db.run(
    `INSERT INTO apiKeys(
      id, key, name, machineId, isActive, createdAt, updatedAt,
      tokenLimit, requestLimit, tokensUsed, requestsUsed,
      resetPeriod, customResetDays, resetAt,
      scopeType, allowedModels, allowedCombos
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.updatedAt,
      apiKey.tokenLimit, apiKey.requestLimit, apiKey.tokensUsed, apiKey.requestsUsed,
      apiKey.resetPeriod, apiKey.customResetDays, apiKey.resetAt,
      apiKey.scopeType, apiKey.allowedModels, apiKey.allowedCombos,
    ]
  );

  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;

    const merged = { ...rowToKey(row), ...data };
    const now = new Date();
    merged.updatedAt = now.toISOString();

    // Recalculate resetAt if resetPeriod or customResetDays changed
    if (data.resetPeriod !== undefined || data.customResetDays !== undefined) {
      const resetPeriod = merged.resetPeriod || 'monthly';
      let resetAt = null;

      if (resetPeriod === 'daily') {
        resetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      } else if (resetPeriod === 'monthly') {
        const next = new Date(now);
        next.setMonth(next.getMonth() + 1);
        resetAt = next.toISOString();
      } else if (resetPeriod === 'custom' && merged.customResetDays) {
        resetAt = new Date(now.getTime() + merged.customResetDays * 24 * 60 * 60 * 1000).toISOString();
      }
      // If 'never', resetAt remains null

      merged.resetAt = resetAt;
    }

    // Stringify JSON fields if they were updated
    const allowedModels = merged.allowedModels !== undefined
      ? (Array.isArray(merged.allowedModels) ? JSON.stringify(merged.allowedModels) : merged.allowedModels)
      : row.allowedModels;

    const allowedCombos = merged.allowedCombos !== undefined
      ? (Array.isArray(merged.allowedCombos) ? JSON.stringify(merged.allowedCombos) : merged.allowedCombos)
      : row.allowedCombos;

    db.run(
      `UPDATE apiKeys SET
        name = ?,
        isActive = ?,
        updatedAt = ?,
        tokenLimit = ?,
        requestLimit = ?,
        tokensUsed = ?,
        requestsUsed = ?,
        resetPeriod = ?,
        customResetDays = ?,
        resetAt = ?,
        scopeType = ?,
        allowedModels = ?,
        allowedCombos = ?
      WHERE id = ?`,
      [
        merged.name,
        merged.isActive ? 1 : 0,
        merged.updatedAt,
        merged.tokenLimit,
        merged.requestLimit,
        merged.tokensUsed,
        merged.requestsUsed,
        merged.resetPeriod,
        merged.customResetDays,
        merged.resetAt,
        merged.scopeType,
        allowedModels,
        allowedCombos,
        id,
      ]
    );

    result = merged;
  });

  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
