/**
 * Auth provider — Quest 05 Part 1c route guard.
 *
 * Owns the three-state session machine (loading → authenticated |
 * unauthenticated). On boot it performs one silent cookie refresh: the
 * httpOnly cookie may hold a live session from a previous visit, and the
 * dashboard must reappear without a sign-in round-trip whenever it does.
 * Any authed request that cannot recover via the client's auto-refresh
 * flips the state back to unauthenticated, which is what redirects the
 * person to sign-in (the "route guard" — no router library needed).
 */
import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import {
  AuthUser,
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  logoutAll as apiLogoutAll,
} from "../api/auth";
import { onSessionEnded, refreshAccessToken } from "../api/client";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  setUser: (user: AuthUser | null) => void;
  signIn: (email: string, password: string, remember: boolean) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  signOutAll: () => Promise<number>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  // Boot: decide the initial state from the cookie, exactly once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await refreshAccessToken();
      if (cancelled) return;
      if (!ok) {
        setStatus("unauthenticated");
        return;
      }
      try {
        const me = await fetchMe();
        if (cancelled) return;
        setUser(me);
        setStatus("authenticated");
      } catch {
        setStatus("unauthenticated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Any unrecoverable 401 (dead session, revoked elsewhere) returns the
  // person to sign-in from wherever they were.
  useEffect(
    () =>
      onSessionEnded(() => {
        setUser(null);
        setStatus("unauthenticated");
      }),
    []
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      setUser,
      signIn: async (email, password, remember) => {
        const u = await apiLogin(email, password, remember);
        setUser(u);
        setStatus("authenticated");
        return u;
      },
      signOut: async () => {
        await apiLogout();
        setUser(null);
        setStatus("unauthenticated");
      },
      signOutAll: async () => {
        const revoked = await apiLogoutAll();
        setUser(null);
        setStatus("unauthenticated");
        return revoked;
      },
    }),
    [status, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
