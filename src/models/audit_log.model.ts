export interface AuditLogEntry {
  audit_id?: number;
  org_id?: string; // Quest 02: mandatory for tenant-scoped entries; nullable for infrastructure-level entries (BATCH, PIPELINE_STAGE)
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
}
