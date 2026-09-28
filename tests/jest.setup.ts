// Global Jest setup. Restored here (was referenced by jest.config.js but
// absent from this delivered snapshot) — required for any test that
// transitively imports src/config/env.schema.ts to run at all, since
// loadEnv() validates process.env at import time and process.exit(1)s on
// failure. Values are non-secret placeholders, valid only by shape.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/uros_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
process.env.DOCUMENT_STORAGE_PATH = process.env.DOCUMENT_STORAGE_PATH ?? "/tmp/uros-test-documents";
