# UROS Dashboard UI — First Mount

Minimal React + Vite + TypeScript dashboard shell. Dependency-light: React,
TanStack Query, Tailwind CSS. Uses the locked UROS color system
(`UROS_Color_System.md`): deep teal for agent/machine work, terracotta for
human decisions, amber for attention/needs-review, off-white/slate base.

## Quick Start

```bash
cd src/ui
cp .env.example .env
npm install
npm run dev
```

Requires the backend API running (`npm run dev` at the repo root) and a
valid JWT pasted into the Command Bar's dev token field — there is no login
flow yet (see progress.md, Phase 5 assumptions).

## What's here

- **Command Bar** — org/API health status, dev token entry
- **Live Pipeline Strip** — per-stage candidate counts (approximate; see
  in-code comment on `usePipelineStageCounts`)
- **Decision Queue** — candidates with status `NEEDS_REVIEW`
- **Audit Stream** — recent audit log entries (Admin/Auditor only)

Every panel shows either live data or a meaningful, styled empty/error
state — never a blank space — per the UROS UI/UX no-dead-space rule.

## Tests

```bash
npm test
```
