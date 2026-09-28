import { Request, Response, NextFunction } from "express";
import { UserRole } from "../../models/user.model";

/**
 * Restricts a route to the given roles. Must run after `authenticate`.
 * Usage: router.post('/rules', authenticate, rbac('ADMIN'), handler)
 */
export function rbac(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: "Forbidden",
        detail: `Role '${req.user.role}' is not permitted for this action`,
      });
      return;
    }
    next();
  };
}
