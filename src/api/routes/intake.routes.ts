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
 * In test/dev, returns an empty list with a helpful message.
 */
router.get(
  "/email/unread",
  authenticate,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // In production this would call the IMAP inbound service.
      // For now, return a structured empty state.
      res.status(200).json({
        emails: [],
        connected: false,
        message: "IMAP not configured. Add IMAP credentials in Settings \u2192 Integrations to connect your email inbox.",
      });
    } catch (err) {
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
