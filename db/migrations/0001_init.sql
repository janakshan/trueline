-- 0001_init.sql — Trueline initial schema
-- Postgres 13+ (gen_random_uuid is built in; no pgcrypto needed)
--
-- No BEGIN/COMMIT here: migrate.mjs wraps each file and its version record in
-- one transaction. To run this by hand, use `psql -1 -f` so you still get one.

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Emails are stored pre-normalised so the UNIQUE index is the whole story;
  -- a functional index on lower(email) would let two casings both insert.
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_email_shape     CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  users IS 'Application users. Single-tenant in v1: one seeded demo account.';
COMMENT ON COLUMN users.password_hash IS 'node:crypto scrypt, formatted scrypt$N$r$p$salt_b64$hash_b64.';

-- ---------------------------------------------------------------------------
-- documents  — the file, and its position in the extraction queue
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- file metadata
  filename              text        NOT NULL,
  mime_type             text        NOT NULL,
  size_bytes            integer     NOT NULL,
  page_count            integer,
  storage_path          text        NOT NULL,

  -- queue state
  status                text        NOT NULL DEFAULT 'queued',
  attempts              integer     NOT NULL DEFAULT 0,
  processing_started_at timestamptz,
  error_code            text,
  error_message         text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- text + CHECK rather than a native ENUM: adding or retiring a status is a
  -- one-line constraint swap instead of an ALTER TYPE dance, and it maps
  -- cleanly onto a TypeScript union.
  CONSTRAINT documents_status_valid CHECK (
    status IN ('queued', 'processing', 'needs_review', 'approved', 'failed')
  ),
  CONSTRAINT documents_mime_supported CHECK (
    mime_type IN ('application/pdf', 'image/png', 'image/jpeg')
  ),
  CONSTRAINT documents_size_positive CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  CONSTRAINT documents_page_count_sane CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 10),
  CONSTRAINT documents_attempts_bounded CHECK (attempts >= 0 AND attempts <= 10),

  -- A failed row must say why. Prevents the silent-empty-error-state bug.
  CONSTRAINT documents_failed_has_reason CHECK (
    status <> 'failed' OR error_code IS NOT NULL
  ),
  -- A processing row must carry a claim timestamp, or the stale-claim sweep
  -- in architecture.md can never reclaim it.
  CONSTRAINT documents_processing_has_claim CHECK (
    status <> 'processing' OR processing_started_at IS NOT NULL
  )
);

CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Drives the documents list (newest first, scoped to the user).
CREATE INDEX documents_user_created_idx
  ON documents (user_id, created_at DESC);

-- Partial index for the queue claim and the stale-claim sweep. Small and hot:
-- it only ever contains rows that are actually in flight.
CREATE INDEX documents_active_queue_idx
  ON documents (status, processing_started_at)
  WHERE status IN ('queued', 'processing');

-- Backs the "Needs review (n)" / "Failed" filter chip counts.
CREATE INDEX documents_user_status_idx
  ON documents (user_id, status);

COMMENT ON TABLE  documents IS 'One uploaded file plus its extraction-queue state. Never holds extracted data.';
COMMENT ON COLUMN documents.storage_path IS 'Blob key/URL. File bytes never live in Postgres (Neon free tier is 0.5 GB).';
COMMENT ON COLUMN documents.processing_started_at IS 'Claim timestamp. Rows older than ~90s are reclaimable by the stale-claim sweep.';
COMMENT ON COLUMN documents.attempts IS 'Incremented by the atomic claim; capped at 3 in app logic before requiring a human retry.';

-- ---------------------------------------------------------------------------
-- extractions — what the model produced, plus human review state
-- ---------------------------------------------------------------------------

