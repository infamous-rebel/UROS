/**
 * Quest 05 Part 5 — Intake routes.
 *
 * - POST /upload-cv       — accept a CV file (PDF/DOCX/image), create candidate in INTAKE
 * - POST /import-csv      — accept CSV with column mapping, batch-create candidates
 * - GET  /batches         — list recent import batches for the org
 * - GET  /email/unread    — list unread emails from IMAP (or mock)
 * - POST /email/import    — import a selected email as a candidate
 * - GET  /bdjobs/status   — Bdjobs scraper/import/webhook status
 * - GET  /teletalk/status — Teletalk SMS + CV Bank status
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import multer from "multer";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { runBatchIsolated } from "../../services/agent_runner/batch";
import { requireCredential, MissingCredentialError, getCredential } from "../../services/integrations/credential_store";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    const ok = /\.(pdf|docx|jpe?g|png|csv)$/.test(lower);
    if (ok) { cb(null, true); return; }
    cb(new Error(`Unsupported file: ${file.originalname}. Accepted: PDF, DOCX, JPG, PNG, CSV`));
  },
});

// ─── CV Upload ───────────────────────────────────────────────────────

/**
 * POST /api/v1/intake/upload-cv
 * Accepts a single CV file. Creates a candidate record in INTAKE status.
 * The parser_agent will later extract structured data from the file.
 */
router.post(
  "/upload-cv",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded. Accepted: PDF, DOCX, JPG, PNG." });
        return;
      }

      const candidateId = `CAND-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fileName = req.file.originalname;
      const fileSize = req.file.size;
      const mimeType = req.file.mimetype;

      // Store document reference (actual file storage would go to object store in prod)
      // Create candidate first (FK required for candidate_documents)
      await db.query(
        `INSERT INTO candidates (candidate_id, org_id, full_name, source_platform, status)
         VALUES ($1, $2, $3, $4, 'INTAKE')`,
        [candidateId, req.user!.org_id, `Pending: ${fileName}`, "CSV"]
      );

      await db.query(
        `INSERT INTO candidate_documents (candidate_id, doc_type, file_location)
         VALUES ($1, $2, $3)`,
        [candidateId, "CV", `memory://${candidateId}/${fileName}`]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "CANDIDATE",
        entity_id: candidateId,
        agent_or_user: req.user!.user_id,
        action: "CV_UPLOADED",
        output_value: { file_name: fileName, file_size: fileSize, mime_type: mimeType },
      });

      res.status(201).json({
        candidate_id: candidateId,
        file_name: fileName,
        file_size: fileSize,
        status: "INTAKE",
        message: `CV "${fileName}" received and queued for parsing.`,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── CSV Import ──────────────────────────────────────────────────────

const CsvImportSchema = z.object({
  circular_id: z.string().min(1),
  column_mapping: z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    phone: z.string().optional(),
    dob: z.string().optional(),
  }),
  rows: z.array(z.record(z.string())).min(1).max(500),
});

/**
 * POST /api/v1/intake/import-csv
 * Accepts parsed CSV rows with column mapping. Batch-creates candidates.
 */
