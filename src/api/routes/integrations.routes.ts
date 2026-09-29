/**
 * Integration administration routes — provider registry, fallback chains,
 * resilience status, and live provider tests. Consumed by the Settings →
 * Integrations and Settings → Fallback Chains panels (Quest 05 UI).
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { CONNECTOR_TO_ADAPTER, listAllProviders, resolveConnectorName, getProvider } from "../../services/integrations/_base/registry";
import { getFallbackConfig, setFallbackChain } from "../../services/integrations/_base/fallback";
import { getAllCircuitStates } from "../../services/integrations/_base/circuit_breaker";
import { getAllRateLimitStates } from "../../services/integrations/_base/rate_limit";
import { requireCredential } from "../../services/integrations/credential_store";
import { logAudit } from "../../utils/audit_helper";

const router = Router();

const MessageTypeSchema = z.enum(["SMS", "EMAIL", "WHATSAPP"]);

/**
 * GET /api/v1/integrations/providers
 * Every registered (category, provider) adapter with its DB connector
 * mapping — the Integrations panel's catalog.
 */
router.get(
  "/providers",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const registered = listAllProviders();
      const providers = Object.entries(CONNECTOR_TO_ADAPTER).map(([connector, mapping]) => ({
        connector,
        category: mapping.category,
        provider: mapping.provider,
        registered: registered.some((r) => r.category === mapping.category && r.provider === mapping.provider),
      }));
      res.json({ providers });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/integrations/fallback/:messageType
 * The org's ordered fallback chain for a message type.
 */
router.get(
  "/fallback/:messageType",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ params: z.object({ messageType: MessageTypeSchema }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const messageType = MessageTypeSchema.parse(req.params.messageType);
      const config = await getFallbackConfig(req.user!.org_id, messageType);
      res.json({
        message_type: messageType,
        provider_order: config?.provider_order ?? [],
        configured: config !== null,
      });
    } catch (err) {
      next(err);
    }
  }
);

const FallbackBodySchema = z.object({
  provider_order: z.array(z.string().min(1)).min(1).max(10),
});

/**
 * PUT /api/v1/integrations/fallback/:messageType
 * Sets the ordered fallback chain. ADMIN only. Every entry must resolve
 * to a known connector (registry mapping or legacy message connector).
 */
router.put(
  "/fallback/:messageType",
  authenticate,
  rbac("ADMIN"),
  validate({ params: z.object({ messageType: MessageTypeSchema }), body: FallbackBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const messageType = MessageTypeSchema.parse(req.params.messageType);
      const { provider_order } = req.body as z.infer<typeof FallbackBodySchema>;

      const LEGACY_MESSAGE_CONNECTORS = ["sms_provider", "email", "whatsapp_business"];
      const unknown = provider_order.filter(
        (c) => !resolveConnectorName(c) && !LEGACY_MESSAGE_CONNECTORS.includes(c)
      );
      if (unknown.length > 0) {
        res.status(400).json({ error: `Unknown connector(s): ${unknown.join(", ")}` });
        return;
      }

      await setFallbackChain(req.user!.org_id, messageType, provider_order, req.user!.user_id);
      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "INTEGRATION",
        entity_id: `fallback:${messageType}`,
        agent_or_user: req.user!.user_id,
        action: "FALLBACK_CHAIN_SET",
        output_value: { message_type: messageType, provider_order },
      });
      res.json({ message_type: messageType, provider_order });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/integrations/status
 * Circuit breaker + rate limit snapshots for the org's providers
 * (in-memory state of this API process).
 */
router.get(
  "/status",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.org_id;
      res.json({
        circuits: getAllCircuitStates().filter((c) => c.org_id === orgId),
        rate_limits: getAllRateLimitStates().filter((r) => r.org_id === orgId),
      });
    } catch (err) {
      next(err);
    }
  }
);

const TestBodySchema = z.object({
  connector: z.string().min(1),
});

/**
 * POST /api/v1/integrations/test
 * Live provider test (Settings "Test" button): resolves the org's BYOK
 * credential for the connector and runs the adapter's healthCheck. Never
 * returns the credential; the audit trail records the probe.
 */
router.post(
  "/test",
  authenticate,
  rbac("ADMIN"),
  validate({ body: TestBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connector } = req.body as z.infer<typeof TestBodySchema>;
      const orgId = req.user!.org_id;
      const mapping = resolveConnectorName(connector);
      if (!mapping) {
        res.status(400).json({ error: `Connector '${connector}' has no adapter mapping.` });
        return;
      }
      const adapter = getProvider(mapping.category, mapping.provider);
      if (!adapter) {
        res.status(500).json({ error: `Adapter '${mapping.category}:${mapping.provider}' is not registered.` });
        return;
      }
      let healthy: boolean;
      try {
        const cred = await requireCredential(orgId, connector as never);
        healthy = await adapter.healthCheck({ apiKey: cred.apiKey, baseUrl: cred.baseUrl, orgId });
      } catch (err) {
        await logAudit({
          org_id: orgId,
          entity_type: "INTEGRATION",
          entity_id: connector,
          agent_or_user: req.user!.user_id,
          action: "INTEGRATION_TEST_FAILED",
          reason_code: "CREDENTIAL_ERROR",
          reason_comment: err instanceof Error ? err.message : String(err),
          output_value: { connector },
        });
        res.status(409).json({
          healthy: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      await logAudit({
        org_id: orgId,
        entity_type: "INTEGRATION",
        entity_id: connector,
        agent_or_user: req.user!.user_id,
        action: "INTEGRATION_TEST_RUN",
        output_value: { connector, healthy },
      });
      res.json({ healthy });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