CREATE TABLE extractions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  -- The Zod-validated payload: the 15 header fields plus a line_items array.
  data              jsonb       NOT NULL,

  -- Per-field model confidence, e.g. {"vendor_name": 0.97, "tax_rate": 0.41}.
  -- Kept beside the data rather than inside it so `data` stays a clean mirror
  -- of the extraction schema.
  confidence        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Array of {field, severity, message} from the arithmetic/structural checks.
  -- This is the load-bearing review signal, not `confidence`.
  validation_issues jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Field paths a human has touched. Drives the "edited" dot and clears the
  -- amber flag in the review UI.
  reviewed_fields   text[]      NOT NULL DEFAULT '{}',

  -- Append-only edit log: [{field, from, to, at}]. Deliberately a jsonb array
  -- rather than a fourth table — bounded by how many fields a document has,
  -- and never queried across documents. Promote to a table if audit ever
  -- becomes a real requirement.
  edits             jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Exactly one current extraction per document; older rows are re-extraction
  -- history. Enforced by a partial unique index below rather than by app code.
  is_current        boolean     NOT NULL DEFAULT true,

  -- Telemetry
  model             text,
  effort            text,
  input_tokens      integer,
  output_tokens     integer,
  raw_response      text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT extractions_data_is_object   CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT extractions_confidence_object CHECK (jsonb_typeof(confidence) = 'object'),
  CONSTRAINT extractions_issues_array     CHECK (jsonb_typeof(validation_issues) = 'array'),
  CONSTRAINT extractions_edits_array      CHECK (jsonb_typeof(edits) = 'array'),
  -- Truncate debug payloads hard; 0.5 GB fills faster than you'd think.
  CONSTRAINT extractions_raw_bounded      CHECK (raw_response IS NULL OR length(raw_response) <= 8192),

  -- Generated columns: Postgres derives and maintains these from `data`, so
  -- the list view, sorting, and CSV export are plain indexed SQL with zero
  -- risk of drifting from the JSON. Each is guarded so malformed extractions
  -- write a NULL instead of failing the INSERT.
  vendor_name  text GENERATED ALWAYS AS (data->>'vendor_name') STORED,
  currency     text GENERATED ALWAYS AS (data->>'currency')    STORED,
  total_amount numeric(14,2) GENERATED ALWAYS AS (
    CASE WHEN data->>'total_amount' ~ '^-?[0-9]+(\.[0-9]+)?$'
         THEN (data->>'total_amount')::numeric END
  ) STORED,
  -- Deliberately text, not date. Every text->date path in Postgres (to_date,
  -- ::date) is STABLE rather than IMMUTABLE because it depends on DateStyle,
  -- and generated columns require IMMUTABLE. ISO-8601 sorts and range-compares
  -- lexicographically exactly as dates do, so ORDER BY and BETWEEN still work
  -- off the index. Cast in the query if you need date arithmetic.
  -- Do not "fix" this back to `date` — the migration will stop applying.
  issue_date   text GENERATED ALWAYS AS (
    CASE WHEN data->>'issue_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         THEN data->>'issue_date' END
  ) STORED,
  line_item_count integer GENERATED ALWAYS AS (
    CASE WHEN jsonb_typeof(data->'line_items') = 'array'
         THEN jsonb_array_length(data->'line_items') END
  ) STORED
);

-- Guarantees at most one current extraction per document, in the database
-- rather than in a hopeful application invariant.
CREATE UNIQUE INDEX extractions_one_current_per_document
  ON extractions (document_id)
  WHERE is_current;

CREATE INDEX extractions_document_created_idx
  ON extractions (document_id, created_at DESC);

-- Sorting the documents list by vendor or amount without touching the JSON.
CREATE INDEX extractions_current_vendor_idx
  ON extractions (vendor_name) WHERE is_current;
CREATE INDEX extractions_current_total_idx
  ON extractions (total_amount) WHERE is_current;

COMMENT ON TABLE  extractions IS 'Model output plus human review state. Multiple rows per document; one has is_current.';
COMMENT ON COLUMN extractions.data IS 'Zod-validated extraction payload: 15 header fields + line_items[].';
COMMENT ON COLUMN extractions.confidence IS 'Model self-reported, weakly calibrated. A soft hint, never a gate.';
COMMENT ON COLUMN extractions.validation_issues IS 'Deterministic arithmetic/structural findings. The signal we actually trust.';
COMMENT ON COLUMN extractions.reviewed_fields IS 'Field paths a human edited or confirmed; clears the amber flag in the UI.';
COMMENT ON COLUMN extractions.edits IS 'Append-only [{field, from, to, at}] edit log. Simple by design.';
