import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../db/database.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { parsePagination } from '../common/validation/validator';

const STUDENT_ERROR_VERDICTS = new Set([
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'OUTPUT_LIMIT_EXCEEDED',
  'COMPILATION_ERROR',
  'RUNTIME_ERROR',
]);

export interface ProblemStandingDetail {
  problem_id: string;
  problem_code: string;
  solved: boolean;
  points: number;
  wrong_attempts: number;
  penalty_seconds: number;
  accepted_at: string | null;
  authoritative_submission_id: string | null;
}

export interface ComputedStanding {
  user_id: string;
  total_points: number;
  total_penalty_seconds: number;
  solved_count: number;
  last_accepted_at: string | null;
  problem_breakdown: Record<string, ProblemStandingDetail>;
}

@Injectable()
export class StandingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly orgsService: OrganizationsService,
  ) {}

  public async recomputeUserStandingInTx(
    client: PoolClient,
    contestId: string,
    organizationId: string,
    userId: string,
  ): Promise<ComputedStanding> {
    // Lock the participant row to serialize concurrent out-of-order completions for this user
    await client.query(
      `SELECT id FROM contest_participations
       WHERE contest_id = $1 AND user_id = $2
       FOR UPDATE`,
      [contestId, userId],
    );

    const contestRes = await client.query<{
      starts_at: Date;
      penalty_minutes: number;
    }>(
      `SELECT starts_at, penalty_minutes FROM contests WHERE id = $1`,
      [contestId],
    );
    const contest = contestRes.rows[0];
    const contestStartsMs = new Date(contest.starts_at).getTime();
    const penaltySecondsPerWrong = (contest.penalty_minutes ?? 20) * 60;

    // Fetch all authoritative completed/failed submissions for this user in deterministic chronological order
    const subsRes = await client.query<{
      submission_id: string;
      problem_id: string;
      problem_code: string;
      submitted_at: Date;
      verdict: string;
      awarded_points: number;
    }>(
      `SELECT s.id AS submission_id,
              s.problem_id,
              p.code AS problem_code,
              s.submitted_at,
              ja.verdict,
              ja.awarded_points
       FROM submissions s
       JOIN judging_attempts ja ON ja.id = s.authoritative_attempt_id
       JOIN problems p ON p.id = s.problem_id
       WHERE s.contest_id = $1
         AND s.user_id = $2
         AND s.authoritative_attempt_id IS NOT NULL
       ORDER BY s.submitted_at ASC, s.id ASC`,
      [contestId, userId],
    );

    const breakdown: Record<string, ProblemStandingDetail> = {};

    for (const row of subsRes.rows) {
      let probState = breakdown[row.problem_code];
      if (!probState) {
        probState = {
          problem_id: row.problem_id,
          problem_code: row.problem_code,
          solved: false,
          points: 0,
          wrong_attempts: 0,
          penalty_seconds: 0,
          accepted_at: null,
          authoritative_submission_id: null,
        };
        breakdown[row.problem_code] = probState;
      }

      if (probState.solved) {
        // Subsequent submissions after first ACCEPTED do not add penalty or duplicate score
        continue;
      }

      if (row.verdict === 'ACCEPTED') {
        const submittedMs = new Date(row.submitted_at).getTime();
        const solveTimeSeconds = Math.max(
          0,
          Math.floor((submittedMs - contestStartsMs) / 1000),
        );
        probState.solved = true;
        probState.points = row.awarded_points;
        probState.penalty_seconds =
          solveTimeSeconds + probState.wrong_attempts * penaltySecondsPerWrong;
        probState.accepted_at = new Date(row.submitted_at).toISOString();
        probState.authoritative_submission_id = row.submission_id;
      } else if (STUDENT_ERROR_VERDICTS.has(row.verdict)) {
        probState.wrong_attempts += 1;
        probState.authoritative_submission_id = row.submission_id;
      } else {
        // JUDGE_FAILURE or PENDING: never penalize student or increment wrong_attempts!
      }
    }

    let totalPoints = 0;
    let totalPenaltySeconds = 0;
    let solvedCount = 0;
    let lastAcceptedAtMs: number | null = null;

    for (const prob of Object.values(breakdown)) {
      if (prob.solved) {
        totalPoints += prob.points;
        totalPenaltySeconds += prob.penalty_seconds;
        solvedCount += 1;
        if (prob.accepted_at) {
          const ms = new Date(prob.accepted_at).getTime();
          if (lastAcceptedAtMs === null || ms > lastAcceptedAtMs) {
            lastAcceptedAtMs = ms;
          }
        }
      }
    }

    const lastAcceptedAtIso =
      lastAcceptedAtMs !== null ? new Date(lastAcceptedAtMs).toISOString() : null;

    await client.query(
      `INSERT INTO contest_standings (
         contest_id, organization_id, user_id,
         total_points, total_penalty_seconds, solved_count,
         last_accepted_at, problem_breakdown, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
       ON CONFLICT (contest_id, user_id) DO UPDATE SET
         total_points = EXCLUDED.total_points,
         total_penalty_seconds = EXCLUDED.total_penalty_seconds,
         solved_count = EXCLUDED.solved_count,
         last_accepted_at = EXCLUDED.last_accepted_at,
         problem_breakdown = EXCLUDED.problem_breakdown,
         updated_at = NOW()`,
      [
        contestId,
        organizationId,
        userId,
        totalPoints,
        totalPenaltySeconds,
        solvedCount,
        lastAcceptedAtIso,
        JSON.stringify(breakdown),
      ],
    );

    return {
      user_id: userId,
      total_points: totalPoints,
      total_penalty_seconds: totalPenaltySeconds,
      solved_count: solvedCount,
      last_accepted_at: lastAcceptedAtIso,
      problem_breakdown: breakdown,
    };
  }

  public async getLeaderboard(
    orgId: string,
    contestId: string,
    query: Record<string, unknown>,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );
    const { limit, offset } = parsePagination(query, 50, 200);

    const [rowsRes, countRes] = await Promise.all([
      this.db.query(
        `SELECT cs.contest_id,
                cs.user_id,
                u.display_name,
                u.email,
                cs.total_points,
                cs.total_penalty_seconds,
                cs.solved_count,
                cs.last_accepted_at,
                cs.problem_breakdown,
                cs.updated_at
         FROM contest_standings cs
         JOIN users u ON u.id = cs.user_id
         WHERE cs.contest_id = $1 AND cs.organization_id = $2
         ORDER BY cs.total_points DESC,
                  cs.total_penalty_seconds ASC,
                  cs.last_accepted_at ASC NULLS LAST,
                  cs.user_id ASC
         LIMIT $3 OFFSET $4`,
        [contestId, orgId, limit, offset],
      ),
      this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM contest_standings
         WHERE contest_id = $1 AND organization_id = $2`,
        [contestId, orgId],
      ),
    ]);

    const entries = rowsRes.rows.map((row, idx) => ({
      rank: offset + idx + 1,
      user_id: row.user_id,
      display_name: row.display_name,
      total_points: row.total_points,
      total_penalty_seconds: row.total_penalty_seconds,
      solved_count: row.solved_count,
      last_accepted_at: row.last_accepted_at,
      problem_breakdown: row.problem_breakdown,
      updated_at: row.updated_at,
    }));

    return {
      contest_id: contestId,
      organization_id: orgId,
      entries,
      pagination: {
        limit,
        offset,
        total: Number(countRes.rows[0]?.total || 0),
      },
    };
  }

  public async rebuildStandings(orgId: string, contestId: string) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );

    const beforeSnapshot = await this.getLeaderboard(orgId, contestId, {
      limit: 200,
      offset: 0,
    });

    await this.db.withTransaction(async (client) => {
      const participantsRes = await client.query<{ user_id: string }>(
        `SELECT user_id FROM contest_participations
         WHERE contest_id = $1 AND organization_id = $2
         ORDER BY user_id ASC`,
        [contestId, orgId],
      );

      await client.query(
        `DELETE FROM contest_standings WHERE contest_id = $1 AND organization_id = $2`,
        [contestId, orgId],
      );

      for (const p of participantsRes.rows) {
        await this.recomputeUserStandingInTx(
          client,
          contestId,
          orgId,
          p.user_id,
        );
      }
    });

    const afterSnapshot = await this.getLeaderboard(orgId, contestId, {
      limit: 200,
      offset: 0,
    });

    const normalize = (entries: any[]) =>
      entries.map((e) => ({
        rank: e.rank,
        user_id: e.user_id,
        total_points: e.total_points,
        total_penalty_seconds: e.total_penalty_seconds,
        solved_count: e.solved_count,
        last_accepted_at: e.last_accepted_at
          ? new Date(e.last_accepted_at).toISOString()
          : null,
        problem_breakdown: e.problem_breakdown,
      }));

    const beforeNorm = normalize(beforeSnapshot.entries);
    const afterNorm = normalize(afterSnapshot.entries);
    const isConsistent =
      JSON.stringify(beforeNorm) === JSON.stringify(afterNorm);

    return {
      contest_id: contestId,
      organization_id: orgId,
      consistent_with_serving_path: isConsistent,
      participant_count: afterNorm.length,
      entries: afterSnapshot.entries,
    };
  }
}
