CREATE TABLE IF NOT EXISTS "admin_face_id_browsers" (
  "id" UUID PRIMARY KEY,
  "admin_id" UUID NOT NULL,
  "fingerprint_hash" VARCHAR(64) NOT NULL,
  "browser_label" VARCHAR(160),
  "user_agent" TEXT,
  "face_id_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "first_otp_verified_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_otp_verified_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_face_login_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "admin_face_id_browsers_admin_id_fingerprint_hash_key"
    UNIQUE ("admin_id", "fingerprint_hash")
);

CREATE INDEX IF NOT EXISTS "admin_face_id_browsers_admin_id_idx"
  ON "admin_face_id_browsers" ("admin_id");
