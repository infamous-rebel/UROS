export interface AuditLogEntry {
  audit_id?: number;
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
