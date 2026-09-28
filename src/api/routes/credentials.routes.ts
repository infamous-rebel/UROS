import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import {
  storeCredential,
  listCredentials,
  updateCredential,
  revokeCredential,
} from "../../services/integrations/credential_store";

const router = Router();

const CONNECTOR_ENUM = z.enum([
  "teletalk", "bdjobs", "linkedin", "email",
  "sms_provider", "whatsapp_business", "calendar",
  "education_board", "cib", "police",
  "llm", // Groq-ready LLM connector (Quest 01)
]);

// Deliberately loose format check: connector API keys vary widely in shape
// (bearer tokens, app passwords, OAuth client secrets). We only reject the
// obviously wrong: empty, whitespace-only, or absurdly short values.
const KeyFormatSchema = z
  .string()
  .trim()
  .min(8, "API key must be at least 8 characters")
  .max(4096, "API key is too long")
  .refine((v) => !/\s/.test(v), "API key must not contain whitespace");

const CreateBodySchema = z.object({
  connector: CONNECTOR_ENUM,
  label: z.string().min(1).max(64).default("default"),
  api_key: KeyFormatSchema,
  base_url: z.string().url().optional(),
  budget_cap: z.number().positive().nullable().optional(),
});

const UpdateBodySchema = z
  .object({
    api_key: KeyFormatSchema.optional(),
    budget_cap: z.number().positive().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => data.api_key !== undefined || data.budget_cap !== undefined || data.active !== undefined, {
    message: "At least one of api_key, budget_cap, or active must be provided",
  });

const IdParamSchema = z.object({ id: z.string().uuid() });

/**
 * POST /api/v1/credentials
 * Stores a new BYOK connector credential, encrypted at rest. Never
 * returns or logs the plaintext key.
 */
router.post(
  "/",
  authenticate,
  rbac("ADMIN"),
  validate({ body: CreateBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connector, label, api_key, base_url, budget_cap } = req.body as z.infer<typeof CreateBodySchema>;

      const credentialId = await storeCredential(req.user!.org_id, connector, api_key, req.user!.user_id, {
        label,
        baseUrl: base_url,
        budgetCap: budget_cap ?? null,
      });

      res.status(201).json({ credential_id: credentialId, connector, label, status: "ACTIVE" });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/credentials
 * Lists the org's connector credentials with masked keys, budget, and status.
 */
router.get(
  "/",
  authenticate,
  rbac("ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const credentials = await listCredentials(req.user!.org_id);
      res.status(200).json({ credentials, count: credentials.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/v1/credentials/:id
 * Rotates the key and/or updates budget_cap and/or active flag.
 */
router.patch(
  "/:id",
  authenticate,
  rbac("ADMIN"),
  validate({ params: IdParamSchema, body: UpdateBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { api_key, budget_cap, active } = req.body as z.infer<typeof UpdateBodySchema>;

      const updated = await updateCredential(req.user!.org_id, id, req.user!.user_id, {
        newPlaintextKey: api_key,
        budgetCap: budget_cap,
        active,
      });

      res.status(200).json({ credential: updated });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Credential not found")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * DELETE /api/v1/credentials/:id
 * Revokes a credential. Soft-revoke (active=false), not a hard delete —
 * UROS preserves audit history for every credential ever configured.
 */
router.delete(
  "/:id",
  authenticate,
  rbac("ADMIN"),
  validate({ params: IdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      await revokeCredential(req.user!.org_id, id, req.user!.user_id);
      res.status(200).json({ credential_id: id, status: "REVOKED" });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Credential not found")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
