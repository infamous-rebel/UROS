import { UserRole } from "../../models/user.model";

export interface AuthenticatedUser {
  user_id: string;
  org_id: string;
  role: UserRole;
  /** Present only on session-bound tokens (human login). Absent on service tokens. */
  session_id?: string;
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
