-- Quest 05 Part 14 — Dark Mode: per-user theme preference.
-- Values: 'light', 'dark', 'system'. Default: 'system'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'system'
  CHECK (theme_preference IN ('light', 'dark', 'system'));
