import 'reflect-metadata';
import * as assert from 'assert';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/db/database.service';
import { runMigrations } from '../src/db/migrate';
import {
  seedDeterministicData,
  SEED_DATA_VERSION,
  SEED_IDS,
  SEED_PROGRAMS,
} from '../src/db/seed';
import { FaultInjectionService } from '../src/judge/fault-injection.service';
import { WorkerService } from '../src/judge/worker.service';
import { StandingsService } from '../src/standings/standings.service';
import { StructuredLoggerService } from '../src/common/logger/structured-logger.service';

interface ScenarioEvidence {
  scenario_family: string;
  check_name: string;
  execution_mode: 'docker' | 'deterministic-double';
  passed: boolean;
  details: Record<string, unknown>;
}

async function waitForSubmissionTerminal(
  pool: any,
  worker: WorkerService,
  submissionId: string,
  timeoutMs = 20000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await worker.tick();
    const res = await pool.query(
      `SELECT * FROM submissions WHERE id = $1`,
      [submissionId],
    );
    const sub = res.rows[0];
    if (sub && (sub.status === 'completed' || sub.status === 'failed')) {
      const attRes = await pool.query(
        `SELECT * FROM judging_attempts WHERE submission_id = $1 ORDER BY attempt_number DESC`,
        [submissionId],
      );
      return { submission: sub, attempts: attRes.rows };
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for submission ${submissionId}`);
}

export async function runFullVerificationSuite(): Promise<{
  all_passed: boolean;
  commit: string;
  data_version: string;
  timestamp: string;
  results: ScenarioEvidence[];
}> {
  process.env.LOG_SILENT = 'true';
  process.env.WORKER_ENABLED = 'false'; // We drive worker ticks explicitly and via multi-instance hooks for deterministic race control

  // Launch TWO independent NestJS application instances against the same PostgreSQL database
  const app1 = await NestFactory.create(AppModule, { logger: false });
  await app1.listen(0, '127.0.0.1');
  const url1 = await app1.getUrl();

  const app2 = await NestFactory.create(AppModule, { logger: false });
  await app2.listen(0, '127.0.0.1');
  const url2 = await app2.getUrl();

  const db = app1.get(DatabaseService);
  const pool = db.getPool();
  const worker1 = app1.get(WorkerService);
  const worker2 = app2.get(WorkerService);
  const faultInjection1 = app1.get(FaultInjectionService);
  const standingsService = app1.get(StandingsService);

  const evidence: ScenarioEvidence[] = [];

  try {
    await runMigrations({ pool });
    await seedDeterministicData(pool, { resetExisting: true });
    StructuredLoggerService.clearLogs();

    const orgAlpha = SEED_IDS.orgs.alpha;
    const orgBeta = SEED_IDS.orgs.beta;
    const contestAlpha = SEED_IDS.contests.alphaOpen;
    const contestBeta = SEED_IDS.contests.betaCup;
    const probA = SEED_IDS.problems.twoSum;
    const probB = SEED_IDS.problems.arrayMax;

    // =========================================================================
    // SCENARIO FAMILY 1: NORMAL FLOW & STAGE 1 CONTRACTS
    // =========================================================================

    // 1.1 Unseen organization, participant, join, submit in REAL DOCKER mode, and verify score/ranking
    const unseenUserId = randomUUID();
    const unseenToken = `dev:${unseenUserId}:${orgAlpha}:participant`;

    const joinRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/join`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${unseenToken}` },
      },
    );
    assert.strictEqual(joinRes.status, 200);

    // Alice submits a wrong answer first on Problem A (in real Docker mode), then a correct answer
    const aliceWrongRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}`,
        },
        body: JSON.stringify({
          problemId: probA,
          language: 'python',
          sourceCode: SEED_PROGRAMS.wrong_output,
          executionMode: 'docker',
        }),
      },
    );
    assert.strictEqual(aliceWrongRes.status, 202);
    const aliceWrongBody = (await aliceWrongRes.json()) as any;
    const aliceWrongFinal = await waitForSubmissionTerminal(
      pool,
      worker1,
      aliceWrongBody.submission_id,
    );
    assert.strictEqual(aliceWrongFinal.submission.final_verdict, 'WRONG_ANSWER');
    assert.strictEqual(aliceWrongFinal.submission.awarded_points, 0);

    // Alice submits correct solution on Problem A (in real Docker mode)
    const aliceCorrectRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}`,
        },
        body: JSON.stringify({
          problemId: probA,
          language: 'python',
          sourceCode: SEED_PROGRAMS.correct_two_sum,
          executionMode: 'docker',
        }),
      },
    );
    assert.strictEqual(aliceCorrectRes.status, 202);
    const aliceCorrectBody = (await aliceCorrectRes.json()) as any;
    const aliceCorrectFinal = await waitForSubmissionTerminal(
      pool,
      worker1,
      aliceCorrectBody.submission_id,
    );
    assert.strictEqual(aliceCorrectFinal.submission.final_verdict, 'ACCEPTED');
    assert.strictEqual(aliceCorrectFinal.submission.awarded_points, 100);

    // Bob solves Problem B (200 points) on first try in real Docker mode
    const bobCorrectRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaBob}`,
        },
        body: JSON.stringify({
          problemId: probB,
          language: 'python',
          sourceCode: SEED_PROGRAMS.correct_array_max,
          executionMode: 'docker',
        }),
      },
    );
    assert.strictEqual(bobCorrectRes.status, 202);
    const bobCorrectBody = (await bobCorrectRes.json()) as any;
    const bobCorrectFinal = await waitForSubmissionTerminal(
      pool,
      worker1,
      bobCorrectBody.submission_id,
    );
    assert.strictEqual(bobCorrectFinal.submission.final_verdict, 'ACCEPTED');
    assert.strictEqual(bobCorrectFinal.submission.awarded_points, 200);

    // Check leaderboard ranking: Bob (200 pts, rank 1) > Alice (100 pts with 1 wrong attempt penalty, rank 2)
    const lbRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/leaderboard`,
      {
        headers: { Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}` },
      },
    );
    assert.strictEqual(lbRes.status, 200);
    const lbBody = (await lbRes.json()) as any;
    assert.strictEqual(lbBody.entries[0].user_id, SEED_IDS.users.alphaBob);
    assert.strictEqual(lbBody.entries[0].total_points, 200);
    assert.strictEqual(lbBody.entries[0].rank, 1);
    assert.strictEqual(lbBody.entries[1].user_id, SEED_IDS.users.alphaAlice);
    assert.strictEqual(lbBody.entries[1].total_points, 100);
    assert.strictEqual(lbBody.entries[1].rank, 2);
    assert.strictEqual(
      lbBody.entries[1].problem_breakdown.A.wrong_attempts,
      1,
    );

    evidence.push({
      scenario_family: 'Normal flow',
      check_name:
        'Join, submit, real Docker judge execution, penalty calculation, and leaderboard ranking',
      execution_mode: 'docker',
      passed: true,
      details: {
        rank_1: {
          user_id: lbBody.entries[0].user_id,
          total_points: lbBody.entries[0].total_points,
        },
        rank_2: {
          user_id: lbBody.entries[1].user_id,
          total_points: lbBody.entries[1].total_points,
          wrong_attempts_on_A:
            lbBody.entries[1].problem_breakdown.A.wrong_attempts,
          total_penalty_seconds: lbBody.entries[1].total_penalty_seconds,
        },
      },
    });

    // 1.2 Problem Versioning Preservation: updating a problem must not silently change historical verdicts
    const createV2Res = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/problems/${probA}/versions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaOrganizer}`,
        },
        body: JSON.stringify({
          statement:
            'Updated v2: Given two integers, print their sum multiplied by 10.',
          maxPoints: 150,
          testCases: [
            { ordinal: 1, inputData: '3 5\n', expectedOutput: '80', isHidden: false },
            { ordinal: 2, inputData: '10 2\n', expectedOutput: '120', isHidden: true },
          ],
        }),
      },
    );
    assert.strictEqual(createV2Res.status, 201);
    const v2Body = (await createV2Res.json()) as any;

    // Verify Alice's historical submission still references v1 problem_version_id and v1 test_suite_version_id and retains ACCEPTED (100 pts)
    const aliceHistRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions/${aliceCorrectBody.submission_id}`,
      {
        headers: { Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}` },
      },
    );
    const aliceHistBody = (await aliceHistRes.json()) as any;
    assert.strictEqual(
      aliceHistBody.problem_version_id,
      SEED_IDS.problemVersions.twoSumV1,
    );
    assert.strictEqual(
      aliceHistBody.test_suite_version_id,
      SEED_IDS.testSuiteVersions.twoSumS1,
    );
    assert.strictEqual(aliceHistBody.final_verdict, 'ACCEPTED');
    assert.strictEqual(aliceHistBody.awarded_points, 100);

    evidence.push({
      scenario_family: 'Normal flow',
      check_name:
        'Problem & test-suite versioning preserves historical submission references and verdicts',
      execution_mode: 'docker',
      passed: true,
      details: {
        historical_submission_problem_version_id:
          aliceHistBody.problem_version_id,
        new_problem_version_id: v2Body.current_version_id,
        historical_verdict_preserved: aliceHistBody.final_verdict,
      },
    });

    // =========================================================================
    // SCENARIO FAMILY 2: RETRIES AND CONCURRENCY
    // =========================================================================

    // 2.1 Simultaneous use of one idempotency key across TWO application instances (app1 and app2)
    const sharedIdemKey = `concurrent-idem-${randomUUID()}`;
    const concurrentIdemPromises = Array.from({ length: 8 }, (_, idx) => {
      const targetUrl = idx % 2 === 0 ? url1 : url2;
      return fetch(
        `${targetUrl}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SEED_IDS.tokens.alphaCharlie}`,
            'Idempotency-Key': sharedIdemKey,
          },
          body: JSON.stringify({
            problemId: probB,
            language: 'python',
            sourceCode: SEED_PROGRAMS.correct_array_max,
            executionMode: 'deterministic-double',
          }),
        },
      );
    });

    const idemResponses = await Promise.all(concurrentIdemPromises);
    const idemBodies = await Promise.all(
      idemResponses.map((r) => r.json() as Promise<any>),
    );
    for (const r of idemResponses) {
      assert.strictEqual(r.status, 202);
    }
    const uniqueSubIds = new Set(idemBodies.map((b) => b.submission_id));
    assert.strictEqual(
      uniqueSubIds.size,
      1,
      'Simultaneous requests with same Idempotency-Key must return exact same submission_id',
    );
    const idemSubId = idemBodies[0].submission_id;

    // Verify reusing the same Idempotency-Key with DIFFERENT sourceCode returns 409 IDEMPOTENCY_KEY_CONFLICT
    const conflictRes = await fetch(
      `${url2}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaCharlie}`,
          'Idempotency-Key': sharedIdemKey,
        },
        body: JSON.stringify({
          problemId: probB,
          language: 'python',
          sourceCode: SEED_PROGRAMS.wrong_output,
        }),
      },
    );
    assert.strictEqual(conflictRes.status, 409);
    const conflictBody = (await conflictRes.json()) as any;
    assert.strictEqual(conflictBody.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
    assert.strictEqual(conflictBody.error.category, 'BUSINESS_RULE_ERROR');

    await waitForSubmissionTerminal(pool, worker1, idemSubId);

    evidence.push({
      scenario_family: 'Retries and concurrency',
      check_name:
        'Simultaneous multi-instance idempotency key race and payload conflict rejection',
      execution_mode: 'deterministic-double',
      passed: true,
      details: {
        simultaneous_requests: 8,
        unique_submissions_created: uniqueSubIds.size,
        conflict_status_on_mutated_payload: conflictRes.status,
        conflict_code: conflictBody.error.code,
      },
    });

    // 2.2 Competing workers with fencing token protection
    const compSubRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${unseenToken}`,
        },
        body: JSON.stringify({
          problemId: probB,
          language: 'python',
          sourceCode: SEED_PROGRAMS.correct_array_max,
          executionMode: 'deterministic-double',
        }),
      },
    );
    const compSubBody = (await compSubRes.json()) as any;

    // Worker 1 claims the attempt first (fencing_token T1)
    const claimW1 = await worker1.claimNextAttempt('worker-1', 50);
    assert.ok(claimW1 && claimW1.submission_id === compSubBody.submission_id);
    const tokenW1 = Number(claimW1.fencing_token);

    // Worker 2 reclaims the attempt (fencing_token T2 > T1)
    const claimW2 = await worker2.forceReclaimAttempt(
      claimW1.id,
      'worker-2',
      15000,
    );
    const tokenW2 = Number(claimW2.fencing_token);
    assert.ok(tokenW2 > tokenW1, 'Newer claim must receive higher fencing token');

    // Worker 2 finishes and commits ACCEPTED (200 pts)
    const w2Summary = await worker2.executeAttemptInSandbox(claimW2);
    const w2Commit = await worker2.completeAttempt(
      claimW2.id,
      tokenW2,
      w2Summary,
      'worker-2',
    );
    assert.strictEqual(w2Commit.applied, true);

    // Now Worker 1 wakes up late and tries to overwrite with WRONG_ANSWER using stale tokenW1
    const staleCommit = await worker1.completeAttempt(
      claimW1.id,
      tokenW1,
      {
        ...w2Summary,
        verdict: 'WRONG_ANSWER',
        awarded_points: 0,
      },
      'worker-1',
    );
    assert.strictEqual(staleCommit.applied, false);
    assert.strictEqual(staleCommit.reason, 'STALE_FENCING_TOKEN');

    // Verify DB state and score are untouched by stale worker
    const compCheck = await pool.query(
      `SELECT final_verdict, awarded_points FROM submissions WHERE id = $1`,
      [compSubBody.submission_id],
    );
    assert.strictEqual(compCheck.rows[0].final_verdict, 'ACCEPTED');
    assert.strictEqual(compCheck.rows[0].awarded_points, 200);

    evidence.push({
      scenario_family: 'Retries and concurrency',
      check_name:
        'Competing workers fenced by monotonic fencing_token without duplicate points or stale overwrite',
      execution_mode: 'deterministic-double',
      passed: true,
      details: {
        worker_1_stale_token: tokenW1,
        worker_2_authoritative_token: tokenW2,
        stale_commit_rejected_reason: staleCommit.reason,
        final_verdict: compCheck.rows[0].final_verdict,
        awarded_points: compCheck.rows[0].awarded_points,
      },
    });

    // 2.3 Barrier-synchronized Out-of-Order Completion
    const oooUserId = randomUUID();
    const oooToken = `dev:${oooUserId}:${orgAlpha}:participant`;
    await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/join`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${oooToken}` },
      },
    );

    const sub1Id = randomUUID();
    const sub2Id = randomUUID();
    const sub1Barrier = faultInjection1.registerSubmissionBarrier(sub1Id);

    // Submit Sub 1 (WRONG_ANSWER) at t1
    const oooRes1 = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${oooToken}`,
        },
        body: JSON.stringify({
          id: sub1Id,
          problemId: probB,
          language: 'python',
          sourceCode: SEED_PROGRAMS.wrong_output,
          executionMode: 'deterministic-double',
        }),
      },
    );
    assert.strictEqual(oooRes1.status, 202);

    // Wait 20ms so Sub 2 has a strictly later submitted_at timestamp (t2 > t1)
    await new Promise((r) => setTimeout(r, 20));

    // Submit Sub 2 (ACCEPTED) at t2
    const oooRes2 = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${oooToken}`,
        },
        body: JSON.stringify({
          id: sub2Id,
          problemId: probB,
          language: 'python',
          sourceCode: SEED_PROGRAMS.correct_array_max,
          executionMode: 'deterministic-double',
        }),
      },
    );
    assert.strictEqual(oooRes2.status, 202);

    // Worker 1 claims Sub 1 (t1) and blocks at sub1Barrier
    const oooClaim1 = await worker1.claimNextAttempt('worker-1');
    assert.strictEqual(oooClaim1?.submission_id, sub1Id);
    const oooProcess1Promise = worker1.processClaimedAttempt(oooClaim1!);

    // Worker 2 claims Sub 2 (t2) and finishes it FIRST!
    const oooClaim2 = await worker2.claimNextAttempt('worker-2');
    assert.strictEqual(oooClaim2?.submission_id, sub2Id);
    const oooCommit2 = await worker2.processClaimedAttempt(oooClaim2!);
    assert.strictEqual(oooCommit2.applied, true);

    // Now release Sub 1 barrier so Sub 1 (t1, WRONG_ANSWER) completes SECOND (out of order!)
    sub1Barrier.release();
    const oooCommit1 = await oooProcess1Promise;
    assert.strictEqual(oooCommit1.applied, true);

    // Verify standing for oooUserId reflects BOTH 200 points from Sub 2 AND 1 wrong_attempt penalty from earlier Sub 1!
    const oooStandingRes = await pool.query(
      `SELECT total_points, total_penalty_seconds, problem_breakdown
       FROM contest_standings
       WHERE contest_id = $1 AND user_id = $2`,
      [contestAlpha, oooUserId],
    );
    const oooStanding = oooStandingRes.rows[0];
    assert.strictEqual(oooStanding.total_points, 200);
    assert.strictEqual(oooStanding.problem_breakdown.B.solved, true);
    assert.strictEqual(oooStanding.problem_breakdown.B.wrong_attempts, 1);

    evidence.push({
      scenario_family: 'Retries and concurrency',
      check_name:
        'Barrier-synchronized out-of-order completion preserves chronological wrong-attempt penalty and score',
      execution_mode: 'deterministic-double',
      passed: true,
      details: {
        sub1_submitted_first_completed_second: sub1Id,
        sub2_submitted_second_completed_first: sub2Id,
        resulting_points: oooStanding.total_points,
        resulting_wrong_attempts_before_ac:
          oooStanding.problem_breakdown.B.wrong_attempts,
      },
    });

    // =========================================================================
    // SCENARIO FAMILY 3: RECOVERY AND REJUDGING
    // =========================================================================

    // 3.1 Interrupted dispatch after commit & Interrupted ack after judging
    const recSubId = randomUUID();
    faultInjection1.armFailAfterCommitBeforeDispatch(recSubId);
    faultInjection1.armFailBeforeAckOnceForSubmission(recSubId);

    const recRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaCharlie}`,
        },
        body: JSON.stringify({
          id: recSubId,
          problemId: probB,
          language: 'python',
          sourceCode: SEED_PROGRAMS.correct_array_max,
          executionMode: 'deterministic-double',
        }),
      },
    );
    assert.strictEqual(recRes.status, 202);

    // First worker claims with a short 60ms lease and fails right before ACK
    const recClaim1 = await worker1.claimNextAttempt('worker-crash-1', 60);
    assert.strictEqual(recClaim1?.submission_id, recSubId);
    const recAttempt1 = await worker1.processClaimedAttempt(recClaim1!);
    assert.strictEqual(recAttempt1.applied, false);
    assert.strictEqual(recAttempt1.reason, 'FAIL_BEFORE_ACK_INJECTED');

    // Wait 90ms for the lease to expire, then Worker 2 recovers the abandoned job and completes it!
    await new Promise((r) => setTimeout(r, 90));
    const recClaim2 = await worker2.claimNextAttempt('worker-recover-2', 15000);
    assert.strictEqual(recClaim2?.submission_id, recSubId);
    assert.strictEqual(recClaim2?.retry_count, 1);
    const recAttempt2 = await worker2.processClaimedAttempt(recClaim2!);
    assert.strictEqual(recAttempt2.applied, true);

    const recSubCheck = await pool.query(
      `SELECT status, final_verdict, awarded_points FROM submissions WHERE id = $1`,
      [recSubId],
    );
    assert.strictEqual(recSubCheck.rows[0].status, 'completed');
    assert.strictEqual(recSubCheck.rows[0].final_verdict, 'ACCEPTED');

    evidence.push({
      scenario_family: 'Recovery and rejudging',
      check_name:
        'Recovery from interrupted dispatch and worker crash after judging before completion ack',
      execution_mode: 'deterministic-double',
      passed: true,
      details: {
        submission_id: recSubId,
        first_worker_outcome: recAttempt1.reason,
        second_worker_retry_count: recClaim2?.retry_count,
        final_verdict: recSubCheck.rows[0].final_verdict,
      },
    });

    // 3.2 Controllable Runner Infrastructure Crash in Real Docker Mode (Transient Recovery + Permanent Failure 0-Penalty)
    const crashOnceRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}`,
        },
        body: JSON.stringify({
          problemId: probA,
          language: 'python',
          sourceCode: SEED_PROGRAMS.controllable_runner_crash_once,
          executionMode: 'docker',
        }),
      },
    );
    const crashOnceBody = (await crashOnceRes.json()) as any;
    // Note: Problem A is now on v2 (where output is sum * 10), so let's also test explicit rejudge on v1 next!
    const crashOnceFinal = await waitForSubmissionTerminal(
      pool,
      worker1,
      crashOnceBody.submission_id,
    );
    assert.strictEqual(crashOnceFinal.attempts[0].retry_count, 1);
    assert.strictEqual(crashOnceFinal.submission.status, 'completed');

    // Test permanent runner failure (`JUDGE_FAILURE`) does not reduce student score or add penalty
    const beforeFailStanding = await pool.query(
      `SELECT total_points, total_penalty_seconds FROM contest_standings WHERE contest_id = $1 AND user_id = $2`,
      [contestAlpha, SEED_IDS.users.alphaBob],
    );
    const failAlwaysRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaBob}`,
        },
        body: JSON.stringify({
          problemId: probA,
          language: 'python',
          sourceCode: SEED_PROGRAMS.controllable_runner_failure_always,
          maxRetries: 1,
          executionMode: 'docker',
        }),
      },
    );
    const failAlwaysBody = (await failAlwaysRes.json()) as any;
    const failAlwaysFinal = await waitForSubmissionTerminal(
      pool,
      worker1,
      failAlwaysBody.submission_id,
    );
    assert.strictEqual(failAlwaysFinal.submission.status, 'failed');
    assert.strictEqual(
      failAlwaysFinal.submission.final_verdict,
      'JUDGE_FAILURE',
    );
    const afterFailStanding = await pool.query(
      `SELECT total_points, total_penalty_seconds FROM contest_standings WHERE contest_id = $1 AND user_id = $2`,
      [contestAlpha, SEED_IDS.users.alphaBob],
    );
    assert.deepStrictEqual(afterFailStanding.rows[0], beforeFailStanding.rows[0]);

    evidence.push({
      scenario_family: 'Recovery and rejudging',
      check_name:
        'Controllable runner failure recovery and zero-penalty protection on JUDGE_FAILURE',
      execution_mode: 'docker',
      passed: true,
      details: {
        transient_crash_recovered_after_retry:
          crashOnceFinal.attempts[0].retry_count,
        permanent_failure_verdict: failAlwaysFinal.submission.final_verdict,
        student_score_unchanged: true,
      },
    });

    // 3.3 Organizer Rejudging against explicit problem/test-suite version & Late Result from Replaced Attempt
    // First, Organizer triggers rejudge #1 (Attempt 2) on aliceCorrectBody.submission_id against Problem A v2 (which expects (a+b)*10 -> WRONG_ANSWER)
    const rejudge1Res = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions/${aliceCorrectBody.submission_id}/rejudge`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaOrganizer}`,
        },
        body: JSON.stringify({
          problemVersionId: v2Body.current_version_id,
          testSuiteVersionId: v2Body.current_test_suite_version_id,
          executionMode: 'deterministic-double',
        }),
      },
    );
    assert.strictEqual(rejudge1Res.status, 202);

    // Worker 1 claims Attempt 2 (against v2, which will produce WRONG_ANSWER)
    const claimAttempt2 = await worker1.claimNextAttempt('worker-1');
    assert.strictEqual(claimAttempt2?.attempt_number, 2);

    // While Attempt 2 is still running in Worker 1, Organizer triggers a second rejudge (Attempt 3)
    // explicitly selecting Problem Version 1 (twoSumV1) and Test Suite 1 (twoSumS1)!
    const rejudge2Res = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions/${aliceCorrectBody.submission_id}/rejudge`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaOrganizer}`,
        },
        body: JSON.stringify({
          problemVersionId: SEED_IDS.problemVersions.twoSumV1,
          testSuiteVersionId: SEED_IDS.testSuiteVersions.twoSumS1,
          executionMode: 'docker',
        }),
      },
    );
    assert.strictEqual(rejudge2Res.status, 202);
    const rejudge2Body = (await rejudge2Res.json()) as any;
    assert.strictEqual(rejudge2Body.latest_attempt_number, 3);

    // Worker 2 claims and completes Attempt 3 (against v1 in real Docker mode -> ACCEPTED!)
    const claimAttempt3 = await worker2.claimNextAttempt('worker-2');
    assert.strictEqual(claimAttempt3?.attempt_number, 3);
    const commitAttempt3 = await worker2.processClaimedAttempt(claimAttempt3!);
    assert.strictEqual(commitAttempt3.status, 'completed');

    // Now Worker 1 finishes replaced Attempt 2 late!
    const commitLateAttempt2 = await worker1.processClaimedAttempt(
      claimAttempt2!,
    );
    assert.strictEqual(commitLateAttempt2.status, 'superseded');

    // Inspect submission as Organizer: all 3 attempts preserved, Attempt 3 is authoritative with ACCEPTED!
    const orgInspectRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions/${aliceCorrectBody.submission_id}`,
      {
        headers: { Authorization: `Bearer ${SEED_IDS.tokens.alphaOrganizer}` },
      },
    );
    const orgInspectBody = (await orgInspectRes.json()) as any;
    assert.strictEqual(orgInspectBody.attempts.length, 3);
    assert.strictEqual(
      orgInspectBody.authoritative_attempt_id,
      claimAttempt3?.id,
    );
    assert.strictEqual(orgInspectBody.final_verdict, 'ACCEPTED');
    assert.strictEqual(orgInspectBody.awarded_points, 100);

    evidence.push({
      scenario_family: 'Recovery and rejudging',
      check_name:
        'Organizer rejudging against explicit problem/test-suite version and late replaced attempt rejection',
      execution_mode: 'docker',
      passed: true,
      details: {
        preserved_attempts_count: orgInspectBody.attempts.length,
        late_attempt_2_status: commitLateAttempt2.status,
        authoritative_attempt_number: 3,
        authoritative_final_verdict: orgInspectBody.final_verdict,
      },
    });

    // =========================================================================
    // SCENARIO FAMILY 4: SECURITY AND EXECUTION
    // =========================================================================

    // 4.1 Cross-organization denial (knowing an object ID must not grant access)
    const crossOrgContestRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestBeta}`,
      {
        headers: { Authorization: `Bearer ${SEED_IDS.tokens.alphaOrganizer}` },
      },
    );
    assert.strictEqual(crossOrgContestRes.status, 403);
    const crossOrgContestBody = (await crossOrgContestRes.json()) as any;
    assert.strictEqual(
      crossOrgContestBody.error.code,
      'CROSS_ORG_ACCESS_DENIED',
    );

    const crossOrgDirectRes = await fetch(
      `${url1}/api/v1/orgs/${orgBeta}/contests/${contestBeta}`,
      {
        headers: { Authorization: `Bearer ${SEED_IDS.tokens.alphaOrganizer}` },
      },
    );
    assert.strictEqual(crossOrgDirectRes.status, 403);

    // 4.2 Participant attempting organizer actions & reading another participant's private code
    const partCreateProbRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/problems`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}`,
        },
        body: JSON.stringify({ code: 'Z', title: 'Unauthorized' }),
      },
    );
    assert.strictEqual(partCreateProbRes.status, 403);
    const partCreateProbBody = (await partCreateProbRes.json()) as any;
    assert.strictEqual(partCreateProbBody.error.code, 'INSUFFICIENT_ROLE');

    const bobReadsAliceSubRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions/${aliceCorrectBody.submission_id}`,
      {
        headers: { Authorization: `Bearer ${SEED_IDS.tokens.alphaBob}` },
      },
    );
    assert.strictEqual(bobReadsAliceSubRes.status, 403);
    const bobReadsAliceSubBody = (await bobReadsAliceSubRes.json()) as any;
    assert.strictEqual(
      bobReadsAliceSubBody.error.code,
      'PRIVATE_SUBMISSION_ACCESS_DENIED',
    );

    // 4.3 Hidden test data protection in Problem and Submission participant responses
    const partProbRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/problems/${probB}`,
      {
        headers: { Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}` },
      },
    );
    const partProbText = await partProbRes.text();
    assert.ok(
      !partProbText.includes('-10 -3 -50 -1 -99'),
      'Hidden test input must never appear in participant problem response',
    );

    evidence.push({
      scenario_family: 'Security and execution',
      check_name:
        'Cross-organization denial, participant organizer-action denial, private code & hidden test protection',
      execution_mode: 'docker',
      passed: true,
      details: {
        cross_org_status: crossOrgContestRes.status,
        cross_org_code: crossOrgContestBody.error.code,
        participant_organizer_action_status: partCreateProbRes.status,
        private_submission_read_status: bobReadsAliceSubRes.status,
        hidden_test_data_redacted: true,
      },
    });

    // 4.4 Real Docker Sandbox Resource Limits (TLE, OLE, CE, RE) & Isolation Probe + Container Cleanup Check
    const verdictCases: Array<{
      name: string;
      code: string;
      expectedVerdict: string;
    }> = [
      {
        name: 'COMPILATION_ERROR',
        code: SEED_PROGRAMS.compilation_failure,
        expectedVerdict: 'COMPILATION_ERROR',
      },
      {
        name: 'RUNTIME_ERROR',
        code: SEED_PROGRAMS.runtime_failure,
        expectedVerdict: 'RUNTIME_ERROR',
      },
      {
        name: 'TIME_LIMIT_EXCEEDED',
        code: SEED_PROGRAMS.timeout,
        expectedVerdict: 'TIME_LIMIT_EXCEEDED',
      },
      {
        name: 'OUTPUT_LIMIT_EXCEEDED',
        code: SEED_PROGRAMS.excessive_output,
        expectedVerdict: 'OUTPUT_LIMIT_EXCEEDED',
      },
    ];

    const observedVerdicts: Record<string, string> = {};
    for (const vc of verdictCases) {
      const res = await fetch(
        `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}`,
          },
          body: JSON.stringify({
            problemId: probB,
            language: 'python',
            sourceCode: vc.code,
            executionMode: 'docker',
          }),
        },
      );
      const body = (await res.json()) as any;
      const final = await waitForSubmissionTerminal(
        pool,
        worker1,
        body.submission_id,
      );
      assert.strictEqual(
        final.submission.final_verdict,
        vc.expectedVerdict,
        `Expected ${vc.expectedVerdict} for ${vc.name}, got ${final.submission.final_verdict}`,
      );
      observedVerdicts[vc.name] = final.submission.final_verdict;
    }

    // Run real Docker isolation probe: verify --network none, non-root user 65534, read-only rootfs, no docker.sock
    const isolationProbeCode = `
import os, socket, sys

# 1. Verify non-root user (65534)
assert os.getuid() == 65534, f"Expected uid 65534, got {os.getuid()}"

# 2. Verify docker.sock is not accessible
assert not os.path.exists("/var/run/docker.sock"), "docker.sock must not be mounted"

# 3. Verify root filesystem is read-only
try:
    with open("/hack.txt", "w") as f:
        f.write("x")
    sys.exit(91)
except OSError:
    pass

# 4. Verify network is disabled
try:
    s = socket.create_connection(("1.1.1.1", 80), timeout=0.5)
    s.close()
    sys.exit(92)
except OSError:
    pass

# Solve Problem B normally if all isolation assertions hold
data = sys.stdin.read().split()
if len(data) >= 2:
    n = int(data[0])
    arr = [int(x) for x in data[1:n+1]]
    print(max(arr))
`.trim();

    const probeRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/submissions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}`,
        },
        body: JSON.stringify({
          problemId: probB,
          language: 'python',
          sourceCode: isolationProbeCode,
          executionMode: 'docker',
        }),
      },
    );
    const probeBody = (await probeRes.json()) as any;
    const probeFinal = await waitForSubmissionTerminal(
      pool,
      worker1,
      probeBody.submission_id,
    );
    assert.strictEqual(probeFinal.submission.final_verdict, 'ACCEPTED');

    // Verify zero leftover sandbox containers exist
    const leftoverContainers = execSync(
      'docker ps -a --filter "name=shodh-sbx-" --format "{{.Names}}"',
    )
      .toString()
      .trim();
    assert.strictEqual(
      leftoverContainers,
      '',
      `Expected 0 leftover sandbox containers, found: ${leftoverContainers}`,
    );

    evidence.push({
      scenario_family: 'Security and execution',
      check_name:
        'Real Docker sandbox resource limits (TLE, OLE, CE, RE), network/uid/ro-rootfs/socket isolation probe, and container cleanup',
      execution_mode: 'docker',
      passed: true,
      details: {
        verdicts_verified: observedVerdicts,
        isolation_probe_verdict: probeFinal.submission.final_verdict,
        leftover_sandbox_containers: 0,
      },
    });

    // =========================================================================
    // SCENARIO FAMILY 5: PERFORMANCE AND CONSISTENCY
    // =========================================================================

    // 5.1 Rebuild standings from authoritative records and verify 100% parity with live serving path
    const rebuildRes = await fetch(
      `${url1}/api/v1/orgs/${orgAlpha}/contests/${contestAlpha}/leaderboard/rebuild`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${SEED_IDS.tokens.alphaOrganizer}` },
      },
    );
    assert.strictEqual(rebuildRes.status, 200);
    const rebuildBody = (await rebuildRes.json()) as any;
    assert.strictEqual(rebuildBody.consistent_with_serving_path, true);

    // 5.2 Verify structured logs have correlation IDs (request_id, submission_id, attempt_id) and zero leaked secrets
    const recentLogs = StructuredLoggerService.getRecentLogs();
    const rawLogsJson = JSON.stringify(recentLogs);
    assert.ok(
      !rawLogsJson.includes(SEED_IDS.tokens.alphaAlice),
      'Auth tokens must never be logged',
    );
    assert.ok(
      !rawLogsJson.includes('-10 -3 -50 -1 -99'),
      'Hidden test inputs must never be logged',
    );
    const correlatedWorkerLog = recentLogs.find(
      (l) =>
        l.event === 'attempt_completed_authoritative' &&
        l.submission_id &&
        l.attempt_id &&
        l.fencing_token !== undefined,
    );
    assert.ok(
      correlatedWorkerLog,
      'Expected structured worker log with submission_id, attempt_id, and fencing_token',
    );

    evidence.push({
      scenario_family: 'Performance and consistency',
      check_name:
        'Standings rebuild parity from authoritative records and structured log correlation/redaction check',
      execution_mode: 'docker',
      passed: true,
      details: {
        consistent_with_serving_path: rebuildBody.consistent_with_serving_path,
        participant_count: rebuildBody.participant_count,
        sample_correlated_log: {
          event: correlatedWorkerLog?.event,
          submission_id: correlatedWorkerLog?.submission_id,
          attempt_id: correlatedWorkerLog?.attempt_id,
          fencing_token: correlatedWorkerLog?.fencing_token,
        },
      },
    });

    // Reset seed data cleanly at the end so the database is in pristine seeded state
    await seedDeterministicData(pool, { resetExisting: true });

    let gitCommit = 'unknown';
    try {
      gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
    } catch {}

    const summary = {
      all_passed: evidence.every((e) => e.passed),
      commit: gitCommit,
      data_version: SEED_DATA_VERSION,
      timestamp: new Date().toISOString(),
      results: evidence,
    };

    const resultsDir = path.resolve(process.cwd(), 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(
      path.join(resultsDir, 'functional-verification.json'),
      JSON.stringify(summary, null, 2),
    );

    return summary;
  } finally {
    await app2.close();
    await app1.close();
  }
}

if (require.main === module) {
  runFullVerificationSuite()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.all_passed) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
