/**
 * Read-back helpers for the in-process Prometheus registry.
 *
 * `src/utils/metrics.ts` is deliberately write-only from the application's
 * point of view — counters expose `inc`, gauges `set`, and the only read
 * path is the rendered text exposition served on `/metrics`. Tests
 * therefore assert on that rendered output exactly as a Prometheus scrape
 * would, which also keeps them honest about the exposition format itself.
 */
import { renderMetrics } from "../../src/utils/metrics";

/** Full rendered exposition (what `GET /metrics` returns). */
export function scrape(): string {
  return renderMetrics();
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`)
    .join(",");
}

/** Current value of one metric series, or null when the series has not been emitted yet. */
export function metricValue(name: string, labels: Record<string, string> = {}): number | null {
  return metricValueFrom(scrape(), name, labels);
}

/** Same as `metricValue`, but against an already-rendered exposition (e.g. an HTTP `/metrics` body). */
export function metricValueFrom(exposition: string, name: string, labels: Record<string, string> = {}): number | null {
  const key = labelKey(labels);
  const prefix = key ? `${name}{${key}} ` : `${name} `;
  const line = exposition
    .split("\n")
    .find((l) => !l.startsWith("#") && l.startsWith(prefix));
  if (!line) return null;
  const value = Number(line.slice(line.lastIndexOf(" ") + 1));
  return Number.isFinite(value) ? value : null;
}

/** Every series name emitted for a metric, e.g. `agent="x",agent_class="y"`. */
export function metricSeries(name: string): string[] {
  return scrape()
    .split("\n")
    .filter((l) => !l.startsWith("#") && l.startsWith(`${name}{`))
    .map((l) => l.slice(0, l.lastIndexOf(" ")));
}

/** True when the exposition contains the metric's HELP/TYPE declaration at all. */
export function declaresMetric(name: string): boolean {
  return scrape().includes(`# TYPE ${name} `);
}

/** Same as `declaresMetric`, but against an already-rendered exposition. */
export function declaresMetricIn(exposition: string, name: string): boolean {
  return exposition.includes(`# TYPE ${name} `);
}
