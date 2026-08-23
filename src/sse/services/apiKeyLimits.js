/**
 * API Key Rate Limiting and Scope Control
 *
 * Handles:
 * - Token and request limits
 * - Model/combo access restrictions
 * - Usage tracking and reset
 */

import { getAdapter } from "@/lib/db/driver.js";
import * as log from "../utils/logger.js";

/**
 * Get API key record from database
 */
export async function getApiKeyRecord(apiKey) {
  if (!apiKey) return null;

  try {
    const db = await getAdapter();
    const record = db.get(
      "SELECT * FROM apiKeys WHERE key = ? AND isActive = 1",
      [apiKey]
    );

    return record;
  } catch (error) {
    log.error("API_KEY_LIMITS", "Failed to get API key record", { error: error.message });
    return null;
  }
}

/**
 * Check if reset is needed and reset counters if necessary
 */
async function checkAndResetUsage(record) {
  if (!record) return record;

  const now = Date.now();
  const resetAt = record.resetAt ? new Date(record.resetAt).getTime() : null;

  // No reset needed if resetPeriod is 'never' or resetAt not reached
  if (record.resetPeriod === 'never' || !resetAt || now < resetAt) {
    return record;
  }

  // Reset usage counters
  try {
    const db = await getAdapter();

    // Calculate next reset timestamp
    let nextResetAt;
    if (record.resetPeriod === 'daily') {
      nextResetAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    } else if (record.resetPeriod === 'monthly') {
      const next = new Date(now);
      next.setMonth(next.getMonth() + 1);
      nextResetAt = next.toISOString();
    } else if (record.resetPeriod === 'custom' && record.customResetDays) {
      nextResetAt = new Date(now + record.customResetDays * 24 * 60 * 60 * 1000).toISOString();
    } else {
      // Default to monthly
      const next = new Date(now);
      next.setMonth(next.getMonth() + 1);
      nextResetAt = next.toISOString();
    }

    db.run(`
      UPDATE apiKeys
      SET tokensUsed = 0, requestsUsed = 0, resetAt = ?, updatedAt = ?
      WHERE id = ?
    `, [nextResetAt, new Date(now).toISOString(), record.id]);

    log.info("API_KEY_LIMITS", `Reset usage for API key ${log.maskKey(record.key)}`, {
      nextResetAt,
      resetPeriod: record.resetPeriod
    });

    // Return updated record
    return {
      ...record,
      tokensUsed: 0,
      requestsUsed: 0,
      resetAt: nextResetAt
    };
  } catch (error) {
    log.error("API_KEY_LIMITS", "Failed to reset usage", { error: error.message });
    return record;
  }
}

/**
 * Validate API key scope - check if model/combo is allowed
 */
function validateScope(record, model) {
  if (!record || record.scopeType === 'global') {
    return { allowed: true };
  }

  // Restricted scope - check allowed models/combos
  const allowedModels = record.allowedModels ? JSON.parse(record.allowedModels) : [];
  const allowedCombos = record.allowedCombos ? JSON.parse(record.allowedCombos) : [];

  // Check if model is in allowed list
  const isAllowed = allowedModels.includes(model) || allowedCombos.includes(model);

  if (!isAllowed) {
    return {
      allowed: false,
      error: `Access denied: API key not authorized for model "${model}". Allowed: ${[...allowedModels, ...allowedCombos].join(', ') || 'none'}`
    };
  }

  return { allowed: true };
}

/**
 * Validate API key limits - check token and request limits
 */
function validateLimits(record) {
  if (!record) return { allowed: true };

  // Check request limit
  if (record.requestLimit !== null && record.requestsUsed >= record.requestLimit) {
    return {
      allowed: false,
      error: `Request limit exceeded: ${record.requestsUsed}/${record.requestLimit} requests used. ${record.resetAt ? `Resets at ${new Date(record.resetAt).toLocaleString()}` : 'No reset scheduled'}.`,
      limitType: 'request'
    };
  }

  // Check token limit
  if (record.tokenLimit !== null && record.tokensUsed >= record.tokenLimit) {
    return {
      allowed: false,
      error: `Token limit exceeded: ${record.tokensUsed}/${record.tokenLimit} tokens used. ${record.resetAt ? `Resets at ${new Date(record.resetAt).toLocaleString()}` : 'No reset scheduled'}.`,
      limitType: 'token'
    };
  }

  return { allowed: true };
}

