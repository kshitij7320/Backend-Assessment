-- Stage 1-3 Core Relational Schema for Shodh a Code Contest Platform

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE SEQUENCE IF NOT EXISTS judging_fencing_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  auth_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('organizer', 'participant')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS contests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  penalty_minutes INT NOT NULL DEFAULT 20 CHECK (penalty_minutes >= 0),
  status_override TEXT CHECK (status_override IN ('force_open', 'force_closed')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_contest_window CHECK (ends_at > starts_at),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS contest_participations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contest_id, user_id)
);

CREATE TABLE IF NOT EXISTS problems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  current_version_id UUID,
  current_test_suite_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contest_id, code)
);

CREATE TABLE IF NOT EXISTS problem_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  version_number INT NOT NULL CHECK (version_number >= 1),
  statement TEXT NOT NULL,
  time_limit_ms INT NOT NULL CHECK (time_limit_ms BETWEEN 100 AND 15000),
  memory_limit_mb INT NOT NULL CHECK (memory_limit_mb BETWEEN 16 AND 1024),
  output_limit_kb INT NOT NULL DEFAULT 64 CHECK (output_limit_kb BETWEEN 4 AND 4096),
  max_points INT NOT NULL DEFAULT 100 CHECK (max_points > 0),
  runtime_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (problem_id, version_number)
);

CREATE TABLE IF NOT EXISTS test_suite_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  problem_version_id UUID NOT NULL REFERENCES problem_versions(id) ON DELETE CASCADE,
  suite_version_number INT NOT NULL CHECK (suite_version_number >= 1),
  notes TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (problem_id, suite_version_number)
);

CREATE TABLE IF NOT EXISTS test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_suite_version_id UUID NOT NULL REFERENCES test_suite_versions(id) ON DELETE CASCADE,
  ordinal INT NOT NULL CHECK (ordinal >= 1),
  input_data TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  is_hidden BOOLEAN NOT NULL DEFAULT true,
  points_weight INT NOT NULL DEFAULT 1 CHECK (points_weight >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (test_suite_version_id, ordinal)
);

CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  problem_version_id UUID NOT NULL REFERENCES problem_versions(id),
  test_suite_version_id UUID NOT NULL REFERENCES test_suite_versions(id),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('python', 'javascript')),
  source_code TEXT NOT NULL,
  code_sha256 TEXT NOT NULL,
  runtime_config JSONB NOT NULL,
  idempotency_key TEXT,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  latest_attempt_number INT NOT NULL DEFAULT 1 CHECK (latest_attempt_number >= 1),
  authoritative_attempt_id UUID,
  final_verdict TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    final_verdict IN (
      'PENDING',
      'ACCEPTED',
      'WRONG_ANSWER',
      'TIME_LIMIT_EXCEEDED',
      'MEMORY_LIMIT_EXCEEDED',
      'OUTPUT_LIMIT_EXCEEDED',
      'COMPILATION_ERROR',
      'RUNTIME_ERROR',
      'JUDGE_FAILURE'
    )
  ),
  awarded_points INT NOT NULL DEFAULT 0 CHECK (awarded_points >= 0),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contest_id, user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS judging_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL CHECK (attempt_number >= 1),
  problem_version_id UUID NOT NULL REFERENCES problem_versions(id),
  test_suite_version_id UUID NOT NULL REFERENCES test_suite_versions(id),
  runtime_config JSONB NOT NULL,
  reason TEXT NOT NULL DEFAULT 'initial_submission' CHECK (reason IN ('initial_submission', 'organizer_rejudge')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded')),
  verdict TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    verdict IN (
      'PENDING',
      'ACCEPTED',
      'WRONG_ANSWER',
      'TIME_LIMIT_EXCEEDED',
      'MEMORY_LIMIT_EXCEEDED',
      'OUTPUT_LIMIT_EXCEEDED',
      'COMPILATION_ERROR',
      'RUNTIME_ERROR',
      'JUDGE_FAILURE'
    )
  ),
  awarded_points INT NOT NULL DEFAULT 0 CHECK (awarded_points >= 0),
  execution_time_ms INT,
  memory_kb INT,
  retry_count INT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries INT NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  worker_id TEXT,
  fencing_token BIGINT,
  lease_expires_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_mode TEXT NOT NULL DEFAULT 'docker',
  test_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (submission_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS contest_standings (
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_points INT NOT NULL DEFAULT 0,
  total_penalty_seconds INT NOT NULL DEFAULT 0,
  solved_count INT NOT NULL DEFAULT 0,
  last_accepted_at TIMESTAMPTZ,
  problem_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contest_id, user_id)
);

-- Baseline indexes for worker queue claiming and foreign key lookups
CREATE INDEX IF NOT EXISTS idx_judging_attempts_queue
  ON judging_attempts (status, available_at, id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_judging_attempts_submission
  ON judging_attempts (submission_id, attempt_number DESC);

