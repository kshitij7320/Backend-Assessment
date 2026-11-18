import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { StandingsService } from '../standings/standings.service';
import { StructuredLoggerService } from '../common/logger/structured-logger.service';
import { DockerRunnerService } from './docker-runner.service';
import { DeterministicRunnerService } from './deterministic-runner.service';
import { FaultInjectionService } from './fault-injection.service';
import {
  ExecutionMode,
  RunnerTestCase,
  SandboxRuntimeConfig,
  SuiteExecutionSummary,
} from './runner.interface';

export interface ClaimedAttemptRow {
  id: string;
  submission_id: string;
  organization_id: string;
  contest_id: string;
  attempt_number: number;
  problem_version_id: string;
  test_suite_version_id: string;
  runtime_config: SandboxRuntimeConfig;
  status: string;
  retry_count: number;
  max_retries: number;
  worker_id: string;
  fencing_token: string;
  execution_mode: ExecutionMode;
}

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private pollTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private activeLoops = 0;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(StandingsService)
    private readonly standingsService: StandingsService,
    @Inject(DockerRunnerService)
    private readonly dockerRunner: DockerRunnerService,
    @Inject(DeterministicRunnerService)
    private readonly deterministicRunner: DeterministicRunnerService,
    @Inject(FaultInjectionService)
    private readonly faultInjection: FaultInjectionService,
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
  ) {
    this.workerId = process.env.WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;
    this.leaseDurationMs = Number(process.env.WORKER_LEASE_DURATION_MS || 15000);
    this.pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 150);
  }

  public onModuleInit(): void {
    if (process.env.WORKER_ENABLED !== 'false') {
      this.startPolling();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.stopPolling();
  }

  public startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public notifyNewWork(): void {
    if (!this.isShuttingDown && process.env.WORKER_ENABLED !== 'false') {
      setImmediate(() => {
        void this.tick();
      });
    }
  }

  public async tick(): Promise<boolean> {
    if (this.isShuttingDown || this.activeLoops >= 4) {
      return false;
    }
    this.activeLoops += 1;
    try {
      await this.expireExhaustedAbandonedAttempts();
      const claimed = await this.claimNextAttempt(
        this.workerId,
        this.leaseDurationMs,
      );
      if (!claimed) {
        return false;
      }
      await this.processClaimedAttempt(claimed);
      return true;
    } catch (err: any) {
      this.logger.error('worker_tick_error', {
        worker_id: this.workerId,
        message: err?.message,
      });
      return false;
    } finally {
      this.activeLoops -= 1;
    }
  }

  /**
   * Transitions any running attempts whose lease has expired AND retry_count >= max_retries
   * to 'failed' with verdict 'JUDGE_FAILURE' so they never stay permanently stuck.
   */
  public async expireExhaustedAbandonedAttempts(): Promise<number> {
    return this.db.withTransaction(async (client) => {
      const expiredRes = await client.query<{
        id: string;
        submission_id: string;
        contest_id: string;
        organization_id: string;
        attempt_number: number;
      }>(
        `UPDATE judging_attempts
         SET status = 'failed',
             verdict = 'JUDGE_FAILURE',
             error_detail = 'Worker lease expired after maximum retries',
             completed_at = NOW(),
             updated_at = NOW()
         WHERE status = 'running'
           AND lease_expires_at <= NOW()
           AND retry_count >= max_retries
         RETURNING id, submission_id, contest_id, organization_id, attempt_number`,
      );

      for (const row of expiredRes.rows) {
        const subRes = await client.query<{
          user_id: string;
          latest_attempt_number: number;
        }>(
          `SELECT user_id, latest_attempt_number
           FROM submissions
           WHERE id = $1
           FOR UPDATE`,
          [row.submission_id],
        );
        if (
          subRes.rowCount &&
          subRes.rows[0].latest_attempt_number === row.attempt_number
        ) {
          await client.query(
            `UPDATE submissions
             SET status = 'failed',
                 final_verdict = 'JUDGE_FAILURE',
                 authoritative_attempt_id = $1,
                 completed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $2`,
            [row.id, row.submission_id],
          );
          await this.standingsService.recomputeUserStandingInTx(
            client,
            row.contest_id,
            row.organization_id,
            subRes.rows[0].user_id,
          );
        }
      }

      return expiredRes.rowCount ?? 0;
    });
  }

  /**
   * Atomically claims either a queued attempt or an abandoned running attempt with expired lease.
   * Assigns a strictly increasing fencing_token from judging_fencing_seq.
   */
  public async claimNextAttempt(
    workerId = this.workerId,
    leaseDurationMs = this.leaseDurationMs,
  ): Promise<ClaimedAttemptRow | null> {
    return this.db.withTransaction(async (client) => {
      const claimRes = await client.query<ClaimedAttemptRow>(
        `WITH candidate AS (
           SELECT id, status
           FROM judging_attempts
           WHERE (status = 'queued' AND available_at <= NOW())
              OR (status = 'running' AND lease_expires_at <= NOW() AND retry_count < max_retries)
           ORDER BY available_at ASC, created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE judging_attempts ja
         SET status = 'running',
             worker_id = $1,
             fencing_token = nextval('judging_fencing_seq'),
             lease_expires_at = NOW() + ($2 || ' milliseconds')::interval,
             retry_count = CASE
               WHEN candidate.status = 'running' THEN ja.retry_count + 1
               ELSE ja.retry_count
             END,
             started_at = COALESCE(ja.started_at, NOW()),
             updated_at = NOW()
         FROM candidate
         WHERE ja.id = candidate.id
         RETURNING ja.*`,
        [workerId, String(leaseDurationMs)],
      );

      if (claimRes.rowCount === 0) {
        return null;
      }

      const attempt = claimRes.rows[0];

      // Mark submission as running if this is the latest attempt and submission is still queued
      await client.query(
        `UPDATE submissions
         SET status = 'running',
             updated_at = NOW()
         WHERE id = $1
           AND latest_attempt_number = $2
           AND status = 'queued'`,
        [attempt.submission_id, attempt.attempt_number],
      );

      this.logger.info('attempt_claimed', {
        service: 'shodh-worker',
        worker_id: workerId,
        submission_id: attempt.submission_id,
        attempt_id: attempt.id,
        fencing_token: Number(attempt.fencing_token),
        organization_id: attempt.organization_id,
        retry_count: attempt.retry_count,
      });

      return attempt;
    });
  }

  /**
   * Forces a competing claim on a specific attempt (used by concurrency test suite
   * to deterministically test competing workers and fencing token protection).
   */
  public async forceReclaimAttempt(
    attemptId: string,
    newWorkerId: string,
    leaseDurationMs = this.leaseDurationMs,
  ): Promise<ClaimedAttemptRow> {
    return this.db.withTransaction(async (client) => {
      const res = await client.query<ClaimedAttemptRow>(
        `UPDATE judging_attempts
         SET status = 'running',
             worker_id = $1,
             fencing_token = nextval('judging_fencing_seq'),
             lease_expires_at = NOW() + ($2 || ' milliseconds')::interval,
             retry_count = retry_count + 1,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [newWorkerId, String(leaseDurationMs), attemptId],
      );
      return res.rows[0];
    });
  }

  public async executeAttemptInSandbox(
    attempt: ClaimedAttemptRow,
  ): Promise<SuiteExecutionSummary> {
    const subRes = await this.db.query<{
      language: 'python' | 'javascript';
      source_code: string;
    }>(`SELECT language, source_code FROM submissions WHERE id = $1`, [
      attempt.submission_id,
    ]);
    const submission = subRes.rows[0];

    const casesRes = await this.db.query<RunnerTestCase>(
      `SELECT id, ordinal, input_data, expected_output, is_hidden, points_weight
       FROM test_cases
       WHERE test_suite_version_id = $1
       ORDER BY ordinal ASC`,
      [attempt.test_suite_version_id],
    );

    const mode: ExecutionMode =
      attempt.execution_mode ||
      (process.env.JUDGE_EXECUTION_MODE as ExecutionMode) ||
      'docker';

    const execInput = {
      submissionId: attempt.submission_id,
      attemptId: attempt.id,
      attemptNumber: attempt.attempt_number,
      retryCount: attempt.retry_count,
      language: submission.language,
      sourceCode: submission.source_code,
      runtimeConfig: attempt.runtime_config,
      testCases: casesRes.rows,
    };

    if (mode === 'deterministic-double') {
      return this.deterministicRunner.executeSuite(execInput);
    }
    return this.dockerRunner.executeSuite(execInput);
  }

  public async processClaimedAttempt(
    attempt: ClaimedAttemptRow,
  ): Promise<{ applied: boolean; reason?: string }> {
    const summary = await this.executeAttemptInSandbox(attempt);

    // Check controllable failpoint: failure after judging but before acknowledging completion
    if (
      this.faultInjection.consumeFailBeforeAck(
        attempt.submission_id,
        attempt.id,
      )
    ) {
      this.logger.warn('worker_fail_before_ack_triggered', {
        service: 'shodh-worker',
        worker_id: attempt.worker_id,
        submission_id: attempt.submission_id,
        attempt_id: attempt.id,
        fencing_token: Number(attempt.fencing_token),
        organization_id: attempt.organization_id,
      });
      return { applied: false, reason: 'FAIL_BEFORE_ACK_INJECTED' };
    }

    return this.completeAttempt(
      attempt.id,
      Number(attempt.fencing_token),
      summary,
      attempt.worker_id,
    );
  }

  /**
   * Commits the outcome of a judging attempt guarded by fencing_token and authoritative attempt rules.
   */
  public async completeAttempt(
    attemptId: string,
    fencingToken: number,
    summary: SuiteExecutionSummary,
    workerId = this.workerId,
  ): Promise<{ applied: boolean; reason?: string; status?: string }> {
    return this.db.withTransaction(async (client) => {
      // 1. Lock the attempt row first
      const attemptRes = await client.query<{
        id: string;
        submission_id: string;
        organization_id: string;
        contest_id: string;
        attempt_number: number;
        status: string;
        fencing_token: string;
        retry_count: number;
        max_retries: number;
      }>(`SELECT * FROM judging_attempts WHERE id = $1 FOR UPDATE`, [
        attemptId,
      ]);

      if (attemptRes.rowCount === 0) {
        return { applied: false, reason: 'ATTEMPT_NOT_FOUND' };
      }

      const currentAttempt = attemptRes.rows[0];

      // 2. Enforce fencing token and state guard!
      if (
        Number(currentAttempt.fencing_token) !== Number(fencingToken) ||
        currentAttempt.status !== 'running'
      ) {
        this.logger.warn('stale_worker_fencing_rejected', {
          service: 'shodh-worker',
          worker_id: workerId,
          submission_id: currentAttempt.submission_id,
          attempt_id: attemptId,
          fencing_token: fencingToken,
          current_fencing_token: Number(currentAttempt.fencing_token),
          current_status: currentAttempt.status,
          organization_id: currentAttempt.organization_id,
        });
        return { applied: false, reason: 'STALE_FENCING_TOKEN' };
      }

      // 3. Lock the parent submission row to check latest_attempt_number
      const subRes = await client.query<{
        id: string;
        user_id: string;
        latest_attempt_number: number;
        authoritative_attempt_id: string | null;
      }>(`SELECT * FROM submissions WHERE id = $1 FOR UPDATE`, [
        currentAttempt.submission_id,
      ]);
      const submission = subRes.rows[0];

      const isLatestAttempt =
        currentAttempt.attempt_number === submission.latest_attempt_number;

      // 4. Handle JUDGE_FAILURE: retry if retries remain and attempt is still latest
      if (summary.verdict === 'JUDGE_FAILURE') {
        if (
          isLatestAttempt &&
          currentAttempt.retry_count < currentAttempt.max_retries
        ) {
          const nextRetry = currentAttempt.retry_count + 1;
          await client.query(
            `UPDATE judging_attempts
             SET status = 'queued',
                 retry_count = $1,
                 available_at = NOW() + INTERVAL '50 milliseconds',
                 lease_expires_at = NULL,
                 error_detail = $2,
                 execution_mode = $3,
                 updated_at = NOW()
             WHERE id = $4 AND fencing_token = $5`,
            [
              nextRetry,
              summary.error_detail || 'Transient runner failure; scheduled retry',
              summary.execution_mode,
              attemptId,
              fencingToken,
            ],
          );

          this.logger.warn('attempt_requeued_after_judge_failure', {
            service: 'shodh-worker',
            worker_id: workerId,
            submission_id: currentAttempt.submission_id,
            attempt_id: attemptId,
            fencing_token: fencingToken,
            retry_count: nextRetry,
            organization_id: currentAttempt.organization_id,
          });

          this.notifyNewWork();
          return { applied: true, status: 'requeued' };
        }

        // Retries exhausted or superseded
        const terminalStatus = isLatestAttempt ? 'failed' : 'superseded';
        await client.query(
          `UPDATE judging_attempts
           SET status = $1,
               verdict = 'JUDGE_FAILURE',
               awarded_points = 0,
               execution_time_ms = $2,
               memory_kb = $3,
               execution_mode = $4,
               test_results = $5::jsonb,
               error_detail = $6,
               completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $7 AND fencing_token = $8`,
          [
            terminalStatus,
            summary.execution_time_ms,
            summary.memory_kb,
            summary.execution_mode,
            JSON.stringify(summary.test_results),
            summary.error_detail || 'Judge infrastructure failure',
            attemptId,
            fencingToken,
          ],
        );

        if (isLatestAttempt) {
          await client.query(
            `UPDATE submissions
             SET status = 'failed',
                 authoritative_attempt_id = $1,
                 final_verdict = 'JUDGE_FAILURE',
                 awarded_points = 0,
                 completed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $2`,
            [attemptId, submission.id],
          );
          await this.standingsService.recomputeUserStandingInTx(
            client,
            currentAttempt.contest_id,
            currentAttempt.organization_id,
            submission.user_id,
          );
        }

        return { applied: true, status: terminalStatus };
      }

      // 5. Normal student verdict completion
      if (!isLatestAttempt) {
        // Delayed result from a replaced attempt! Preserve record as 'superseded' and DO NOT update submission or standings!
        await client.query(
          `UPDATE judging_attempts
           SET status = 'superseded',
               verdict = $1,
               awarded_points = $2,
               execution_time_ms = $3,
               memory_kb = $4,
               execution_mode = $5,
               test_results = $6::jsonb,
               error_detail = $7,
               completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $8 AND fencing_token = $9`,
          [
            summary.verdict,
            summary.awarded_points,
            summary.execution_time_ms,
            summary.memory_kb,
            summary.execution_mode,
            JSON.stringify(summary.test_results),
            summary.error_detail || null,
            attemptId,
            fencingToken,
          ],
        );

        this.logger.info('superseded_attempt_ignored_for_standings', {
          service: 'shodh-worker',
          worker_id: workerId,
          submission_id: submission.id,
          attempt_id: attemptId,
          attempt_number: currentAttempt.attempt_number,
          latest_attempt_number: submission.latest_attempt_number,
          fencing_token: fencingToken,
          organization_id: currentAttempt.organization_id,
        });

        return { applied: true, status: 'superseded' };
      }

      // Authoritative attempt completed!
      await client.query(
        `UPDATE judging_attempts
         SET status = 'completed',
             verdict = $1,
             awarded_points = $2,
             execution_time_ms = $3,
             memory_kb = $4,
             execution_mode = $5,
             test_results = $6::jsonb,
             error_detail = $7,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $8 AND fencing_token = $9`,
        [
          summary.verdict,
          summary.awarded_points,
          summary.execution_time_ms,
          summary.memory_kb,
          summary.execution_mode,
          JSON.stringify(summary.test_results),
          summary.error_detail || null,
          attemptId,
          fencingToken,
        ],
      );

      await client.query(
        `UPDATE submissions
         SET status = 'completed',
             authoritative_attempt_id = $1,
             final_verdict = $2,
             awarded_points = $3,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $4`,
        [
          attemptId,
          summary.verdict,
          summary.awarded_points,
          submission.id,
        ],
      );

      await this.standingsService.recomputeUserStandingInTx(
        client,
        currentAttempt.contest_id,
        currentAttempt.organization_id,
        submission.user_id,
      );

      this.logger.info('attempt_completed_authoritative', {
        service: 'shodh-worker',
        worker_id: workerId,
        submission_id: submission.id,
        attempt_id: attemptId,
        fencing_token: fencingToken,
        organization_id: currentAttempt.organization_id,
        verdict: summary.verdict,
        awarded_points: summary.awarded_points,
        execution_mode: summary.execution_mode,
        duration_ms: summary.execution_time_ms,
      });

      return { applied: true, status: 'completed' };
    });
  }

  /**
   * Helper to drain all currently available queued/expired attempts (useful in deterministic tests).
   */
  public async drainQueue(maxIterations = 100): Promise<number> {
    let processed = 0;
    for (let i = 0; i < maxIterations; i++) {
      await this.expireExhaustedAbandonedAttempts();
      const claimed = await this.claimNextAttempt(
        this.workerId,
        this.leaseDurationMs,
      );
      if (!claimed) {
        break;
      }
      await this.processClaimedAttempt(claimed);
      processed += 1;
    }
    return processed;
  }
}
