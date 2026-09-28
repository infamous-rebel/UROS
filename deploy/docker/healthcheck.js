/**
 * Container HEALTHCHECK probe. Deliberately dependency-free (built-in
 * `http` only) so it works identically in the slim production image
 * with no extra installed tooling (no curl/wget required in the image).
 * Exits 0 only on HTTP 200 (fully healthy) — HTTP 503 (down) or a
 * connection failure both fail the check, which is what should trigger
 * Docker/K8s restart-or-remove-from-rotation behavior. HTTP 200 also
 * covers "degraded" (see src/utils/health.ts httpStatusForHealth) —
 * degraded still serves traffic; alerting should watch the JSON body's
 * `checks`, not container health, for that distinction.
 */
const http = require("http");

const port = process.env.PORT || 3000;

const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3000 }, (res) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

req.on("error", () => process.exit(1));
req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});
