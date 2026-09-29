/**
 * Typed credential resolution for the new adapter architecture.
 * Wraps the existing credential_store.ts with typed config resolution.
 *
 * Every adapter receives its config from this module — never directly
 * from credential_store. This ensures a consistent MissingCredentialError
 * on misconfiguration (never silent fallback to mock/defaults).
 */

import { requireCredential, getCredential, MissingCredentialError } from "../credential_store";
import { ProviderCredentialError } from "./types";
import { resolveConnectorName } from "./registry";

export { MissingCredentialError };

/**
 * Resolve a connector name to its adapter's credentials.
 * Throws ProviderCredentialError if the credential is missing or malformed.
 *
 * @param orgId - The organization requesting the credential
 * @param connectorName - The DB connector name (e.g. "sms_teletalk")
 * @param label - Optional credential label (default: "default")
 */
export async function resolveAdapterCredential(
  orgId: string,
  connectorName: string,
  label: string = "default"
): Promise<{ apiKey: string; baseUrl: string | null }> {
  const mapping = resolveConnectorName(connectorName);
  if (!mapping) {
    throw new ProviderCredentialError(
      connectorName,
      orgId,
      `Unknown connector name '${connectorName}'. Not found in CONNECTOR_TO_ADAPTER map.`
    );
  }

  try {
    return await requireCredential(orgId, connectorName as any, label);
  } catch (err) {
    if (err instanceof MissingCredentialError) {
      throw new ProviderCredentialError(
        connectorName,
        orgId,
        `No active '${connectorName}' credential configured for org ${orgId}. ` +
          `Configure it via BYOK settings (label: '${label}').`
      );
    }
    throw err;
  }
}

/**
 * Check if a connector has credentials configured for an org.
 * Returns true if credentials exist, false otherwise.
 * Does NOT throw — used for capability checks before attempting send.
 */
export async function hasCredential(
  orgId: string,
  connectorName: string,
  label: string = "default"
): Promise<boolean> {
  const cred = await getCredential(orgId, connectorName as any, label);
  return cred !== null;
}
