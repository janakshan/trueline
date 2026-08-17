-- 0002_extraction_usage.sql — durable spend guard for the Claude API
--
-- No BEGIN/COMMIT here: migrate.mjs wraps each file and its version record in
-- one transaction. To run this by hand, use `psql -1 -f` so you still get one.
--
-- Why this table exists
-- --------------------
-- The in-memory limiter in src/lib/auth/rate-limit.ts cannot bound spend on a
-- serverless deploy. Each instance keeps its own Map, so N warm instances allow
-- N × the limit, and a cold start resets the window to zero. That is fine for
-- slowing a brute force against the sign-in form, which is all it claims to do.
--
-- Extraction is the only endpoint that spends money, and a public demo hands
-- the account to anyone who clicks "Try the demo". Its limit therefore has to
-- live somewhere every instance shares, which is the database.
--
-- One row per billable attempt. Two questions are asked of it before each call:
-- how many attempts has this client made in the last hour, and how many has the
-- whole deployment made this calendar month.

CREATE TABLE extraction_usage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- IP-derived on Vercel, where the platform overwrites x-forwarded-for.
  client_key  text NOT NULL,
  -- Deliberately no FK to users: this is a spend log, and it must survive the
  -- user row. `npm run db:seed` deletes and recreates the demo account, which
  -- would otherwise wipe the month's recorded usage and reset the cap.
  user_id     uuid,
  document_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT extraction_usage_client_key_not_blank CHECK (length(btrim(client_key)) > 0)
);

COMMENT ON TABLE extraction_usage IS
  'One row per billable Claude extraction attempt. Backs the per-client hourly limit and the deployment-wide monthly cap.';

-- Answers "how many has this client made since T".
CREATE INDEX extraction_usage_client_created_idx
  ON extraction_usage (client_key, created_at DESC);

-- Answers "how many has the deployment made this month".
CREATE INDEX extraction_usage_created_idx
  ON extraction_usage (created_at DESC);
