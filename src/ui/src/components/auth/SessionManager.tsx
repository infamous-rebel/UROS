/**
 * SessionManager — Quest 05 Part 1c (Decision Lock 2: people can see and
 * revoke their own sessions; the cap of 5 is enforced server-side and
 * evictions surface here as revoked rows disappearing).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SessionEntry, fetchSessions, revokeSession } from "../../api/auth";
import { useAuth } from "../../auth/AuthContext";
import { useI18n } from "../../i18n";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function SessionManager() {
  const { t } = useI18n();
  const { signOutAll } = useAuth();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: fetchSessions,
    refetchInterval: 30_000,
  });

  const revoke = useMutation({
    mutationFn: (sessionId: string) => revokeSession(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] }),
  });

  if (sessionsQuery.isLoading) {
    return <p className="text-xs text-text-secondary">{t("status.checking")}</p>;
  }

  if (sessionsQuery.isError || !sessionsQuery.data) {
    return <p className="text-xs text-danger">{t("auth.errorNetwork")}</p>;
  }

  const sessions: SessionEntry[] = sessionsQuery.data.sessions;
  const others = sessions.filter((s) => !s.current);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-secondary">
        {sessions.length > 0 ? t("auth.sessionsCount").replace("{count}", String(sessions.length)) : t("auth.sessionsEmpty")}
      </p>

      <ul className="flex flex-col divide-y divide-border-soft rounded-lg border border-border-soft">
        {sessions.map((s) => (
          <li key={s.session_id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-primary">{formatWhen(s.created_at)}</span>
                {s.current && (
                  <span className="rounded-full border border-border-soft bg-background px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                    {t("auth.sessionsCurrent")}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {s.ip ?? "—"} · {s.user_agent ? s.user_agent.slice(0, 64) : "—"}
              </p>
              <p className="text-xs text-text-secondary">
                {t("auth.sessionsLastUsed")}: {formatWhen(s.last_used_at)}
              </p>
            </div>
            {!s.current && (
              <button
                onClick={() => revoke.mutate(s.session_id)}
                disabled={revoke.isPending}
                className="flex-shrink-0 rounded-md border border-border-soft px-3 py-1.5 text-xs text-danger hover:bg-background disabled:opacity-50"
              >
                {revoke.isPending ? t("auth.sessionsRevoking") : t("auth.sessionsRevoke")}
              </button>
            )}
          </li>
        ))}
      </ul>

      {others.length > 0 && (
        <button
          onClick={() => {
            void signOutAll();
          }}
          className="self-start rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10"
        >
          {t("auth.signOutEverywhere")}
        </button>
      )}
    </div>
  );
}