router.post(
  "/import-csv",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ body: CsvImportSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circular_id, column_mapping, rows } = req.body as z.infer<typeof CsvImportSchema>;
      const batchId = `CSV-${circular_id}-${Date.now()}`;

      const applications = rows.map((row, i) => ({
        candidate_id: `CSV-${Date.now()}-${i}`,
        full_name: row[column_mapping.name] ?? `Unknown (${i + 1})`,
        email: column_mapping.email ? row[column_mapping.email] : undefined,
        phone_primary: column_mapping.phone ? row[column_mapping.phone] : undefined,
        date_of_birth: column_mapping.dob ? row[column_mapping.dob] : undefined,
      }));

      const result = await runBatchIsolated({
        agentName: "intake.csv_import",
        agentClass: "intake",
        items: applications,
        itemKey: (app) => app.candidate_id,
        actor: req.user!.user_id,
        request_id: req.requestId,
        entity_type: "BATCH",
        processItem: (app) =>
          db.query(
            `INSERT INTO candidates (candidate_id, org_id, full_name, source_platform, job_circular_id, status)
             VALUES ($1,$2,$3,'CSV',$4,'INTAKE')
             ON CONFLICT (candidate_id) DO NOTHING`,
            [app.candidate_id, req.user!.org_id, app.full_name, circular_id]
          ),
      });

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "BATCH",
        entity_id: batchId,
        agent_or_user: req.user!.user_id,
        action: "CSV_IMPORT_COMPLETED",
        output_value: { circular_id, total: rows.length, imported: result.ok, failed: result.failed },
      });

      await db.query(
        `INSERT INTO import_batches (batch_id, org_id, circular_id, source, status, total_items, imported, failed, requested_by, request_id)
         VALUES ($1,$2,$3,'CSV','ACCEPTED',$4,$5,$6,$7,$8)
         ON CONFLICT (batch_id) DO NOTHING`,
        [batchId, req.user!.org_id, circular_id, rows.length, result.ok, result.failed, req.user!.user_id, req.requestId]
      );

      res.status(202).json({
        batch_id: batchId,
        total: rows.length,
        imported: result.ok,
        failed: result.failed,
        failures: result.failures,
        status: "ACCEPTED",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Batch History ───────────────────────────────────────────────────

/**
 * GET /api/v1/intake/batches
 * List recent import batches for the org.
 */
router.get(
  "/batches",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await db.query(
        `SELECT batch_id, source, status, total_items, imported, failed, created_at
         FROM import_batches WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [req.user!.org_id]
      );
      res.status(200).json({ batches: result.rows });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Email Intake ────────────────────────────────────────────────────

/**
 * GET /api/v1/intake/email/unread
 * Returns a list of unread emails from the configured IMAP account.
 * Falls back to structured empty state when IMAP is not configured.
 */
router.get(
  "/email/unread",
  authenticate,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const cred = await getCredential(_req.user!.org_id, "email_imap");
      if (!cred) {
        res.status(200).json({
          emails: [],
          connected: false,
          message: "IMAP not configured. Add IMAP credentials in Settings \u2192 Integrations to connect your email inbox.",
        });
        return;
      }
      // IMAP is configured — try to list unread emails
      try {
        const emails = await fetchImapUnread(cred);
        res.status(200).json({ emails, connected: true });
      } catch (imapErr) {
        res.status(200).json({
          emails: [],
          connected: false,
          message: `IMAP connection failed: ${imapErr instanceof Error ? imapErr.message : String(imapErr)}`,
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/intake/email/fetch
 * Connects to IMAP, lists unread emails with optional attachment detection.
 */
router.post(
  "/email/fetch",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cred = await requireCredential(req.user!.org_id, "email_imap");
      const emails = await fetchImapUnread(cred);
      res.status(200).json({ emails, connected: true, count: emails.length });
    } catch (err) {
      if (err instanceof MissingCredentialError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/intake/email/import
 * Import a selected email as a candidate.
 */
const EmailImportSchema = z.object({
  message_id: z.string().min(1),
  circular_id: z.string().min(1),
});

router.post(
  "/email/import",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ body: EmailImportSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { message_id, circular_id } = req.body as z.infer<typeof EmailImportSchema>;
      const candidateId = `EMAIL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      await db.query(
        `INSERT INTO candidates (candidate_id, org_id, full_name, source_platform, job_circular_id, status)
         VALUES ($1,$2,$3,'Email',$4,'INTAKE')`,
        [candidateId, req.user!.org_id, `From email: ${message_id}`, circular_id]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "CANDIDATE",
        entity_id: candidateId,
        agent_or_user: req.user!.user_id,
        action: "EMAIL_IMPORT_COMPLETED",
        output_value: { message_id, circular_id },
      });

      res.status(201).json({
        candidate_id: candidateId,
        message_id,
        status: "INTAKE",
        message: `Email ${message_id} imported as candidate.`,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Bdjobs Session Scraper ──────────────────────────────────────────

/**
 * POST /api/v1/intake/bdjobs/scrape
 * Uses the bdjobs_scraper BYOK credential to fetch the applicant list
 * from the Bdjobs session endpoint. Parses the response and creates
 * candidate records for each applicant found.
 */
router.post(
  "/bdjobs/scrape",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cred = await requireCredential(req.user!.org_id, "bdjobs_scraper");
      const jobUrl = req.body?.job_url ?? cred.baseUrl;
      if (!jobUrl) {
        res.status(400).json({ error: "No job_url provided and no base_url on credential." });
        return;
      }

      // Fetch applicant list from Bdjobs (or mock)
      const fetchRes = await fetch(jobUrl, {
        headers: { Authorization: `Bearer ${cred.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!fetchRes.ok) {
        res.status(502).json({ error: `Bdjobs scraper returned ${fetchRes.status}` });
        return;
      }
      const data: any = await fetchRes.json();
      const applicants: Array<{ name: string; email?: string; phone?: string; cv_url?: string }> =
        Array.isArray(data) ? data : data.applicants ?? [];

      if (applicants.length === 0) {
        res.status(200).json({ scraped: 0, imported: 0, message: "No applicants found." });
        return;
      }

      const items = applicants.map((a, i) => ({
        candidate_id: `BDJ-${Date.now()}-${i}`,
        full_name: a.name ?? `Bdjobs Applicant ${i + 1}`,
        email: a.email,
        phone: a.phone,
        cv_url: a.cv_url,
      }));

      const result = await runBatchIsolated({
        agentName: "intake.bdjobs_scraper",
        agentClass: "intake",
        items,
        itemKey: (a) => a.candidate_id,
        actor: req.user!.user_id,
        request_id: req.requestId,
        entity_type: "BATCH",
        processItem: (a) =>
          db.query(
            `INSERT INTO candidates (candidate_id, org_id, full_name, email, phone_primary, source_platform, job_circular_id, status)
             VALUES ($1,$2,$3,$4,$5,'bdjobs',$6,'INTAKE')
             ON CONFLICT (candidate_id) DO NOTHING`,
            [a.candidate_id, req.user!.org_id, a.full_name, a.email ?? null, a.phone ?? null, `bdjobs-${Date.now()}`]
          ),
      });

      const batchId = `BDJ-${Date.now()}`;
      await db.query(
        `INSERT INTO import_batches (batch_id, org_id, circular_id, source, status, total_items, imported, failed, requested_by, request_id)
         VALUES ($1,$2,$3,'bdjobs','COMPLETED',$4,$5,$6,$7,$8)
         ON CONFLICT (batch_id) DO NOTHING`,
        [batchId, req.user!.org_id, `bdjobs-${Date.now()}`, items.length, result.ok, result.failed, req.user!.user_id, req.requestId]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "BATCH",
        entity_id: batchId,
        agent_or_user: req.user!.user_id,
        action: "BDJOBS_SCRAPE_COMPLETED",
        output_value: { scraped: applicants.length, imported: result.ok, failed: result.failed },
      });

      res.status(202).json({
        batch_id: batchId,
        scraped: applicants.length,
        imported: result.ok,
        failed: result.failed,
        status: "COMPLETED",
      });
    } catch (err) {
      if (err instanceof MissingCredentialError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── Bdjobs Email Intake ─────────────────────────────────────────────

/**
 * POST /api/v1/intake/bdjobs/email/fetch
 * Uses the bdjobs_email BYOK credential to fetch Bdjobs-format email
 * notifications and extract candidate applications.
 */
router.post(
  "/bdjobs/email/fetch",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cred = await requireCredential(req.user!.org_id, "bdjobs_email");
      if (!cred.baseUrl) {
        res.status(400).json({ error: "No base_url on bdjobs_email credential." });
        return;
      }
      const fetchUrl = cred.baseUrl;

      const fetchRes = await fetch(fetchUrl, {
        headers: { Authorization: `Bearer ${cred.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!fetchRes.ok) {
        res.status(502).json({ error: `Bdjobs email endpoint returned ${fetchRes.status}` });
        return;
      }
      const data: any = await fetchRes.json();
      const emails: Array<{ name: string; email?: string; phone?: string; message_id?: string }> =
        Array.isArray(data) ? data : data.emails ?? [];

      if (emails.length === 0) {
        res.status(200).json({ fetched: 0, imported: 0, message: "No Bdjobs email applications found." });
        return;
      }

      let imported = 0;
      const created: string[] = [];
      for (const em of emails) {
        const candidateId = `BDJEM-${Date.now()}-${imported}`;
        try {
          await db.query(
            `INSERT INTO candidates (candidate_id, org_id, full_name, email, phone_primary, source_platform, status)
             VALUES ($1,$2,$3,$4,$5,'bdjobs','INTAKE')`,
            [candidateId, req.user!.org_id, em.name, em.email ?? null, em.phone ?? null]
          );
          created.push(candidateId);
          imported++;
        } catch { /* skip duplicates */ }
      }

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "BATCH",
        entity_id: `BDJEM-${Date.now()}`,
        agent_or_user: req.user!.user_id,
        action: "BDJOBS_EMAIL_FETCH_COMPLETED",
        output_value: { fetched: emails.length, imported },
      });

      res.status(202).json({ fetched: emails.length, imported, candidates: created });
    } catch (err) {
      if (err instanceof MissingCredentialError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── Bdjobs Status ───────────────────────────────────────────────────

router.get(
  "/bdjobs/status",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check if bdjobs credentials are configured
      const credCheck = await db.query(
        `SELECT connector, active FROM api_credentials WHERE org_id=$1 AND connector = 'bdjobs'`,
        [req.user!.org_id]
      );
      res.status(200).json({
        configured: credCheck.rows.length > 0,
        connectors: credCheck.rows,
        message: credCheck.rows.length === 0
          ? "Bdjobs not connected. Add API credentials in Settings → Integrations."
          : `${credCheck.rows.length} Bdjobs connector(s) configured.`,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Teletalk CV Bank ────────────────────────────────────────────────

/**
 * POST /api/v1/intake/teletalk/cv-bank/fetch
 * Uses the teletalk_cv_bank BYOK credential to pull candidate CVs
 * from the Teletalk CV Bank API (or scraper fallback).
 */
router.post(
  "/teletalk/cv-bank/fetch",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cred = await requireCredential(req.user!.org_id, "teletalk_cv_bank");
      const fetchUrl = cred.baseUrl;
      if (!fetchUrl) {
        res.status(400).json({ error: "No base_url on teletalk_cv_bank credential." });
        return;
      }

      const fetchRes = await fetch(fetchUrl, {
        headers: { Authorization: `Bearer ${cred.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!fetchRes.ok) {
        res.status(502).json({ error: `Teletalk CV Bank returned ${fetchRes.status}` });
        return;
      }
      const data: any = await fetchRes.json();
      const records: Array<{ name: string; phone?: string; email?: string; cv_text?: string }> =
        Array.isArray(data) ? data : data.records ?? data.candidates ?? [];

      if (records.length === 0) {
        res.status(200).json({ fetched: 0, imported: 0, message: "No CV Bank records found." });
        return;
      }

      let imported = 0;
      const created: string[] = [];
      for (const rec of records) {
        const candidateId = `TEL-${Date.now()}-${imported}`;
        try {
          await db.query(
            `INSERT INTO candidates (candidate_id, org_id, full_name, phone_primary, email, source_platform, status)
             VALUES ($1,$2,$3,$4,$5,'Teletalk','INTAKE')`,
            [candidateId, req.user!.org_id, rec.name, rec.phone ?? null, rec.email ?? null]
          );
          created.push(candidateId);
          imported++;
        } catch { /* skip duplicates */ }
      }

      const batchId = `TEL-${Date.now()}`;
      await db.query(
        `INSERT INTO import_batches (batch_id, org_id, circular_id, source, status, total_items, imported, failed, requested_by, request_id)
         VALUES ($1,$2,$3,'Teletalk','COMPLETED',$4,$5,0,$6,$7)
         ON CONFLICT (batch_id) DO NOTHING`,
        [batchId, req.user!.org_id, `teletalk-cvbank-${Date.now()}`, records.length, imported, req.user!.user_id, req.requestId]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "BATCH",
        entity_id: batchId,
        agent_or_user: req.user!.user_id,
        action: "TELETALK_CVBANK_FETCH_COMPLETED",
        output_value: { fetched: records.length, imported },
      });

      res.status(202).json({
        batch_id: batchId,
        fetched: records.length,
        imported,
        candidates: created,
        status: "COMPLETED",
      });
    } catch (err) {
      if (err instanceof MissingCredentialError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── Teletalk Status ─────────────────────────────────────────────────

router.get(
  "/teletalk/status",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const credCheck = await db.query(
        `SELECT connector, active FROM api_credentials WHERE org_id=$1 AND connector = 'teletalk'`,
        [req.user!.org_id]
      );
      res.status(200).json({
        configured: credCheck.rows.length > 0,
        connectors: credCheck.rows,
        message: credCheck.rows.length === 0
          ? "Teletalk not connected. Add SMS provider and CV Bank credentials in Settings → Integrations."
          : `${credCheck.rows.length} Teletalk connector(s) configured.`,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

// ─── Email Fetch Helpers ─────────────────────────────────────────────

interface EmailMessage {
  message_id: string;
  from: string;
  subject: string;
  date: string;
  has_attachment: boolean;
  attachment_names: string[];
}

/**
 * Fetches unread emails. Detects the transport from the credential baseUrl:
 * - http:// → uses Mailpit HTTP API
 * - imap:// → uses IMAP via imapflow
 */
async function fetchImapUnread(cred: { apiKey: string; baseUrl: string | null }): Promise<EmailMessage[]> {
  if (cred.baseUrl && /^https?:\/\//.test(cred.baseUrl)) {
    return fetchMailpitUnread(cred.baseUrl);
  }
  return fetchImapUnreadReal(cred);
}

/**
 * Fetches unread messages from a Mailpit instance via its HTTP API.
 */
async function fetchMailpitUnread(apiBase: string): Promise<EmailMessage[]> {
  const res = await fetch(`${apiBase}/api/v1/messages`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Mailpit API returned ${res.status}`);
  const data: any = await res.json();
  const messages = data.messages ?? [];
  return messages.map((m: any) => {
    const attachCount = typeof m.Attachments === "number" ? m.Attachments : 0;
    return {
      message_id: m.MessageID ?? m.ID,
      from: m.From?.Address ?? "unknown",
      subject: m.Subject ?? "(no subject)",
      date: m.Created ?? new Date().toISOString(),
      has_attachment: attachCount > 0,
      attachment_names: attachCount > 0 ? [`${attachCount} attachment(s)`] : [],
    };
  });
}

/**
 * Fetches unread emails via IMAP using imapflow.
 */
async function fetchImapUnreadReal(cred: { apiKey: string; baseUrl: string | null }): Promise<EmailMessage[]> {
  const { ImapFlow } = await import("imapflow" as string);

  let host = "localhost";
  let port = 1143;
  let user = "test";
  let pass = cred.apiKey;

  if (cred.baseUrl) {
    try {
      const url = new URL(cred.baseUrl.startsWith("imap") ? cred.baseUrl : `imap://${cred.baseUrl}`);
      host = url.hostname;
      port = parseInt(url.port || "1143", 10);
      if (url.username) user = decodeURIComponent(url.username);
      if (url.password) pass = decodeURIComponent(url.password);
    } catch { /* use defaults */ }
  }

  if (cred.apiKey.includes(":")) {
    const parts = cred.apiKey.split(":");
    user = parts[0];
    pass = parts.slice(1).join(":");
  }

  const client = new ImapFlow({
    host, port,
    auth: { user, pass },
    secure: false,
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const messages = await client.search({ seen: false });
      if (messages.size === 0) return [];

      const emails: EmailMessage[] = [];
      const fetchRange = [...messages].slice(0, 50);
      for (const seqNum of fetchRange) {
        const msg = await client.fetchOne(String(seqNum), {
          envelope: true,
          headers: ["message-id", "from", "subject", "date"],
          struct: true,
        });
        emails.push({
          message_id: msg.envelope?.messageId ?? `<msg-${seqNum}@imap>`,
          from: msg.envelope?.from?.[0]?.address ?? "unknown",
          subject: msg.envelope?.subject ?? "(no subject)",
          date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          has_attachment: hasAttachmentsInStruct(msg.struct),
          attachment_names: getAttachmentNames(msg.struct),
        });
      }
      return emails;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

function hasAttachmentsInStruct(struct: any): boolean {
  if (!struct) return false;
  if (struct.disposition === "attachment" || struct.disposition === "inline") return true;
  if (Array.isArray(struct)) return struct.some((s: any) => hasAttachmentsInStruct(s));
  return false;
}

function getAttachmentNames(struct: any): string[] {
  if (!struct) return [];
  const names: string[] = [];
  if (struct.disposition === "attachment" && struct.filename) {
    names.push(struct.filename);
  }
  if (Array.isArray(struct)) {
    for (const s of struct) {
      names.push(...getAttachmentNames(s));
    }
  }
  return names;
}
