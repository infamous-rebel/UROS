/**
 * Per-agent circuit breaker.
 *
 * Deterministic and clock-injectable: it holds no timers of its own, so
 * state transitions are a pure function of (failure history, current
 * time). That makes the CLOSED -> OPEN -> HALF_OPEN -> CLOSED lifecycle
 * fully unit-testable without sleeping, and means a breaker can never
 * keep the Node event loop alive on its own.
 *
 * Semantics:
 *  - CLOSED: calls flow through. Each failure increments a *consecutive*
 *    counter; each success resets it to zero. Reaching
 *    `failureThreshold` opens the circuit.
 *  - OPEN: calls are rejected immediately (fast failure — the point is to
 *    stop hammering a dependency that is already down). Once
 *    `resetMs` has elapsed since it opened, the *next* call is admitted
 *    as a probe and the circuit moves to HALF_OPEN.
 *  - HALF_OPEN: exactly one probe in flight. Success closes the circuit
 *    and clears the failure counter; failure re-opens it for another full
 *    `resetMs` window. Additional calls arriving while a probe is in
 *    flight are rejected, so a burst cannot slip through the breaker.
 */
import { CircuitState } from "./types";

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;
  resetMs: number;
  /** Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Called after every state transition (used for audit + metrics + logging). */
  onStateChange?: (from: CircuitState, to: CircuitState, info: CircuitTransitionInfo) => void;
}

export interface CircuitTransitionInfo {
  name: string;
  consecutive_failures: number;
  reason: "failure_threshold_reached" | "probe_failed" | "probe_succeeded" | "reset_window_elapsed" | "manual_reset";
  at: string;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  consecutive_failures: number;
  failure_threshold: number;
  reset_ms: number;
  opened_at: string | null;
  /** ms until the next probe is admitted; 0 when not OPEN. */
  retry_after_ms: number;
  total_open_events: number;
  total_rejections: number;
  last_transition: CircuitTransitionInfo | null;
}

export class CircuitBreaker {
  private _state: CircuitState = "CLOSED";
  private _consecutiveFailures = 0;
  private _openedAtMs: number | null = null;
  private _probeInFlight = false;
  private _totalOpenEvents = 0;
  private _totalRejections = 0;
  private _lastTransition: CircuitTransitionInfo | null = null;

  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get name(): string {
    return this.options.name;
  }

  get state(): CircuitState {
    return this._state;
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /**
   * Whether a new invocation may proceed *right now*, and — if the
   * circuit is OPEN — how long until a probe will be admitted.
   *
   * Side effect: an OPEN circuit whose reset window has elapsed
   * transitions to HALF_OPEN here, lazily, so no background timer is
   * needed. Only one probe is admitted; concurrent callers during a
   * probe are told to wait.
   */
  allowRequest(): { allowed: true } | { allowed: false; retryAfterMs: number } {
    if (this._state === "CLOSED") return { allowed: true };

    if (this._state === "HALF_OPEN") {
      if (this._probeInFlight) {
        this._totalRejections += 1;
        return { allowed: false, retryAfterMs: this.options.resetMs };
      }
      this._probeInFlight = true;
      return { allowed: true };
    }

    // OPEN
    const elapsed = this._openedAtMs === null ? Infinity : this.now() - this._openedAtMs;
    if (elapsed < this.options.resetMs) {
      this._totalRejections += 1;
      return { allowed: false, retryAfterMs: this.options.resetMs - elapsed };
    }

    this.transition("HALF_OPEN", "reset_window_elapsed");
    this._probeInFlight = true;
    return { allowed: true };
  }

  recordSuccess(): void {
    const wasProbe = this._state === "HALF_OPEN";
    this._probeInFlight = false;
    this._consecutiveFailures = 0;
    if (this._state !== "CLOSED") {
      this.transition("CLOSED", wasProbe ? "probe_succeeded" : "manual_reset");
    }
    this._openedAtMs = null;
  }

  recordFailure(): void {
    const wasProbe = this._state === "HALF_OPEN";
    this._probeInFlight = false;
    this._consecutiveFailures += 1;

    if (wasProbe || this._consecutiveFailures >= this.options.failureThreshold) {
      this._openedAtMs = this.now();
      this._totalOpenEvents += 1;
      this.transition("OPEN", wasProbe ? "probe_failed" : "failure_threshold_reached");
    }
  }

  /** Force-close (operator action / test reset). Audited as a manual transition. */
  reset(): void {
    this._probeInFlight = false;
    this._consecutiveFailures = 0;
    this._openedAtMs = null;
    if (this._state !== "CLOSED") this.transition("CLOSED", "manual_reset");
  }

  /** Re-point the breaker at new thresholds without losing its history. */
  reconfigure(opts: { failureThreshold?: number; resetMs?: number } = {}): void {
    if (opts.failureThreshold !== undefined) this.options.failureThreshold = opts.failureThreshold;
    if (opts.resetMs !== undefined) this.options.resetMs = opts.resetMs;
  }

  snapshot(): CircuitBreakerSnapshot {
    let retryAfterMs = 0;
    if (this._state === "OPEN" && this._openedAtMs !== null) {
      retryAfterMs = Math.max(0, this.options.resetMs - (this.now() - this._openedAtMs));
    } else if (this._state === "HALF_OPEN") {
      retryAfterMs = 0;
    }
    return {
      name: this.options.name,
      state: this._state,
      consecutive_failures: this._consecutiveFailures,
      failure_threshold: this.options.failureThreshold,
      reset_ms: this.options.resetMs,
      opened_at: this._openedAtMs === null ? null : new Date(this._openedAtMs).toISOString(),
      retry_after_ms: retryAfterMs,
      total_open_events: this._totalOpenEvents,
      total_rejections: this._totalRejections,
      last_transition: this._lastTransition,
    };
  }

  private transition(to: CircuitState, reason: CircuitTransitionInfo["reason"]): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    const info: CircuitTransitionInfo = {
      name: this.options.name,
      consecutive_failures: this._consecutiveFailures,
      reason,
      at: new Date(this.now()).toISOString(),
    };
    this._lastTransition = info;
    this.options.onStateChange?.(from, to, info);
  }
}
