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
  is_system boolean NOT NULL DEFAULT false,
  is_trashed boolean NOT NULL DEFAULT false,
  trashed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_has_storage CHECK (
    (kind = 'folder' AND storage_name IS NULL) OR
    (kind = 'file' AND storage_name IS NOT NULL)
  )
);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS entries_parent_idx ON entries(parent_id);
CREATE INDEX IF NOT EXISTS entries_owner_idx ON entries(owner_id);
CREATE INDEX IF NOT EXISTS entries_trash_idx ON entries(is_trashed);
CREATE INDEX IF NOT EXISTS entries_name_idx ON entries(lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS entries_system_images_owner_idx
  ON entries(owner_id) WHERE is_system=true AND name='Immagini' AND parent_id IS NULL;

CREATE TABLE IF NOT EXISTS shares (
  entry_id uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('view', 'edit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, user_id)
);

CREATE TABLE IF NOT EXISTS device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  device_name text NOT NULL DEFAULT 'Dispositivo sconosciuto',
  platform text NOT NULL DEFAULT 'web',
  last_ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS device_sessions_user_idx ON device_sessions(user_id);
CREATE INDEX IF NOT EXISTS device_sessions_expiry_idx ON device_sessions(expires_at);

CREATE TABLE IF NOT EXISTS changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id uuid,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'moved', 'trashed', 'restored', 'deleted')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS changes_user_cursor_idx ON changes(user_id, id);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES entries(id) ON DELETE SET NULL,
  name text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  total_bytes bigint NOT NULL CHECK (total_bytes > 0),
  received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  storage_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_sessions_owner_idx ON upload_sessions(owner_id);
CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx ON upload_sessions(expires_at);

CREATE TABLE IF NOT EXISTS wopi_locks (
  entry_id uuid PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  lock_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wopi_locks_expiry_idx ON wopi_locks(expires_at);
