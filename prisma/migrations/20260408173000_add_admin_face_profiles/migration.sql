CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "admin_face_profiles" (
  "id" UUID PRIMARY KEY,
  "admin_id" UUID NOT NULL UNIQUE,
  "embedding" vector(128) NOT NULL,
  "embedding_dimension" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
