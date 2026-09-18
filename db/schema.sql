CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES entries(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  kind text NOT NULL CHECK (kind IN ('file', 'folder')),
  mime_type text,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  storage_name text,
  is_trashed boolean NOT NULL DEFAULT false,
  trashed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_has_storage CHECK (
    (kind = 'folder' AND storage_name IS NULL) OR
    (kind = 'file' AND storage_name IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS entries_parent_idx ON entries(parent_id);
CREATE INDEX IF NOT EXISTS entries_owner_idx ON entries(owner_id);
CREATE INDEX IF NOT EXISTS entries_trash_idx ON entries(is_trashed);
CREATE INDEX IF NOT EXISTS entries_name_idx ON entries(lower(name));

CREATE TABLE IF NOT EXISTS shares (
  entry_id uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('view', 'edit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, user_id)
);
