import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

function formatZodError(err: ZodError) {
  return err.errors.map((e) => ({
    path: e.path.join("."),
    message: e.message,
    code: e.code,
  }));
}

/**
 * Validates req.body / req.query / req.params against provided zod schemas.
 * On success, replaces req.<part> with the parsed (typed, coerced) value.
 * On failure, responds 400 with a detailed, field-level error list.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query) as any;
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as any;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: "Validation failed",
          details: formatZodError(err),
        });
        return;
      }
      next(err);
    }
  };
}
