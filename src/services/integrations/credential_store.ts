import { db } from "../../database/client";
import { encryptSecret, decryptSecret, maskSecret } from "../../utils/encryption";
import { logAudit } from "../../utils/audit_helper";
import { ApiCredential, ConnectorName } from "../../models/api_credential.model";

export interface ResolvedCredential {
  apiKey: string;
  baseUrl: string | null;
}

export interface CredentialListItem {
  credential_id: string;
  connector: ConnectorName;
  label: string;
  masked_key: string;
  base_url: string | null;
  status: "ACTIVE" | "REVOKED";
  budget_cap: number | null;
  budget_used: number;
  created_at: string;
  rotated_at: string | null;
}

/**
 * BYOK: stores an org-provided connector credential encrypted at rest.
 * Never logs the plaintext key — only metadata (connector, label, actor).
 * Computes a display-safe `key_hint` once, at write time, so listing
 * credentials never requires decrypting them.
 */
export async function storeCredential(
  orgId: string,
  connector: ConnectorName,
  plaintextKey: string,
  actorUserId: string,
  opts: { label?: string; baseUrl?: string; budgetCap?: number | null } = {}
): Promise<string> {
  const label = opts.label ?? "default";
  const { encrypted_value, iv, auth_tag } = encryptSecret(plaintextKey);
  const keyHint = maskSecret(plaintextKey);

  // Deactivate any prior active credential with the same label before inserting
  // the new one (rotation), so the unique partial index never collides.
  await db.query(
    `UPDATE api_credentials SET active=false, rotated_at=now()
     WHERE org_id=$1 AND connector=$2 AND label=$3 AND active=true`,
    [orgId, connector, label]
  );

  const result = await db.query<{ credential_id: string }>(
    `INSERT INTO api_credentials
      (org_id, connector, label, encrypted_value, iv, auth_tag, base_url, key_hint, budget_cap, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING credential_id`,
    [orgId, connector, label, encrypted_value, iv, auth_tag, opts.baseUrl ?? null, keyHint, opts.budgetCap ?? null, actorUserId]
  );

  await logAudit({
    entity_type: "API_CREDENTIAL",
    entity_id: result.rows[0].credential_id,
    agent_or_user: actorUserId,
    action: "CREDENTIAL_STORED",
    output_value: { connector, label }, // never the secret itself
  });

  return result.rows[0].credential_id;
}

/** Resolves and decrypts the active credential for an org+connector. */
export async function getCredential(
  orgId: string,
  connector: ConnectorName,
  label: string = "default"
): Promise<ResolvedCredential | null> {
  const res = await db.query<ApiCredential>(
    `SELECT * FROM api_credentials WHERE org_id=$1 AND connector=$2 AND label=$3 AND active=true`,
    [orgId, connector, label]
  );
  if (res.rowCount === 0) return null;

  const cred = res.rows[0];
  const apiKey = decryptSecret({
    encrypted_value: cred.encrypted_value,
    iv: cred.iv,
    auth_tag: cred.auth_tag,
  });

  return { apiKey, baseUrl: cred.base_url };
}

/** Lists an org's credentials with masked keys — never decrypts. */
export async function listCredentials(orgId: string): Promise<CredentialListItem[]> {
  const res = await db.query(
    `SELECT credential_id, connector, label, key_hint, base_url, active,
            budget_cap, budget_used, created_at, rotated_at
     FROM api_credentials
     WHERE org_id=$1
     ORDER BY created_at DESC`,
    [orgId]
  );
  return res.rows.map((row: any) => ({
    credential_id: row.credential_id,
    connector: row.connector,
    label: row.label,
    masked_key: row.key_hint ?? "********",
    base_url: row.base_url,
    status: row.active ? "ACTIVE" : "REVOKED",
    budget_cap: row.budget_cap !== null ? Number(row.budget_cap) : null,
    budget_used: Number(row.budget_used),
    created_at: row.created_at,
    rotated_at: row.rotated_at,
  }));
}

export interface UpdateCredentialOpts {
  newPlaintextKey?: string;
  budgetCap?: number | null;
  active?: boolean;
}

/**
 * Updates a credential in place: rotates the key (re-encrypt + new hint)
 * and/or adjusts budget_cap and/or active flag. Never logs the new key.
 */
