import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { createRateLimiter } from "../middleware/rate_limit";
import { getTranslations, SUPPORTED_LANGUAGES } from "../../services/i18n/translations";

const router = Router();

const translationsRateLimit = createRateLimiter("i18n_translations", 120, 60_000);

const TranslationsQuerySchema = z.object({
  lang: z.enum(SUPPORTED_LANGUAGES).default("en"),
});

/**
 * GET /api/v1/i18n/translations?lang=en|bn
 *
 * Deliberately public (no `authenticate`): both the staff dashboard's
 * pre-login shell and the applicant portal's login screen need UI
 * labels before any JWT exists. Returns a static, deterministic
 * translation map — never generated at request time, never LLM-backed
 * (BYOK_Requirement.md: no external AI service required for this
 * feature). Any key missing from the requested language's dictionary is
 * already backfilled from English by `getTranslations` itself, so the
 * response is always a complete map.
 */
router.get(
  "/translations",
  translationsRateLimit,
  validate({ query: TranslationsQuerySchema }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { lang } = req.query as unknown as z.infer<typeof TranslationsQuerySchema>;
      res.status(200).json({ language: lang, translations: getTranslations(lang) });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
