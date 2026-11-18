import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  createBusinessRuleError,
  createNotFoundError,
  createValidationError,
} from '../common/errors/domain-errors';
import {
  assertEnum,
  assertIntInRange,
  assertIsoDate,
  assertNonEmptyString,
  assertUuid,
  parsePagination,
} from '../common/validation/validator';
import { AuthenticatedActor } from '../auth/auth.service';

export type ContestState = 'scheduled' | 'open' | 'closed';

export interface ContestRecord {
  id: string;
  organization_id: string;
  slug: string;
  title: string;
  description: string;
  starts_at: Date | string;
  ends_at: Date | string;
  penalty_minutes: number;
  status_override: 'force_open' | 'force_closed' | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class ContestsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OrganizationsService)
    private readonly orgsService: OrganizationsService,
  ) {}

  public computeContestState(
    contest: Pick<ContestRecord, 'starts_at' | 'ends_at' | 'status_override'>,
    now: Date = new Date(),
  ): ContestState {
    if (contest.status_override === 'force_open') {
      return 'open';
    }
    if (contest.status_override === 'force_closed') {
      return 'closed';
    }
    const startsAt = new Date(contest.starts_at).getTime();
    const endsAt = new Date(contest.ends_at).getTime();
    const current = now.getTime();

    if (current < startsAt) {
      return 'scheduled';
    }
    if (current >= endsAt) {
      return 'closed';
    }
    return 'open';
  }

  public enrichContest(contest: ContestRecord, now: Date = new Date()) {
    return {
      ...contest,
      state: this.computeContestState(contest, now),
    };
  }

  public async createContest(
    orgId: string,
    actor: AuthenticatedActor,
    body: Record<string, any>,
  ) {
    assertUuid(orgId, 'orgId');
    const id = body.id ? assertUuid(body.id, 'id') : randomUUID();
    const title = assertNonEmptyString(body.title, 'title', 200);
    const slug = body.slug
      ? assertNonEmptyString(body.slug, 'slug', 100).toLowerCase()
      : `contest-${id.slice(0, 8)}`;
    const description =
      typeof body.description === 'string' ? body.description.trim() : '';

    const startsAt = body.startsAt
      ? assertIsoDate(body.startsAt, 'startsAt')
      : new Date(Date.now() - 60_000);
    const endsAt = body.endsAt
      ? assertIsoDate(body.endsAt, 'endsAt')
      : new Date(Date.now() + 24 * 3600_000);

    if (endsAt.getTime() <= startsAt.getTime()) {
      throw createValidationError(
        'INVALID_CONTEST_WINDOW',
        'endsAt must be strictly greater than startsAt',
        { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      );
    }

    const penaltyMinutes =
      body.penaltyMinutes !== undefined
        ? assertIntInRange(body.penaltyMinutes, 'penaltyMinutes', 0, 1440)
        : 20;

    let statusOverride: 'force_open' | 'force_closed' | null = null;
    if (body.statusOverride !== undefined && body.statusOverride !== null) {
      statusOverride = assertEnum<'force_open' | 'force_closed'>(
        body.statusOverride,
        'statusOverride',
        ['force_open', 'force_closed'],
      );
    }

    return this.db.withTransaction(async (client) => {
      const slugCheck = await client.query(
        `SELECT id FROM contests WHERE organization_id = $1 AND slug = $2 AND id <> $3`,
        [orgId, slug, id],
      );
      if ((slugCheck.rowCount ?? 0) > 0) {
        throw createBusinessRuleError(
          'CONTEST_SLUG_CONFLICT',
          `Contest slug '${slug}' already exists in this organization`,
        );
      }

      const res = await client.query<ContestRecord>(
        `INSERT INTO contests (
           id, organization_id, slug, title, description,
           starts_at, ends_at, penalty_minutes, status_override, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           starts_at = EXCLUDED.starts_at,
           ends_at = EXCLUDED.ends_at,
           penalty_minutes = EXCLUDED.penalty_minutes,
           status_override = EXCLUDED.status_override,
           updated_at = NOW()
         RETURNING *`,
        [
          id,
          orgId,
          slug,
          title,
          description,
          startsAt.toISOString(),
          endsAt.toISOString(),
          penaltyMinutes,
          statusOverride,
          actor.userId,
        ],
      );

      return this.enrichContest(res.rows[0]);
    });
  }

  public async updateContest(
    orgId: string,
    contestId: string,
    body: Record<string, any>,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );

    return this.db.withTransaction(async (client) => {
      const currentRes = await client.query<ContestRecord>(
        `SELECT * FROM contests WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [contestId, orgId],
      );
      if (currentRes.rowCount === 0) {
        throw createNotFoundError('CONTEST_NOT_FOUND', 'Contest not found');
      }
      const current = currentRes.rows[0];

      const startsAt =
        body.startsAt !== undefined
          ? assertIsoDate(body.startsAt, 'startsAt')
          : new Date(current.starts_at);
      const endsAt =
        body.endsAt !== undefined
          ? assertIsoDate(body.endsAt, 'endsAt')
          : new Date(current.ends_at);

      if (endsAt.getTime() <= startsAt.getTime()) {
        throw createValidationError(
          'INVALID_CONTEST_WINDOW',
          'endsAt must be strictly greater than startsAt',
        );
      }

      const penaltyMinutes =
        body.penaltyMinutes !== undefined
          ? assertIntInRange(body.penaltyMinutes, 'penaltyMinutes', 0, 1440)
          : current.penalty_minutes;

      let statusOverride = current.status_override;
      if (body.statusOverride !== undefined) {
        statusOverride =
          body.statusOverride === null
            ? null
            : assertEnum<'force_open' | 'force_closed'>(
                body.statusOverride,
                'statusOverride',
                ['force_open', 'force_closed'],
              );
      }

      const title =
        body.title !== undefined
          ? assertNonEmptyString(body.title, 'title', 200)
          : current.title;

      const updatedRes = await client.query<ContestRecord>(
        `UPDATE contests
         SET title = $1,
             starts_at = $2,
             ends_at = $3,
             penalty_minutes = $4,
             status_override = $5,
             updated_at = NOW()
         WHERE id = $6 AND organization_id = $7
         RETURNING *`,
        [
          title,
          startsAt.toISOString(),
          endsAt.toISOString(),
          penaltyMinutes,
          statusOverride,
          contestId,
          orgId,
        ],
      );

      return this.enrichContest(updatedRes.rows[0]);
    });
  }

  public async getContest(orgId: string, contestId: string) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );
    const res = await this.db.query<ContestRecord>(
      `SELECT * FROM contests WHERE id = $1 AND organization_id = $2`,
      [contestId, orgId],
    );
    if (res.rowCount === 0) {
      throw createNotFoundError('CONTEST_NOT_FOUND', 'Contest not found');
    }
    return this.enrichContest(res.rows[0]);
  }

  public async listContests(orgId: string, query: Record<string, unknown>) {
    assertUuid(orgId, 'orgId');
    const { limit, offset } = parsePagination(query);

    const [itemsRes, countRes] = await Promise.all([
      this.db.query<ContestRecord>(
        `SELECT *
         FROM contests
         WHERE organization_id = $1
         ORDER BY starts_at DESC, id ASC
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset],
      ),
      this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM contests WHERE organization_id = $1`,
        [orgId],
      ),
    ]);

    const now = new Date();
    return {
      items: itemsRes.rows.map((c) => this.enrichContest(c, now)),
      pagination: {
        limit,
        offset,
        total: Number(countRes.rows[0]?.total || 0),
      },
    };
  }

  public async joinContest(
    orgId: string,
    contestId: string,
    actor: AuthenticatedActor,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );

    return this.db.withTransaction(async (client) => {
      const contestRes = await client.query<ContestRecord>(
        `SELECT * FROM contests WHERE id = $1 AND organization_id = $2`,
        [contestId, orgId],
      );
      if (contestRes.rowCount === 0) {
        throw createNotFoundError('CONTEST_NOT_FOUND', 'Contest not found');
      }
      const contest = contestRes.rows[0];
      const state = this.computeContestState(contest);

      if (state === 'closed') {
        throw createBusinessRuleError(
          'CONTEST_CLOSED',
          'Cannot join a contest that has already closed',
          409,
          { contestId, state },
        );
      }

      const partRes = await client.query(
        `INSERT INTO contest_participations (contest_id, organization_id, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (contest_id, user_id)
         DO UPDATE SET contest_id = EXCLUDED.contest_id
         RETURNING id, contest_id, organization_id, user_id, joined_at`,
        [contestId, orgId, actor.userId],
      );

      await client.query(
        `INSERT INTO contest_standings (
           contest_id, organization_id, user_id,
           total_points, total_penalty_seconds, solved_count, problem_breakdown
         )
         VALUES ($1, $2, $3, 0, 0, 0, '{}'::jsonb)
         ON CONFLICT (contest_id, user_id) DO NOTHING`,
        [contestId, orgId, actor.userId],
      );

      return {
        ...partRes.rows[0],
        contest_state: state,
      };
    });
  }
}