export async function updateCredential(
  orgId: string,
  credentialId: string,
  actorUserId: string,
  opts: UpdateCredentialOpts
): Promise<CredentialListItem> {
  const existingRes = await db.query<ApiCredential>(
    `SELECT * FROM api_credentials WHERE credential_id=$1 AND org_id=$2`,
    [credentialId, orgId]
  );
  if (existingRes.rowCount === 0) {
    throw new Error(`Credential not found: ${credentialId}`);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  const auditChangedFields: string[] = [];

  if (opts.newPlaintextKey) {
    const { encrypted_value, iv, auth_tag } = encryptSecret(opts.newPlaintextKey);
    const keyHint = maskSecret(opts.newPlaintextKey);
    params.push(encrypted_value); setClauses.push(`encrypted_value = $${params.length}`);
    params.push(iv); setClauses.push(`iv = $${params.length}`);
    params.push(auth_tag); setClauses.push(`auth_tag = $${params.length}`);
    params.push(keyHint); setClauses.push(`key_hint = $${params.length}`);
    setClauses.push(`rotated_at = now()`);
    auditChangedFields.push("key");
  }
  if (opts.budgetCap !== undefined) {
    params.push(opts.budgetCap); setClauses.push(`budget_cap = $${params.length}`);
    auditChangedFields.push("budget_cap");
  }
  if (opts.active !== undefined) {
    params.push(opts.active); setClauses.push(`active = $${params.length}`);
    auditChangedFields.push("active");
  }

  if (setClauses.length === 0) {
    throw new Error("No fields provided to update");
  }

  params.push(credentialId);
  params.push(orgId);

  const updated = await db.query(
    `UPDATE api_credentials SET ${setClauses.join(", ")}
     WHERE credential_id=$${params.length - 1} AND org_id=$${params.length}
     RETURNING credential_id, connector, label, key_hint, base_url, active,
               budget_cap, budget_used, created_at, rotated_at`,
    params
  );

  await logAudit({
    entity_type: "API_CREDENTIAL",
    entity_id: credentialId,
    agent_or_user: actorUserId,
    action: "CREDENTIAL_UPDATED",
    output_value: { connector: existingRes.rows[0].connector, fields_changed: auditChangedFields }, // never the key
  });

  const row: any = updated.rows[0];
  return {
    credential_id: row.credential_id,
    connector: row.connector,
    label: row.label,
    masked_key: row.key_hint ?? "********",
    base_url: row.base_url,
    status: row.active ? "ACTIVE" : "REVOKED",
    budget_cap: row.budget_cap !== null ? Number(row.budget_cap) : null,
    budget_used: Number(row.budget_used),
    created_at: row.created_at,
    rotated_at: row.rotated_at,
  };
}

/** Soft-revokes a credential (never hard-deletes — preserves audit history). */
export async function revokeCredential(orgId: string, credentialId: string, actorUserId: string): Promise<void> {
  const existingRes = await db.query<ApiCredential>(
    `SELECT * FROM api_credentials WHERE credential_id=$1 AND org_id=$2`,
    [credentialId, orgId]
  );
  if (existingRes.rowCount === 0) {
    throw new Error(`Credential not found: ${credentialId}`);
  }

  await db.query(
    `UPDATE api_credentials SET active=false, rotated_at=now() WHERE credential_id=$1 AND org_id=$2`,
    [credentialId, orgId]
  );

  await logAudit({
    entity_type: "API_CREDENTIAL",
    entity_id: credentialId,
    agent_or_user: actorUserId,
    action: "CREDENTIAL_REVOKED",
    output_value: { connector: existingRes.rows[0].connector, label: existingRes.rows[0].label },
  });
}

export class MissingCredentialError extends Error {
  constructor(orgId: string, connector: ConnectorName) {
    super(`No active '${connector}' credential configured for org ${orgId}. Configure it via BYOK settings.`);
    this.name = "MissingCredentialError";
  }
}

export async function requireCredential(
  orgId: string,
  connector: ConnectorName,
  label: string = "default"
): Promise<ResolvedCredential> {
  const cred = await getCredential(orgId, connector, label);
  if (!cred) throw new MissingCredentialError(orgId, connector);
  return cred;
}
