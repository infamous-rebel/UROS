export interface AuditLogEntry {
  audit_id?: number;
  org_id?: string; // Quest 02: mandatory for TENANT-scoped entries; null only when scope='SYSTEM'
  entity_type: string;
  entity_id: string;
  agent_or_user: string;
  action: string;
  rule_id?: string | null;
  input_value?: unknown;
  output_value?: unknown;
  reason_code?: string | null;
  reason_comment?: string | null;
  timestamp?: string;
  /** Quest 02: 'TENANT' (default) for org-scoped entries; 'SYSTEM' for infrastructure-level entries that lack org context. */
  scope?: "TENANT" | "SYSTEM";
}
