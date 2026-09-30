# Contributing to UROS

Thank you for contributing to the Universal Recruitment Operations System.

## Development Setup

```bash
cp deploy/env-templates/.env.example .env
npm install
npm run migrate
npm test
```

For the UI:

```bash
cd src/ui
npm install
npx vite --port 5173
```

## Architecture Principles

1. **No stubs in production.** Every agent, route, and service must have a real implementation.
2. **No black-box AI.** Every decision is traceable to a human-defined, versioned rule.
3. **Multi-tenant by default.** Every query filters by `org_id`. No exceptions.
4. **Deterministic first.** Rules evaluate deterministically. LLM is optional and supplementary.
5. **Human-in-the-loop.** Gate events require human resolution with reason codes.

## Code Standards

- TypeScript strict mode everywhere.
- All API routes require JWT auth + org_id scoping.
- All user-visible strings go through `t()` (i18n).
- All agent outputs include `reason_code`, `reason_description`, `evidence`, and `audit_log` row.
- Migrations must be idempotent (re-runnable).

## Testing

- Unit tests: `npm test`
- E2E tests: `npx playwright test`
- Every new route needs a real HTTP + real DB + real JWT integration test.
- Every new agent needs unit tests covering deterministic evaluation.

## Commit Convention

```
Quest NN Part X — description [WIP]
```

Push every commit to `origin/main`. Tag only at Quest close-out.

## Pull Request Process

1. Ensure `npm run typecheck`, `npm run lint`, and `npm test` all pass.
2. Ensure `npx playwright test` passes (or document why a test is skipped).
3. Update `progress.md` with the Trust Ledger entry.
4. Request review from at least one maintainer.

## Security

See `SECURITY.md` for vulnerability reporting.

## License

See `LICENSE`.
