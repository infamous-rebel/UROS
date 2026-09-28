/**
 * Unit tests for the per-agent circuit breaker.
 *
 * The breaker holds no timers and takes an injectable clock, so the whole
 * CLOSED -> OPEN -> HALF_OPEN -> CLOSED lifecycle is exercised here by
 * advancing a fake clock — no sleeping, no flakiness, fully deterministic.
 */
import { CircuitBreaker, CircuitTransitionInfo } from "../../../src/services/agent_runner/circuit_breaker";
import { CircuitState } from "../../../src/services/agent_runner/types";

const T0 = 1_700_000_000_000;

function fakeClock(start: number = T0) {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

interface Harness {
  breaker: CircuitBreaker;
  clock: ReturnType<typeof fakeClock>;
  transitions: Array<{ from: CircuitState; to: CircuitState; info: CircuitTransitionInfo }>;
}

function makeBreaker(options: { failureThreshold?: number; resetMs?: number; name?: string } = {}): Harness {
  const clock = fakeClock();
  const transitions: Harness["transitions"] = [];
  const breaker = new CircuitBreaker({
    name: options.name ?? "test.agent",
    failureThreshold: options.failureThreshold ?? 3,
    resetMs: options.resetMs ?? 1_000,
    now: clock.now,
    onStateChange: (from, to, info) => transitions.push({ from, to, info }),
  });
  return { breaker, clock, transitions };
}

describe("CircuitBreaker", () => {
  it("starts CLOSED and allows requests", () => {
    const { breaker } = makeBreaker();
    expect(breaker.state).toBe("CLOSED");
    expect(breaker.allowRequest()).toEqual({ allowed: true });
    expect(breaker.consecutiveFailures).toBe(0);
  });

  it("stays CLOSED below the failure threshold and clears the counter on success", () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 3 });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("CLOSED");
    expect(breaker.consecutiveFailures).toBe(2);
    expect(breaker.allowRequest()).toEqual({ allowed: true });

    breaker.recordSuccess();
    expect(breaker.consecutiveFailures).toBe(0);
    // No transition ever happened: nothing to log, audit or alert on.
    expect(transitions).toHaveLength(0);
  });

  it("opens at the threshold and reports how long until a probe is allowed", () => {
    const { breaker, clock, transitions } = makeBreaker({ failureThreshold: 3, resetMs: 1_000 });

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.state).toBe("OPEN");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "CLOSED", to: "OPEN" });
    expect(transitions[0].info.reason).toBe("failure_threshold_reached");
    expect(transitions[0].info.consecutive_failures).toBe(3);

    const gate = breaker.allowRequest();
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.retryAfterMs).toBe(1_000);

    clock.advance(400);
    const later = breaker.allowRequest();
    expect(later.allowed).toBe(false);
    if (!later.allowed) expect(later.retryAfterMs).toBe(600);
  });

  it("rejects fast while OPEN and counts every rejection", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, resetMs: 5_000 });
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");

    for (let i = 0; i < 4; i++) {
      clock.advance(10);
      expect(breaker.allowRequest().allowed).toBe(false);
    }
    expect(breaker.snapshot().total_rejections).toBe(4);
    expect(breaker.snapshot().total_open_events).toBe(1);
  });

  it("admits exactly one probe once the reset window elapses, then HALF_OPEN blocks the burst behind it", () => {
    const { breaker, clock, transitions } = makeBreaker({ failureThreshold: 1, resetMs: 1_000 });
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");

    clock.advance(1_001);

    // The transition is lazy: it happens on the first call after the window,
    // so a breaker can never keep the event loop alive with a background timer.
    expect(breaker.allowRequest()).toEqual({ allowed: true });
    expect(breaker.state).toBe("HALF_OPEN");
    expect(transitions.map((t) => t.info.reason)).toContain("reset_window_elapsed");

    // A concurrent caller during the probe is refused — a burst cannot slip through.
    const second = breaker.allowRequest();
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.retryAfterMs).toBe(1_000);
  });

  it("closes on a successful probe and clears the failure history", () => {
    const { breaker, clock, transitions } = makeBreaker({ failureThreshold: 2, resetMs: 1_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");

    clock.advance(1_000);
    expect(breaker.allowRequest().allowed).toBe(true);
    expect(breaker.state).toBe("HALF_OPEN");

    breaker.recordSuccess();

    expect(breaker.state).toBe("CLOSED");
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.snapshot().opened_at).toBeNull();
    expect(breaker.snapshot().retry_after_ms).toBe(0);
    expect(transitions[transitions.length - 1]).toMatchObject({ from: "HALF_OPEN", to: "CLOSED" });
    expect(transitions[transitions.length - 1].info.reason).toBe("probe_succeeded");

    // And it is genuinely usable again: a single later failure no longer trips it.
    breaker.recordFailure();
    expect(breaker.state).toBe("CLOSED");
  });

  it("re-opens on a failed probe and restarts the full reset window", () => {
    const { breaker, clock, transitions } = makeBreaker({ failureThreshold: 1, resetMs: 1_000 });
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");

    clock.advance(1_000);
    expect(breaker.allowRequest().allowed).toBe(true);
    expect(breaker.state).toBe("HALF_OPEN");

    breaker.recordFailure();

    expect(breaker.state).toBe("OPEN");
    expect(breaker.snapshot().total_open_events).toBe(2);
    expect(transitions[transitions.length - 1].info.reason).toBe("probe_failed");
    // The window restarted at the probe failure, so the very next call is refused.
    expect(breaker.allowRequest().allowed).toBe(false);
    clock.advance(999);
    expect(breaker.allowRequest().allowed).toBe(false);
    clock.advance(2);
    expect(breaker.allowRequest().allowed).toBe(true);
  });

  it("a single failure below threshold does not open the circuit", () => {
    const { breaker } = makeBreaker({ failureThreshold: 5 });
    for (let i = 0; i < 4; i++) breaker.recordFailure();
    expect(breaker.state).toBe("CLOSED");
    expect(breaker.consecutiveFailures).toBe(4);
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");
  });

  it("reset() force-closes an open circuit and is audited as a manual transition", () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");

    breaker.reset();

    expect(breaker.state).toBe("CLOSED");
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.allowRequest()).toEqual({ allowed: true });
    expect(transitions[transitions.length - 1].info.reason).toBe("manual_reset");
  });

  it("reset() on a CLOSED circuit emits no transition", () => {
    const { breaker, transitions } = makeBreaker();
    breaker.reset();
    expect(transitions).toHaveLength(0);
    expect(breaker.state).toBe("CLOSED");
  });

  it("snapshot() reports the configured policy and cumulative counters", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 2, resetMs: 2_000, name: "scoring.run" });
    clock.advance(500);
    breaker.recordFailure();
    breaker.recordFailure();

    const snap = breaker.snapshot();
    expect(snap).toMatchObject({
      name: "scoring.run",
      state: "OPEN",
      consecutive_failures: 2,
      failure_threshold: 2,
      reset_ms: 2_000,
      total_open_events: 1,
      total_rejections: 0,
    });
    expect(snap.opened_at).toBe(new Date(T0 + 500).toISOString());
    expect(snap.retry_after_ms).toBe(2_000);
    expect(snap.last_transition).not.toBeNull();
    expect(snap.last_transition?.at).toBe(new Date(T0 + 500).toISOString());

    clock.advance(500);
    expect(breaker.snapshot().retry_after_ms).toBe(1_500);
  });

  it("reconfigure() applies new policy without discarding breaker history", () => {
    const { breaker } = makeBreaker({ failureThreshold: 5, resetMs: 1_000 });
    breaker.recordFailure();
    breaker.recordFailure();

    breaker.reconfigure({ failureThreshold: 2, resetMs: 50 });

    expect(breaker.consecutiveFailures).toBe(2);
    // The next failure now trips it, because the threshold dropped to 2.
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");
    expect(breaker.snapshot().failure_threshold).toBe(2);
    expect(breaker.snapshot().reset_ms).toBe(50);
  });
});
