import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ContestsService, ContestRecord } from '../contests/contests.service';
import { WorkerService } from '../judge/worker.service';
import { FaultInjectionService } from '../judge/fault-injection.service';
import { StructuredLoggerService } from '../common/logger/structured-logger.service';
import {
  createAuthorizationError,
  createBusinessRuleError,
  createNotFoundError,
  createValidationError,
} from '../common/errors/domain-errors';
import {
  assertEnum,
  assertNonEmptyString,
  assertRawString,
  assertUuid,
  parsePagination,
} from '../common/validation/validator';
import { AuthenticatedActor, OrgRole } from '../auth/auth.service';
import { ExecutionMode } from '../judge/runner.interface';

@Injectable()
export class SubmissionsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OrganizationsService)
    private readonly orgsService: OrganizationsService,
    @Inject(ContestsService)
    private readonly contestsService: ContestsService,
    @Inject(WorkerService) private readonly workerService: WorkerService,
    @Inject(FaultInjectionService)
    private readonly faultInjection: FaultInjectionService,
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
  ) {}

  private computeRequestFingerprint(params: {
    contestId: string;
    problemId: string;
    language: string;
    sourceCode: string;
  }): string {
    const canonical = JSON.stringify({
      contestId: params.contestId,
      problemId: params.problemId,
      language: params.language,
      sourceCode: params.sourceCode,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  public async createSubmission(
    orgId: string,
    contestId: string,
    actor: AuthenticatedActor,
    body: Record<string, any>,
    idempotencyHeader?: string,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );

    const problemId = assertUuid(body.problemId, 'problemId');
    await this.orgsService.assertObjectBelongsToOrg(
      'problems',
      problemId,
      orgId,
      'problemId',
    );

    const language = assertEnum(body.language, 'language', [
      'python',
      'javascript',
    ]);
    const sourceCode = assertRawString(body.sourceCode, 'sourceCode', 100_000);
    const codeSha256 = createHash('sha256').update(sourceCode).digest('hex');

    const rawIdemKey = idempotencyHeader ?? body.idempotencyKey;
    const idempotencyKey =
      rawIdemKey !== undefined && rawIdemKey !== null
        ? assertNonEmptyString(rawIdemKey, 'idempotencyKey', 255)
        : null;

    const executionMode: ExecutionMode =
      body.executionMode !== undefined
        ? assertEnum(body.executionMode, 'executionMode', [
            'docker',
            'deterministic-double',
          ])
        : ((process.env.JUDGE_EXECUTION_MODE as ExecutionMode) || 'docker');

    const requestFingerprint = this.computeRequestFingerprint({
      contestId,
      problemId,
      language,
      sourceCode,
    });

    const txResult = await this.db.withTransaction(async (client) => {
      // 1. Check if this idempotency key already exists for (contest_id, user_id, idempotency_key)
      if (idempotencyKey) {
        const existingCheck = await client.query(
          `SELECT * FROM submissions
           WHERE contest_id = $1 AND user_id = $2 AND idempotency_key = $3`,
          [contestId, actor.userId, idempotencyKey],
        );
        if ((existingCheck.rowCount ?? 0) > 0) {
          const existing = existingCheck.rows[0];
          if (existing.request_fingerprint !== requestFingerprint) {
            throw createBusinessRuleError(
              'IDEMPOTENCY_KEY_CONFLICT',
              'Idempotency key was already used with different code or parameters',
              409,
              { idempotencyKey, existingSubmissionId: existing.id },
            );
          }
          const attemptsRes = await client.query(
            `SELECT id, attempt_number, status, verdict, execution_mode, created_at
             FROM judging_attempts
             WHERE submission_id = $1
             ORDER BY attempt_number DESC`,
            [existing.id],
          );
          return {
            created: false,
            submission: existing,
            latestAttempt: attemptsRes.rows[0],
          };
        }
      }

      // 2. Verify contest window & participation eligibility
      const contestRes = await client.query<ContestRecord>(
        `SELECT * FROM contests WHERE id = $1 AND organization_id = $2`,
        [contestId, orgId],
      );
      if (contestRes.rowCount === 0) {
        throw createNotFoundError('CONTEST_NOT_FOUND', 'Contest not found');
      }
      const contestState = this.contestsService.computeContestState(
        contestRes.rows[0],
      );
      if (contestState === 'scheduled') {
        throw createBusinessRuleError(
          'CONTEST_NOT_STARTED',
          'Submissions are not accepted before the contest opens',
          409,
        );
      }
      if (contestState === 'closed') {
        throw createBusinessRuleError(
          'CONTEST_CLOSED',
          'Contest has closed; new submissions are no longer accepted',
          409,
        );
      }

      const partRes = await client.query(
        `SELECT id FROM contest_participations
         WHERE contest_id = $1 AND user_id = $2`,
        [contestId, actor.userId],
      );
      if (partRes.rowCount === 0) {
        throw createBusinessRuleError(
          'NOT_CONTEST_PARTICIPANT',
          'Actor must join the contest before submitting solutions',
          409,
        );
      }

      // 3. Snapshot current problem_version_id, test_suite_version_id, and runtime_config
      const probRes = await client.query(
        `SELECT p.id, p.contest_id, p.current_version_id, p.current_test_suite_version_id,
                pv.time_limit_ms, pv.memory_limit_mb, pv.output_limit_kb, pv.max_points, pv.runtime_config
         FROM problems p
         JOIN problem_versions pv ON pv.id = p.current_version_id
         WHERE p.id = $1 AND p.contest_id = $2 AND p.organization_id = $3`,
        [problemId, contestId, orgId],
      );
      if (probRes.rowCount === 0) {
        throw createNotFoundError(
          'PROBLEM_NOT_FOUND',
          'Problem does not belong to this contest',
        );
      }
      const prob = probRes.rows[0];

      const runtimeConfigSnapshot = {
        timeLimitMs: prob.time_limit_ms,
        memoryLimitMb: prob.memory_limit_mb,
        outputLimitKb: prob.output_limit_kb,
        pidsLimit: 32,
        maxPoints: prob.max_points,
      };

      const requestedSubId = body.id ? assertUuid(body.id, 'id') : randomUUID();

      // 4. Insert submission using ON CONFLICT DO NOTHING for race-free idempotency under simultaneous requests
      const insertRes = await client.query(
        `INSERT INTO submissions (
           id, organization_id, contest_id, problem_id,
           problem_version_id, test_suite_version_id,
           user_id, language, source_code, code_sha256,
           runtime_config, idempotency_key, request_fingerprint,
           status, latest_attempt_number, final_verdict, awarded_points
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, 'queued', 1, 'PENDING', 0)
         ON CONFLICT (contest_id, user_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          requestedSubId,
          orgId,
          contestId,
          problemId,
          prob.current_version_id,
          prob.current_test_suite_version_id,
          actor.userId,
          language,
          sourceCode,
          codeSha256,
          JSON.stringify(runtimeConfigSnapshot),
          idempotencyKey,
          requestFingerprint,
        ],
      );

      if (insertRes.rowCount === 0 && idempotencyKey) {
        // Simultaneous request won the race! Verify fingerprint and return existing submission.
        const racedRes = await client.query(
          `SELECT * FROM submissions
           WHERE contest_id = $1 AND user_id = $2 AND idempotency_key = $3`,
          [contestId, actor.userId, idempotencyKey],
        );
        const raced = racedRes.rows[0];
        if (raced.request_fingerprint !== requestFingerprint) {
          throw createBusinessRuleError(
            'IDEMPOTENCY_KEY_CONFLICT',
            'Idempotency key was already used with different code or parameters',
            409,
            { idempotencyKey, existingSubmissionId: raced.id },
          );
        }
        const attemptsRes = await client.query(
          `SELECT id, attempt_number, status, verdict, execution_mode, created_at
           FROM judging_attempts
           WHERE submission_id = $1
           ORDER BY attempt_number DESC`,
          [raced.id],
        );
        return {
          created: false,
          submission: raced,
          latestAttempt: attemptsRes.rows[0],
        };
      }

      const submission = insertRes.rows[0];
      const maxRetries =
        body.maxRetries !== undefined ? Number(body.maxRetries) : 3;

      const attemptRes = await client.query(
        `INSERT INTO judging_attempts (
           submission_id, organization_id, contest_id, attempt_number,
           problem_version_id, test_suite_version_id, runtime_config,
           reason, status, verdict, max_retries, execution_mode
         )
         VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, 'initial_submission', 'queued', 'PENDING', $7, $8)
         RETURNING id, attempt_number, status, verdict, execution_mode, created_at`,
        [
          submission.id,
          orgId,
          contestId,
          prob.current_version_id,
          prob.current_test_suite_version_id,
          JSON.stringify(runtimeConfigSnapshot),
          maxRetries,
          executionMode,
        ],
      );

      return {
        created: true,
        submission,
        latestAttempt: attemptRes.rows[0],
      };
    });

    const { created, submission, latestAttempt } = txResult;

    this.logger.info(
      created ? 'submission_created' : 'submission_idempotent_replay',
      {
        submission_id: submission.id,
        attempt_id: latestAttempt?.id,
        organization_id: orgId,
        actor_id: actor.userId,
        idempotent_replay: !created,
      },
    );

    if (created) {
      if (
        this.faultInjection.consumeFailAfterCommitBeforeDispatch(submission.id)
      ) {
        this.logger.warn('dispatch_interrupted_after_commit', {
          submission_id: submission.id,
          attempt_id: latestAttempt?.id,
          organization_id: orgId,
        });
      } else {
        this.workerService.notifyNewWork();
      }
    }

    return {
      submission_id: submission.id,
      organization_id: submission.organization_id,
      contest_id: submission.contest_id,
      problem_id: submission.problem_id,
      problem_version_id: submission.problem_version_id,
      test_suite_version_id: submission.test_suite_version_id,
      user_id: submission.user_id,
      language: submission.language,
      code_sha256: submission.code_sha256,
      status: submission.status,
      final_verdict: submission.final_verdict,
      awarded_points: submission.awarded_points,
      latest_attempt_number: submission.latest_attempt_number,
      authoritative_attempt_id: submission.authoritative_attempt_id,
      idempotent_replay: !created,
      latest_attempt: latestAttempt,
      submitted_at: submission.submitted_at,
    };
  }

  public async getSubmission(
    orgId: string,
    contestId: string,
    submissionId: string,
    actor: AuthenticatedActor,
    role: OrgRole,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );
    await this.orgsService.assertObjectBelongsToOrg(
      'submissions',
      submissionId,
      orgId,
      'submissionId',
    );

    const subRes = await this.db.query(
      `SELECT * FROM submissions WHERE id = $1 AND contest_id = $2 AND organization_id = $3`,
      [submissionId, contestId, orgId],
    );
    if (subRes.rowCount === 0) {
      throw createNotFoundError(
        'SUBMISSION_NOT_FOUND',
        'Submission not found in this contest',
      );
    }
    const submission = subRes.rows[0];

    // Stage 2 & Stage 4: Participants cannot view other participants' submissions or source code!
    if (role === 'participant' && submission.user_id !== actor.userId) {
      throw createAuthorizationError(
        'PRIVATE_SUBMISSION_ACCESS_DENIED',
        'Participants may only inspect their own submissions',
        { submissionId },
      );
    }

    const attemptsRes = await this.db.query(
      `SELECT * FROM judging_attempts
       WHERE submission_id = $1
       ORDER BY attempt_number DESC`,
      [submissionId],
    );

    if (role === 'participant') {
      // Redact hidden test details and internal judge fields for participants
      const sanitizedAttempts = attemptsRes.rows.map((a) => ({
        id: a.id,
        attempt_number: a.attempt_number,
        problem_version_id: a.problem_version_id,
        test_suite_version_id: a.test_suite_version_id,
        status: a.status,
        verdict: a.verdict,
        awarded_points: a.awarded_points,
        execution_time_ms: a.execution_time_ms,
        execution_mode: a.execution_mode,
        test_results: Array.isArray(a.test_results)
          ? a.test_results.map((tr: any) => ({
              ordinal: tr.ordinal,
              is_hidden: tr.is_hidden,
              verdict: tr.verdict,
              execution_time_ms: tr.execution_time_ms,
            }))
          : [],
        created_at: a.created_at,
        completed_at: a.completed_at,
      }));

      return {
        id: submission.id,
        organization_id: submission.organization_id,
        contest_id: submission.contest_id,
        problem_id: submission.problem_id,
        problem_version_id: submission.problem_version_id,
        test_suite_version_id: submission.test_suite_version_id,
        user_id: submission.user_id,
        language: submission.language,
        source_code: submission.source_code,
        code_sha256: submission.code_sha256,
        runtime_config: submission.runtime_config,
        status: submission.status,
        latest_attempt_number: submission.latest_attempt_number,
        authoritative_attempt_id: submission.authoritative_attempt_id,
        final_verdict: submission.final_verdict,
        awarded_points: submission.awarded_points,
        submitted_at: submission.submitted_at,
        completed_at: submission.completed_at,
        attempts: sanitizedAttempts,
      };
    }

    // Organizer receives full diagnostic details
    return {
      ...submission,
      attempts: attemptsRes.rows,
    };
  }

  public async listSubmissions(
    orgId: string,
    contestId: string,
    actor: AuthenticatedActor,
    role: OrgRole,
    query: Record<string, unknown>,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );
    const { limit, offset } = parsePagination(query);

    const filterUserId =
      role === 'participant'
        ? actor.userId
        : typeof query.userId === 'string'
          ? assertUuid(query.userId, 'userId')
          : null;

    const params: unknown[] = [contestId, orgId];
    let whereClause = `WHERE s.contest_id = $1 AND s.organization_id = $2`;
    if (filterUserId) {
      params.push(filterUserId);
      whereClause += ` AND s.user_id = $${params.length}`;
    }

    const [itemsRes, countRes] = await Promise.all([
      this.db.query(
        `SELECT s.id, s.organization_id, s.contest_id, s.problem_id,
                s.problem_version_id, s.test_suite_version_id,
                s.user_id, s.language, s.code_sha256,
                s.status, s.latest_attempt_number, s.authoritative_attempt_id,
                s.final_verdict, s.awarded_points, s.submitted_at, s.completed_at
         FROM submissions s
         ${whereClause}
         ORDER BY s.submitted_at DESC, s.id ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM submissions s ${whereClause}`,
        params,
      ),
    ]);

    return {
      items: itemsRes.rows,
      pagination: {
        limit,
        offset,
        total: Number(countRes.rows[0]?.total || 0),
      },
    };
  }

  public async rejudgeSubmission(
    orgId: string,
    contestId: string,
    submissionId: string,
    actor: AuthenticatedActor,
    body: Record<string, any>,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );
    await this.orgsService.assertObjectBelongsToOrg(
      'submissions',
      submissionId,
      orgId,
      'submissionId',
    );

    const executionMode: ExecutionMode =
      body.executionMode !== undefined
        ? assertEnum(body.executionMode, 'executionMode', [
            'docker',
            'deterministic-double',
          ])
        : ((process.env.JUDGE_EXECUTION_MODE as ExecutionMode) || 'docker');

    const result = await this.db.withTransaction(async (client) => {
      const subRes = await client.query(
        `SELECT * FROM submissions
         WHERE id = $1 AND contest_id = $2 AND organization_id = $3
         FOR UPDATE`,
        [submissionId, contestId, orgId],
      );
      if (subRes.rowCount === 0) {
        throw createNotFoundError(
          'SUBMISSION_NOT_FOUND',
          'Submission not found in this contest',
        );
      }
      const submission = subRes.rows[0];

      const probRes = await client.query(
        `SELECT * FROM problems WHERE id = $1`,
        [submission.problem_id],
      );
      const problem = probRes.rows[0];

      const targetPvId = body.problemVersionId
        ? assertUuid(body.problemVersionId, 'problemVersionId')
        : problem.current_version_id;
      const targetTsvId = body.testSuiteVersionId
        ? assertUuid(body.testSuiteVersionId, 'testSuiteVersionId')
        : problem.current_test_suite_version_id;

      const pvRes = await client.query(
        `SELECT * FROM problem_versions WHERE id = $1 AND problem_id = $2`,
        [targetPvId, submission.problem_id],
      );
      if (pvRes.rowCount === 0) {
        throw createValidationError(
          'INVALID_PROBLEM_VERSION',
          'Selected problemVersionId does not belong to this submission problem',
          { problemVersionId: targetPvId },
        );
      }
      const pv = pvRes.rows[0];

      const tsvRes = await client.query(
        `SELECT * FROM test_suite_versions WHERE id = $1 AND problem_id = $2`,
        [targetTsvId, submission.problem_id],
      );
      if (tsvRes.rowCount === 0) {
        throw createValidationError(
          'INVALID_TEST_SUITE_VERSION',
          'Selected testSuiteVersionId does not belong to this submission problem',
          { testSuiteVersionId: targetTsvId },
        );
      }

      const runtimeConfigSnapshot = {
        timeLimitMs: pv.time_limit_ms,
        memoryLimitMb: pv.memory_limit_mb,
        outputLimitKb: pv.output_limit_kb,
        pidsLimit: 32,
        maxPoints: pv.max_points,
      };

      const nextAttemptNumber = submission.latest_attempt_number + 1;

      // Mark any still-queued older attempts as superseded so workers skip them
      await client.query(
        `UPDATE judging_attempts
         SET status = 'superseded',
             updated_at = NOW()
         WHERE submission_id = $1
           AND attempt_number < $2
           AND status = 'queued'`,
        [submissionId, nextAttemptNumber],
      );

      await client.query(
        `UPDATE submissions
         SET latest_attempt_number = $1,
             status = 'queued',
             updated_at = NOW()
         WHERE id = $2`,
        [nextAttemptNumber, submissionId],
      );

      const newAttemptRes = await client.query(
        `INSERT INTO judging_attempts (
           submission_id, organization_id, contest_id, attempt_number,
           problem_version_id, test_suite_version_id, runtime_config,
           reason, status, verdict, execution_mode
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'organizer_rejudge', 'queued', 'PENDING', $8)
         RETURNING *`,
        [
          submissionId,
          orgId,
          contestId,
          nextAttemptNumber,
          targetPvId,
          targetTsvId,
          JSON.stringify(runtimeConfigSnapshot),
          executionMode,
        ],
      );

      return {
        submissionId,
        nextAttemptNumber,
        newAttempt: newAttemptRes.rows[0],
      };
    });

    this.logger.info('submission_rejudge_queued', {
      submission_id: submissionId,
      attempt_id: result.newAttempt.id,
      attempt_number: result.nextAttemptNumber,
      organization_id: orgId,
      actor_id: actor.userId,
    });

    this.workerService.notifyNewWork();

    return {
      submission_id: submissionId,
      latest_attempt_number: result.nextAttemptNumber,
      new_attempt: result.newAttempt,
    };
  }
}