/**
 * Validate API key against scope and limits
 * Returns { allowed: true } or { allowed: false, error: string }
 */
export async function validateApiKeyAccess(apiKey, model) {
  if (!apiKey) {
    return { allowed: true }; // No API key = local mode, no restrictions
  }

  const record = await getApiKeyRecord(apiKey);
  if (!record) {
    log.warn("API_KEY_LIMITS", "API key not found in database", { apiKey: log.maskKey(apiKey) });
    return { allowed: false, error: "Invalid API key" };
  }

  // Check and reset usage if needed
  const updatedRecord = await checkAndResetUsage(record);

  // Validate scope (model/combo restrictions)
  const scopeCheck = validateScope(updatedRecord, model);
  if (!scopeCheck.allowed) {
    log.warn("API_KEY_LIMITS", "Scope validation failed", {
      apiKey: log.maskKey(apiKey),
      model,
      error: scopeCheck.error
    });
    return scopeCheck;
  }

  // Validate limits (token and request limits)
  const limitsCheck = validateLimits(updatedRecord);
  if (!limitsCheck.allowed) {
    log.warn("API_KEY_LIMITS", "Limit validation failed", {
      apiKey: log.maskKey(apiKey),
      limitType: limitsCheck.limitType,
      error: limitsCheck.error
    });
    return limitsCheck;
  }

  log.debug("API_KEY_LIMITS", "Validation passed", {
    apiKey: log.maskKey(apiKey),
    model,
    tokensUsed: updatedRecord.tokensUsed,
    tokenLimit: updatedRecord.tokenLimit,
    requestsUsed: updatedRecord.requestsUsed,
    requestLimit: updatedRecord.requestLimit
  });

  return { allowed: true, record: updatedRecord };
}

/**
 * Track API key usage - increment counters
 */
export async function trackApiKeyUsage(apiKey, promptTokens = 0, completionTokens = 0) {
  if (!apiKey) return; // Local mode, no tracking

  const totalTokens = promptTokens + completionTokens;

  try {
    const db = await getAdapter();

    db.run(`
      UPDATE apiKeys
      SET
        tokensUsed = tokensUsed + ?,
        requestsUsed = requestsUsed + 1,
        updatedAt = ?
      WHERE key = ? AND isActive = 1
    `, [totalTokens, new Date().toISOString(), apiKey]);

    log.debug("API_KEY_LIMITS", "Usage tracked", {
      apiKey: log.maskKey(apiKey),
      promptTokens,
      completionTokens,
      totalTokens
    });
  } catch (error) {
    log.error("API_KEY_LIMITS", "Failed to track usage", {
      apiKey: log.maskKey(apiKey),
      error: error.message
    });
  }
}

/**
 * Initialize resetAt for API keys that don't have it set
 */
export async function initializeResetTimestamps() {
  try {
    const db = await getAdapter();
    const now = Date.now();

    // Get all API keys without resetAt
    const keys = db.all(
      "SELECT * FROM apiKeys WHERE resetAt IS NULL"
    );

    if (keys.length === 0) return;

    for (const key of keys) {
      let resetAt;

      if (key.resetPeriod === 'never') {
        resetAt = null;
      } else if (key.resetPeriod === 'daily') {
        resetAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
      } else if (key.resetPeriod === 'custom' && key.customResetDays) {
        resetAt = new Date(now + key.customResetDays * 24 * 60 * 60 * 1000).toISOString();
      } else {
        // Default to monthly
        const next = new Date(now);
        next.setMonth(next.getMonth() + 1);
        resetAt = next.toISOString();
      }

      if (resetAt) {
        db.run("UPDATE apiKeys SET resetAt = ? WHERE id = ?", [resetAt, key.id]);
      }
    }

    log.info("API_KEY_LIMITS", `Initialized resetAt for ${keys.length} API keys`);
  } catch (error) {
    log.error("API_KEY_LIMITS", "Failed to initialize reset timestamps", {
      error: error.message
    });
  }
}
