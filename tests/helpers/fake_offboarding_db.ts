/**
 * Minimal stateful in-memory fake for src/database/client.ts, scoped to
 * exactly the queries offboarding_agent/index.ts, offboarding.routes.ts,
 * and utils/audit_helper.ts issue. Dispatches on a normalized prefix of
 * the SQL text rather than parsing SQL — sufficient and honest for a
 * fixed, known query set. Mirrors tests/helpers/fake_reference_db.ts.
 */
export interface FakeOffboardingDbState {
  employees: any[];
  offboarding_templates: any[];
  offboarding_cases: any[];
  offboarding_steps: any[];
  audit_log: any[];
}

export function createFakeOffboardingDb() {
  const state: FakeOffboardingDbState = {
    employees: [],
    offboarding_templates: [],
    offboarding_cases: [],
    offboarding_steps: [],
    audit_log: [],
  };

  let templateSeq = 1;
  let caseSeq = 1;
  let stepSeq = 1;
  let auditSeq = 1;

  async function query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();

    // ---- employees ----
    if (sql.startsWith("SELECT employee_id, status FROM employees WHERE employee_id=$1 AND org_id=$2")) {
      const [employeeId, orgId] = params;
      const rows = state.employees
        .filter((e) => e.employee_id === employeeId && e.org_id === orgId)
        .map((e) => ({ employee_id: e.employee_id, status: e.status }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE employees SET status='OFFBOARDED', updated_at=now() WHERE employee_id=$1")) {
      const [employeeId] = params;
      const row = state.employees.find((e) => e.employee_id === employeeId);
      if (row) row.status = "OFFBOARDED";
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // ---- offboarding_templates ----
    if (sql.startsWith("SELECT template_id FROM offboarding_templates WHERE template_id=$1 AND org_id=$2")) {
      const [templateId, orgId] = params;
      const rows = state.offboarding_templates
        .filter((t) => t.template_id === templateId && t.org_id === orgId)
        .map((t) => ({ template_id: t.template_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE offboarding_templates SET role=$1, checklist=$2, updated_at=now()")) {
      const [role, checklistJson, templateId, orgId] = params;
      const row = state.offboarding_templates.find((t) => t.template_id === templateId && t.org_id === orgId);
      if (row) {
        row.role = role;
        row.checklist = JSON.parse(checklistJson);
        row.updated_at = new Date().toISOString();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO offboarding_templates (org_id, role, checklist, created_by)")) {
      const [orgId, role, checklistJson, createdBy] = params;
      const row = {
        template_id: `00000000-0000-0000-2001-${String(templateSeq++).padStart(12, "0")}`,
        org_id: orgId,
        role,
        checklist: JSON.parse(checklistJson),
        created_by: createdBy,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.offboarding_templates.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT template_id, checklist FROM offboarding_templates WHERE template_id=$1 AND org_id=$2")) {
      const [templateId, orgId] = params;
      const rows = state.offboarding_templates
        .filter((t) => t.template_id === templateId && t.org_id === orgId)
        .map((t) => ({ template_id: t.template_id, checklist: t.checklist }));
      return { rows, rowCount: rows.length };
    }

    // ---- offboarding_cases ----
    if (sql.startsWith("SELECT case_id FROM offboarding_cases WHERE employee_id=$1 AND status='ACTIVE'")) {
      const [employeeId] = params;
      const rows = state.offboarding_cases.filter((c) => c.employee_id === employeeId && c.status === "ACTIVE");
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO offboarding_cases (org_id, employee_id, template_id, status, exit_date, created_by)")) {
      const [orgId, employeeId, templateId, exitDate, createdBy] = params;
      const row = {
        case_id: `00000000-0000-0000-2002-${String(caseSeq++).padStart(12, "0")}`,
        org_id: orgId,
        employee_id: employeeId,
        template_id: templateId,
        status: "ACTIVE",
        exit_date: exitDate,
        created_by: createdBy,
        created_at: new Date().toISOString(),
      };
      state.offboarding_cases.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM offboarding_cases WHERE case_id=$1 AND org_id=$2")) {
      const [caseId, orgId] = params;
      const rows = state.offboarding_cases.filter((c) => c.case_id === caseId && c.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE offboarding_cases SET status='COMPLETED' WHERE case_id=$1")) {
      const [caseId] = params;
      const row = state.offboarding_cases.find((c) => c.case_id === caseId);
      if (row) row.status = "COMPLETED";
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // ---- offboarding_steps ----
    if (sql.startsWith("INSERT INTO offboarding_steps (case_id, item_code, title, category, assigned_to, due_date)")) {
      const [caseId, itemCode, title, category, assignedTo, dueDate] = params;
      const row = {
        step_id: `00000000-0000-0000-2003-${String(stepSeq++).padStart(12, "0")}`,
        case_id: caseId,
        item_code: itemCode,
        title,
        category,
        assigned_to: assignedTo,
        status: "PENDING",
        due_date: dueDate,
        completed_at: null,
        approved_by: null,
        approval_reason: null,
        evidence: {},
        created_at: new Date().toISOString(),
      };
      state.offboarding_steps.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM offboarding_steps WHERE case_id=$1 ORDER BY created_at ASC")) {
      const [caseId] = params;
      const rows = state.offboarding_steps
        .filter((s) => s.case_id === caseId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT s.*, c.case_id AS c_case_id")) {
      const [stepId, orgId] = params;
      const step = state.offboarding_steps.find((s) => s.step_id === stepId);
      if (!step) return { rows: [], rowCount: 0 };
      const caseRow = state.offboarding_cases.find((c) => c.case_id === step.case_id && c.org_id === orgId);
      if (!caseRow) return { rows: [], rowCount: 0 };
      const row = {
        ...step,
        c_case_id: caseRow.case_id,
        c_org_id: caseRow.org_id,
        c_employee_id: caseRow.employee_id,
        c_template_id: caseRow.template_id,
        c_status: caseRow.status,
        c_exit_date: caseRow.exit_date,
        c_created_by: caseRow.created_by,
        c_created_at: caseRow.created_at,
      };
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE offboarding_steps SET status='COMPLETED', completed_at=now(), evidence=$1 WHERE step_id=$2")) {
      const [evidenceJson, stepId] = params;
      const row = state.offboarding_steps.find((s) => s.step_id === stepId);
      if (row) {
        row.status = "COMPLETED";
        row.completed_at = new Date().toISOString();
        row.evidence = JSON.parse(evidenceJson);
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE offboarding_steps SET status=$1, approved_by=$2, approval_reason=$3, evidence=$4 WHERE step_id=$5")) {
      const [status, approvedBy, approvalReason, evidenceJson, stepId] = params;
      const row = state.offboarding_steps.find((s) => s.step_id === stepId);
      if (row) {
        row.status = status;
        row.approved_by = approvedBy;
        row.approval_reason = approvalReason;
        row.evidence = JSON.parse(evidenceJson);
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT status FROM offboarding_steps WHERE case_id=$1")) {
      const [caseId] = params;
      const rows = state.offboarding_steps.filter((s) => s.case_id === caseId).map((s) => ({ status: s.status }));
      return { rows, rowCount: rows.length };
    }

    // ---- audit ----
    if (sql.startsWith("INSERT INTO audit_log")) {
      state.audit_log.push({ id: auditSeq++, params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Fake offboarding DB: unhandled query: ${sql}`);
  }

  const fakeClient: { query: typeof query } = { query };

  return {
    state,
    db: {
      query,
      withTransaction: async <T>(fn: (client: typeof fakeClient) => Promise<T>): Promise<T> => fn(fakeClient),
    },
  };
}
