export type GateStatus = "PENDING" | "RESOLVED";

export interface GateEvent {
  gate_id: string;
  batch_id: string;
  gate_type: string;
  status: GateStatus;
  payload: unknown;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}
