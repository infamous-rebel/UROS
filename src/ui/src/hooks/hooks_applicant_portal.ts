import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_V1 } from "../api/client";

/**
 * Deliberately independent of api/client.ts's `getToken`/`setToken`
 * (the staff dev-token session): an applicant's OTP-issued session must
 * never be confused with — or overwrite — a staff member's session in
 * the same browser. Stored in sessionStorage (survives a refresh within
 * the tab, cleared on tab close) rather than localStorage, since an
 * applicant session is short-lived (1 hour) and portal-only.
 */
const APPLICANT_TOKEN_KEY = "uros_applicant_portal_token";

export function getApplicantToken(): string | null {
  return sessionStorage.getItem(APPLICANT_TOKEN_KEY);
}

export function setApplicantToken(token: string): void {
  sessionStorage.setItem(APPLICANT_TOKEN_KEY, token);
}

export function clearApplicantToken(): void {
  sessionStorage.removeItem(APPLICANT_TOKEN_KEY);
}

class ApplicantPortalError extends Error {}

async function portalRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getApplicantToken();
  const res = await fetch(`${API_V1}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApplicantPortalError(body.error ?? `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useRequestOtp() {
  return useMutation({
    mutationFn: ({ candidateId, channel }: { candidateId: string; channel: "EMAIL" | "SMS" }) =>
      portalRequest<{ requested: boolean }>("/portal/otp/request", {
        method: "POST",
        body: JSON.stringify({ candidate_id: candidateId, channel }),
      }),
  });
}

export function useVerifyOtp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ candidateId, code }: { candidateId: string; code: string }) =>
      portalRequest<{ token: string; candidate_id: string; org_id: string }>("/portal/otp/verify", {
        method: "POST",
        body: JSON.stringify({ candidate_id: candidateId, code }),
      }),
    onSuccess: (data) => {
      setApplicantToken(data.token);
      qc.invalidateQueries({ queryKey: ["applicant-status"] });
    },
  });
}

export interface ApplicantReasonEntry {
  reason_code: string;
  reason_description: string;
  status: "FAIL" | "NEEDS_REVIEW" | "PASS";
  evidence: {
    rule_applied: string;
    field_path: string;
    extracted_value: unknown;
    confidence: number | null;
  };
  evaluated_at: string;
}

export interface ApplicantDocumentSummary {
  doc_type: string;
  verification_status: "Pending" | "Verified" | "Failed" | "Manual Review";
}

export interface ApplicantStatusView {
  candidate_id: string;
  full_name: string;
  position_applied: string | null;
  job_circular_id: string | null;
  stage: string;
  stage_pill: "green" | "amber" | "red" | "neutral";
  reasons: ApplicantReasonEntry[];
  evidence_documents: ApplicantDocumentSummary[];
  estimated_timeline_text: string;
  next_expected_update: string;
  appeal_enabled: boolean;
  language: string;
  reason_code: string;
  reason_description: string;
}

/** Own-status read — the token itself scopes this to the logged-in applicant; there is no candidate_id parameter. */
export function useApplicantStatus() {
  return useQuery({
    queryKey: ["applicant-status"],
    queryFn: () => portalRequest<{ status: ApplicantStatusView }>("/portal/status"),
    enabled: !!getApplicantToken(),
    retry: false,
  });
}

/** Submits an appeal via the existing appeals endpoint (POST /api/v1/appeals), reusing the applicant's portal session token. */
export function useSubmitAppeal() {
  return useMutation({
    mutationFn: ({ candidateId, reasonText, category }: { candidateId: string; reasonText: string; category: string }) =>
      portalRequest<{ appeal_id: string; status: string; submitted_at: string }>("/appeals", {
        method: "POST",
        body: JSON.stringify({ candidate_id: candidateId, reason_text: reasonText, category }),
      }),
  });
}

/**
 * Feature 5: persists the authenticated applicant's own language
 * preference (candidates.preferred_language) via PATCH
 * /api/v1/portal/preferences. Deliberately a plain function, not a
 * mutation hook: it is fired from LanguageSwitcher's onLanguageChange
 * callback, a best-effort side effect that must never block or revert
 * the local UI language change that already happened synchronously.
 */
export function setApplicantPreferredLanguage(preferredLanguage: "en" | "bn"): Promise<{ preferences: { candidate_id: string; preferred_language: string } }> {
  return portalRequest("/portal/preferences", {
    method: "PATCH",
    body: JSON.stringify({ preferred_language: preferredLanguage }),
  });
}
