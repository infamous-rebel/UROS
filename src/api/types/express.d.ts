import { UserRole } from "../../models/user.model";

export interface AuthenticatedUser {
  user_id: string;
  org_id: string;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      requestId?: string;
    }
  }
}

export {};
