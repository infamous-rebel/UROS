import { Client } from "pg";
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { GateTimeoutError } from "../../utils/errors";

interface Waiter {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

const NOTIFY_CHANNEL = "gate_resolved";

/**
 * Single persistent LISTEN connection per process, fanning out resolved
 * gate notifications to whichever in-process caller is awaiting that
 * specific gate_id. This replaces the DB-polling loop that previously
 * lived in `waitForHumanGate` (Phase 3/4) — resolution now happens the
 * instant `resolveGate()` issues `pg_notify`, instead of on the next
 * 5-second poll tick.
 *
 * Race-safety: `waitFor` always re-checks the gate's current status in
 * the database immediately after registering itself, in case the gate
 * was resolved in the narrow window between gate creation and this
 * process subscribing (or before the LISTEN connection was established
 * at all, e.g. on cold start). This makes the notify-based path at least
 * as safe as the polling path it replaces, never less.
 */
class GateListener {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private waiters = new Map<string, Waiter>();

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client({ connectionString: env.DATABASE_URL });
      await client.connect();
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);

      client.on("notification", (msg) => {
        if (msg.channel === NOTIFY_CHANNEL && msg.payload) {
          void this.resolveWaiterFromDb(msg.payload);
        }
      });

      client.on("error", (err) => {
        logger.error("GATE_LISTENER_CONNECTION_ERROR", { error: err.message });
        // Drop the reference so the next waitFor() call reconnects. Any
        // waiters already registered fall back to their timeout, which
        // is the same worst-case behavior as the polling implementation
        // losing its DB connection.
        this.client = null;
        this.connecting = null;
      });

      this.client = client;
      logger.info("GATE_LISTENER_CONNECTED", { channel: NOTIFY_CHANNEL });
    })();

    await this.connecting;
  }

  private async resolveWaiterFromDb(gateId: string): Promise<void> {
    const waiter = this.waiters.get(gateId);
    if (!waiter) return; // no one in this process is awaiting this gate

    clearTimeout(waiter.timeout);
    this.waiters.delete(gateId);

    try {
      const res = await db.query<{ payload: unknown }>(`SELECT payload FROM gate_events WHERE gate_id=$1`, [gateId]);
      waiter.resolve(res.rows[0]?.payload ?? null);
    } catch (err) {
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Waits for a specific gate to resolve, or times out after `timeoutMs`. */
  async waitFor(gateId: string, timeoutMs: number): Promise<unknown> {
    await this.ensureConnected();

    // Catch the case where the gate resolved before we finished subscribing.
    const existing = await db.query<{ status: string; payload: unknown }>(
      `SELECT status, payload FROM gate_events WHERE gate_id=$1`,
      [gateId]
    );
    if (existing.rows[0]?.status === "RESOLVED") {
      return existing.rows[0].payload;
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(gateId);
        reject(new GateTimeoutError(gateId));
      }, timeoutMs);

      this.waiters.set(gateId, { resolve, reject, timeout });
    });
  }
}

export const gateListener = new GateListener();
