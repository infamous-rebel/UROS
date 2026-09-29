-- 0036_last_login.sql
-- Quest 05 Part 7 close-out: track when each user last signed in.
-- Backfilled from user_sessions.last_used_at (most recent session per user).

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Backfill from the most recent session per user
UPDATE users u
SET last_login_at = sub.max_last_used
FROM (
  SELECT user_id, MAX(last_used_at) AS max_last_used
  FROM user_sessions
  GROUP BY user_id
) sub
WHERE u.user_id = sub.user_id
  AND u.last_login_at IS NULL;
