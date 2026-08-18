-- 0003_file_blobs.sql — store uploaded files in Postgres
--
-- No BEGIN/COMMIT here: migrate.mjs wraps each file and its version record in
-- one transaction. To run this by hand, use `psql -1 -f` so you still get one.
--
-- Why the database and not the disk
-- ---------------------------------
-- The local-filesystem storage this replaces cannot work on a serverless
-- host. Vercel's filesystem is read-only apart from /tmp, and /tmp is neither
-- shared between instances nor persisted between invocations — so an upload
-- lands on one instance and the extraction that reads it back runs on another
-- and finds nothing. That is exactly what happened: uploads returned 201 and
-- then failed with "the uploaded file could not be read".
--
-- Postgres is not where you would put blobs at scale, and this is a demo whose
-- files are single-page invoices. What it buys: no second service to configure,
-- identical behaviour locally and in production, and a seed that carries its own
-- bytes — so the sample previews work the moment `npm run db:seed` finishes.
--
-- src/lib/storage stays a three-method interface, so moving to object storage
-- later is still a change to that one file.

CREATE TABLE file_blobs (
  -- `documents/<document-id>/<filename>`, built server-side from a UUID and
  -- never taken from user input. Matches documents.storage_path.
  storage_key text PRIMARY KEY,
  bytes       bytea NOT NULL,
  byte_size   integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Mirrors the 10 MB upload limit. The application checks first and returns a
  -- readable 413; this is the backstop for anything that bypasses the route.
  CONSTRAINT file_blobs_size_within_limit CHECK (byte_size > 0 AND byte_size <= 10485760),
  CONSTRAINT file_blobs_size_matches_bytes CHECK (byte_size = length(bytes))
);

COMMENT ON TABLE file_blobs IS
  'Uploaded document bytes. Keyed by documents.storage_path. Deliberately not a foreign key: storage is a seam, and a stored object outliving its row is a leak to sweep, not a constraint violation.';

-- Answers "how much is stored in total", for the upload cap.
CREATE INDEX file_blobs_created_idx ON file_blobs (created_at DESC);
