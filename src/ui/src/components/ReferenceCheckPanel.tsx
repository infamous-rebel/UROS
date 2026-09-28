import { useState } from "react";
import {
  useReferenceRequests,
  useCreateReferenceRequest,
  useScoreReferenceRequest,
  useReviewReferenceResult,
  ReferenceRequestRow,
  ReferenceRequestStatus,
  ReferenceRecommendation,
  ReferenceReviewDecision,
} from "../hooks/hooks_reference";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";

const STATUS_BADGE: Record<ReferenceRequestStatus, string> = {
  PENDING: "bg-attention text-white",
  SENT: "bg-agent text-white",
  COMPLETED: "bg-success text-white",
  EXPIRED: "bg-danger text-white",
  CANCELLED: "bg-border-soft text-text-secondary",
};

const RECOMMENDATION_BADGE: Record<ReferenceRecommendation, string> = {
  RECOMMEND: "bg-success text-white",
  NEEDS_REVIEW: "bg-attention text-white",
  CONCERN: "bg-danger text-white",
};

function StatusBadge({ status }: { status: ReferenceRequestStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[status]}`}>{status}</span>;
}

function RecommendationBadge({ recommendation }: { recommendation: ReferenceRecommendation }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${RECOMMENDATION_BADGE[recommendation]}`}>
      {recommendation.replace("_", " ")}
    </span>
  );
}

function ReviewControls({ resultId, candidateId }: { resultId: string; candidateId: string }) {
  const review = useReviewReferenceResult(candidateId);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<ReferenceReviewDecision | null>(null);

  const submit = (decision: ReferenceReviewDecision) => {
    if (!reason.trim()) {
      setPending(decision);
      return;
    }
    review.mutate({ resultId, review_decision: decision, review_reason: reason.trim() });
  };

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border-soft pt-2">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Mandatory reason for this review decision…"
        rows={2}
        className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
      />
      {pending && !reason.trim() && <div className="text-xs text-danger">A reason is required before {pending}.</div>}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => submit("APPROVED")}
          className="rounded bg-human px-3 py-1.5 text-xs font-medium text-white"
        >
          Approve
        </button>
        <button onClick={() => submit("REJECTED")} className="rounded border border-danger px-3 py-1.5 text-xs font-medium text-danger">
          Reject
        </button>
        <button
          onClick={() => submit("ESCALATED")}
          className="rounded border border-attention px-3 py-1.5 text-xs font-medium text-attention"
        >
          Escalate
        </button>
      </div>
      {review.isError && <div className="text-xs text-danger">{(review.error as Error)?.message ?? "Review failed."}</div>}
    </div>
  );
}

function RequestRow({ request, candidateId }: { request: ReferenceRequestRow; candidateId: string }) {
  const score = useScoreReferenceRequest(candidateId);

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-text-primary">{request.referee_email ?? request.referee_phone}</div>
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge status={request.status} />
            {request.recommendation && <RecommendationBadge recommendation={request.recommendation} />}
            <span className="text-[11px] text-text-secondary">Sent {request.sent_at ? new Date(request.sent_at).toLocaleString() : "—"}</span>
          </div>
        </div>
        {request.status === "COMPLETED" && !request.result_id && (
          <button
            disabled={score.isPending}
            onClick={() => score.mutate(request.request_id)}
            className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {score.isPending ? "Scoring…" : "Score Responses"}
          </button>
        )}
      </div>

      {request.result_id && request.total_score !== null && request.max_score !== null && (
        <div className="mt-2 text-xs text-text-primary">
          Score: <span className="font-medium">{request.total_score.toFixed(1)}</span> / {request.max_score.toFixed(1)}
        </div>
      )}

      {request.status === "PENDING" && (
        <div className="mt-2 text-[11px] text-text-secondary">Awaiting delivery to referee.</div>
      )}
      {request.status === "SENT" && (
        <div className="mt-2 text-[11px] text-text-secondary">Awaiting referee response.</div>
      )}
      {request.status === "EXPIRED" && (
        <div className="mt-2 text-[11px] text-danger">Link expired before the referee responded.</div>
      )}

      {request.result_id && (
        <>
          {request.review_decision ? (
            <div className="mt-2 border-t border-border-soft pt-2 text-[11px] text-text-secondary">
              Reviewed as <span className="font-medium text-text-primary">{request.review_decision}</span>
              {request.reviewed_at ? ` on ${new Date(request.reviewed_at).toLocaleString()}` : ""}
            </div>
          ) : (
            <ReviewControls resultId={request.result_id} candidateId={candidateId} />
          )}
        </>
      )}
    </div>
  );
}

function NewRequestForm({ candidateId }: { candidateId: string }) {
  const create = useCreateReferenceRequest(candidateId);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const submit = () => {
    if (!email.trim() && !phone.trim()) return;
    create.mutate({
      candidate_id: candidateId,
      referee_email: email.trim() || undefined,
      referee_phone: phone.trim() || undefined,
    });
    setEmail("");
    setPhone("");
  };

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">Send New Reference Request</div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Referee email"
          className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="or referee phone (WhatsApp)"
          className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <button
          disabled={create.isPending}
          onClick={submit}
          className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {create.isPending ? "Sending…" : "Send Request"}
        </button>
      </div>
      {create.isError && <div className="mt-2 text-xs text-danger">{(create.error as Error)?.message ?? "Send failed."}</div>}
      {create.isSuccess && <div className="mt-2 text-xs text-success">Reference request sent.</div>}
    </div>
  );
}

export function ReferenceCheckPanel() {
  const [candidateIdInput, setCandidateIdInput] = useState("");
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const { data, isLoading, isError } = useReferenceRequests(candidateId);

  if (!getToken()) return <EmptyState message="Connect with a dev token to use reference checking." />;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border-soft bg-surface p-3">
        <div className="mb-2 text-xs font-semibold text-text-primary">Look Up Reference Checks for a Candidate</div>
        <div className="flex gap-2">
          <input
            value={candidateIdInput}
            onChange={(e) => setCandidateIdInput(e.target.value)}
            placeholder="Candidate ID"
            className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
          />
          <button
            onClick={() => setCandidateId(candidateIdInput.trim() || null)}
            className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white"
          >
            View Requests
          </button>
        </div>
      </div>

      {!candidateId ? (
        <EmptyState message="Look up a candidate ID to view or send reference check requests." />
      ) : (
        <>
          <NewRequestForm candidateId={candidateId} />

          <div>
            <div className="mb-2 text-xs font-semibold text-text-primary">Reference Requests for {candidateId}</div>
            {isLoading && <EmptyState message="Loading requests…" />}
            {isError && <EmptyState message="Could not reach the reference-check API." tone="danger" />}
            {data && data.requests.length === 0 && (
              <EmptyState message={`No reference requests on file for ${candidateId} yet.`} tone="neutral" />
            )}
            {data && data.requests.length > 0 && (
              <div className="flex flex-col gap-3">
                {data.requests.map((r) => (
                  <RequestRow key={r.request_id} request={r} candidateId={candidateId} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
