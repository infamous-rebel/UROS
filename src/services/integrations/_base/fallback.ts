/**
 * Fallback chain resolver.
 * Given an org and message type, returns the ordered list of providers
 * to try. Stored in integration_fallback_configs table (DB).
 *
 * Resolution order:
 * 1. DB config for (org, message_type) if it exists
 * 2. Empty array if no config — caller treats this as "no fallback available"
 */

import { db } from "../../../database/client";
import { logger } from "../../../utils/logger";

export interface FallbackChainEntry {
  config_id: string;
  org_id: string;
  message_type: string;
  provider_order: string[];
}

/**
 * Resolve the fallback chain for an org + message type.
 * Returns the ordered provider list from DB, or an empty array if none configured.
 */
export async function resolveFallbackChain(
  orgId: string,
  messageType: string
): Promise<string[]> {
  const res = await db.query<{ provider_order: unknown }>(
    `SELECT provider_order FROM integration_fallback_configs
     WHERE org_id=$1 AND message_type=$2`,
    [orgId, messageType.toUpperCase()]
  );

  if (res.rowCount === 0) {
    return [];
  }

  const order = res.rows[0].provider_order;
  if (!Array.isArray(order) || order.length === 0) {
    return [];
  }

  return order as string[];
}

/**
 * Set the fallback chain for an org + message type.
 * Upserts into integration_fallback_configs.
 */
export async function setFallbackChain(
  orgId: string,
  messageType: string,
  providerOrder: string[],
  actorUserId: string
): Promise<void> {
  if (providerOrder.length === 0) {
    throw new Error("Fallback chain must contain at least one provider");
  }

  await db.query(
    `INSERT INTO integration_fallback_configs (org_id, message_type, provider_order)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, message_type)
     DO UPDATE SET provider_order = $3, updated_at = now()`,
    [orgId, messageType.toUpperCase(), JSON.stringify(providerOrder)]
  );

  logger.info("FALLBACK_CHAIN_UPDATED", {
    org_id: orgId,
    message_type: messageType,
    provider_order: providerOrder,
    updated_by: actorUserId,
  });
}

/**
 * Get the fallback chain config row for an org + message type.
 * Returns null if not configured.
 */
export async function getFallbackConfig(
  orgId: string,
  messageType: string
): Promise<FallbackChainEntry | null> {
  const res = await db.query<{
    config_id: string;
    org_id: string;
    message_type: string;
    provider_order: unknown;
  }>(
    `SELECT config_id, org_id, message_type, provider_order
     FROM integration_fallback_configs
     WHERE org_id=$1 AND message_type=$2`,
    [orgId, messageType.toUpperCase()]
  );

  if (res.rowCount === 0) return null;

  const row = res.rows[0];
  return {
    config_id: row.config_id,
    org_id: row.org_id,
    message_type: row.message_type,
    provider_order: row.provider_order as string[],
  };
}
