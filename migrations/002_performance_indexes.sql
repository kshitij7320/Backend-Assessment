-- Stage 4 Performance Optimization: Composite Covering Indexes for Standing Recomputation,
-- Submission Feeds, and Deterministic Tie-Broken Leaderboard Reads

CREATE INDEX IF NOT EXISTS idx_submissions_user_standing_recompute
  ON submissions (contest_id, user_id, submitted_at ASC, id ASC)
  WHERE authoritative_attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_contest_feed
  ON submissions (contest_id, organization_id, submitted_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS idx_contest_standings_leaderboard_order
  ON contest_standings (
    contest_id,
    organization_id,
    total_points DESC,
    total_penalty_seconds ASC,
    last_accepted_at ASC NULLS LAST,
    user_id ASC
  );

