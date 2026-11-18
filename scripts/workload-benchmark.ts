import 'reflect-metadata';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
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
import { WorkerService } from '../src/judge/worker.service';
import { StandingsService } from '../src/standings/standings.service';
import { ExecutionMode } from '../src/judge/runner.interface';

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Number(sorted[idx].toFixed(2));
}

async function main() {
  process.env.LOG_SILENT = 'true';
  const executionMode: ExecutionMode =
    (process.env.BENCHMARK_EXECUTION_MODE as ExecutionMode) ||
    'deterministic-double';
  process.env.JUDGE_EXECUTION_MODE = executionMode;
  process.env.WORKER_POLL_INTERVAL_MS = '40';

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  // Launch a second independent worker context against the same persistent store
  const secondWorkerApp = await NestFactory.createApplicationContext(
    AppModule,
    { logger: false },
  );
  const secondWorker = secondWorkerApp.get(WorkerService);
  secondWorker.startPolling();

  const db = app.get(DatabaseService);
  const standingsService = app.get(StandingsService);
  const pool = db.getPool();

  try {
    await runMigrations({ pool });
    await seedDeterministicData(pool, { resetExisting: true });

    const orgId = SEED_IDS.orgs.alpha;
    const contestId = SEED_IDS.contests.alphaOpen;

    // Seed 40 additional active participants in Alpha Open Contest
    const participantTokens: string[] = [
      SEED_IDS.tokens.alphaAlice,
      SEED_IDS.tokens.alphaBob,
      SEED_IDS.tokens.alphaCharlie,
    ];

    for (let i = 0; i < 37; i++) {
      const uid = randomUUID();
      const tok = `tok-load-participant-${i}`;
      participantTokens.push(tok);
      await pool.query(
        `INSERT INTO users (id, email, display_name, auth_token)
         VALUES ($1, $2, $3, $4)`,
        [uid, `load-${i}@alpha.edu`, `Load Participant ${i}`, tok],
      );
      await pool.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'participant')`,
        [orgId, uid],
      );
      await pool.query(
        `INSERT INTO contest_participations (contest_id, organization_id, user_id)
         VALUES ($1, $2, $3)`,
        [contestId, orgId, uid],
      );
      await pool.query(
        `INSERT INTO contest_standings (contest_id, organization_id, user_id)
         VALUES ($1, $2, $3)`,
        [contestId, orgId, uid],
      );
    }

    const totalRequests = 240;
    const concurrency = 16;

    const submissionLatencies: number[] = [];
    const leaderboardLatencies: number[] = [];
    const feedLatencies: number[] = [];
    const allApiLatencies: number[] = [];
    const createdSubmissionIds: string[] = [];
    let errorCount = 0;

    type TaskType = 'submit' | 'leaderboard' | 'feed';
    const tasks: { index: number; type: TaskType }[] = [];
    for (let i = 0; i < totalRequests; i++) {
      const mod = i % 20;
      if (mod < 7) {
        tasks.push({ index: i, type: 'submit' }); // 35% (84 submissions)
      } else if (mod < 16) {
        tasks.push({ index: i, type: 'leaderboard' }); // 45% (108 leaderboard reads)
      } else {
        tasks.push({ index: i, type: 'feed' }); // 20% (48 submission list reads)
      }
    }

    const workloadStartMs = performance.now();
    let cursor = 0;

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= tasks.length) break;
        const task = tasks[idx];
        const token = participantTokens[idx % participantTokens.length];

        const t0 = performance.now();
        try {
          if (task.type === 'submit') {
            const isProblemA = idx % 2 === 0;
            const problemId = isProblemA
              ? SEED_IDS.problems.twoSum
              : SEED_IDS.problems.arrayMax;
            const isCorrect = idx % 3 !== 0;
            const sourceCode = isCorrect
              ? isProblemA
                ? SEED_PROGRAMS.correct_two_sum
                : SEED_PROGRAMS.correct_array_max
              : SEED_PROGRAMS.wrong_output;

            const res = await fetch(
              `${baseUrl}/api/v1/orgs/${orgId}/contests/${contestId}/submissions`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                  'Idempotency-Key': `bench-idem-${idx}`,
                },
                body: JSON.stringify({
                  problemId,
                  language: 'python',
                  sourceCode,
                  executionMode,
                }),
              },
            );
            const elapsed = performance.now() - t0;
            if (res.status !== 202) {
              errorCount += 1;
            } else {
              const body = (await res.json()) as any;
              createdSubmissionIds.push(body.submission_id);
              submissionLatencies.push(elapsed);
              allApiLatencies.push(elapsed);
            }
          } else if (task.type === 'leaderboard') {
            const res = await fetch(
              `${baseUrl}/api/v1/orgs/${orgId}/contests/${contestId}/leaderboard?limit=30&offset=0`,
              {
                headers: { Authorization: `Bearer ${token}` },
              },
            );
            const elapsed = performance.now() - t0;
            if (res.status !== 200) {
              errorCount += 1;
            } else {
              await res.json();
              leaderboardLatencies.push(elapsed);
              allApiLatencies.push(elapsed);
            }
          } else {
            const res = await fetch(
              `${baseUrl}/api/v1/orgs/${orgId}/contests/${contestId}/submissions?limit=20&offset=0`,
              {
                headers: { Authorization: `Bearer ${token}` },
              },
            );
            const elapsed = performance.now() - t0;
            if (res.status !== 200) {
              errorCount += 1;
            } else {
              await res.json();
              feedLatencies.push(elapsed);
              allApiLatencies.push(elapsed);
            }
          }
        } catch {
          errorCount += 1;
        }
      }
    });

    await Promise.all(workers);
    const apiPhaseDurationMs = performance.now() - workloadStartMs;

    // Wait for all queued submissions to complete judging across the 2 worker instances
    const primaryWorker = app.get(WorkerService);
    const waitStart = Date.now();
    while (Date.now() - waitStart < 30000) {
      const pendingRes = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM submissions
         WHERE contest_id = $1 AND status IN ('queued', 'running')`,
        [contestId],
      );
      if (Number(pendingRes.rows[0].cnt) === 0) {
        break;
      }
      await Promise.all([primaryWorker.tick(), secondWorker.tick()]);
      await new Promise((r) => setTimeout(r, 25));
    }

    const totalElapsedMs = performance.now() - workloadStartMs;

    // Query queue delay and sandbox execution metrics from stored judging_attempts
    const attemptMetricsRes = await pool.query<{
      queue_delay_ms: number;
      execution_time_ms: number;
      turnaround_ms: number;
    }>(
      `SELECT GREATEST(0, EXTRACT(EPOCH FROM (started_at - created_at)) * 1000)::float AS queue_delay_ms,
              COALESCE(execution_time_ms, 0)::float AS execution_time_ms,
              GREATEST(0, EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000)::float AS turnaround_ms
       FROM judging_attempts
       WHERE contest_id = $1 AND status = 'completed'`,
      [contestId],
    );

    const queueDelays = attemptMetricsRes.rows.map((r) =>
      Number(r.queue_delay_ms),
    );
    const sandboxDurations = attemptMetricsRes.rows.map((r) =>
      Number(r.execution_time_ms),
    );
    const turnaroundTimes = attemptMetricsRes.rows.map((r) =>
      Number(r.turnaround_ms),
    );

    // Also run a real Docker sandbox timing sample (6 submissions across Problem A & B)
    // so both execution modes are measured and labeled in the saved report
    const dockerExecDurations: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(
        `${baseUrl}/api/v1/orgs/${orgId}/contests/${contestId}/submissions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SEED_IDS.tokens.alphaAlice}`,
            'Idempotency-Key': `bench-docker-sample-${i}`,
          },
          body: JSON.stringify({
            problemId: SEED_IDS.problems.twoSum,
            language: 'python',
            sourceCode:
              i % 2 === 0
                ? SEED_PROGRAMS.correct_two_sum
                : SEED_PROGRAMS.wrong_output,
            executionMode: 'docker',
          }),
        },
      );
      const body = (await res.json()) as any;
      while (true) {
        await primaryWorker.tick();
        const check = await pool.query(
          `SELECT status, execution_time_ms FROM judging_attempts WHERE submission_id = $1`,
          [body.submission_id],
        );
        if (
          check.rows[0]?.status === 'completed' ||
          check.rows[0]?.status === 'failed'
        ) {
          dockerExecDurations.push(Number(check.rows[0].execution_time_ms || 0));
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Verify standings rebuild parity after concurrent workload
    const rebuildCheck = await standingsService.rebuildStandings(
      orgId,
      contestId,
    );

    // Reset seed data cleanly after benchmark
    await seedDeterministicData(pool, { resetExisting: true });

    let gitCommit = 'unknown';
    try {
      gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
    } catch {}

    const cpus = os.cpus();
    const report = {
      benchmark: 'Stage 4 Concurrent Overlapping Submissions & Leaderboard Workload',
      commit: gitCommit,
      timestamp: new Date().toISOString(),
      data_version: SEED_DATA_VERSION,
      execution_mode: executionMode,
      configuration: {
        total_http_requests: totalRequests,
        concurrency,
        worker_instances: 2,
        db_pool_max: 25,
        worker_lease_duration_ms: 15000,
      },
      machine_resources: {
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        cpu_model: cpus[0]?.model || 'Apple Silicon',
        cpu_cores: cpus.length,
        total_memory_gb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        node_version: process.version,
      },
      dataset_size: {
        organizations: 2,
        contests: 2,
        active_participants: 40,
        problems: 3,
        submissions_created_in_workload: createdSubmissionIds.length,
      },
      request_mix: {
        submissions_post: {
          count: submissionLatencies.length,
          share_pct: 35,
        },
        leaderboard_get: {
          count: leaderboardLatencies.length,
          share_pct: 45,
        },
        submissions_feed_get: {
          count: feedLatencies.length,
          share_pct: 20,
        },
      },
      api_overhead_latency_ms: {
        overall: {
          p50: percentile(allApiLatencies, 50),
          p95: percentile(allApiLatencies, 95),
          p99: percentile(allApiLatencies, 99),
        },
        post_submission_api_only: {
          p50: percentile(submissionLatencies, 50),
          p95: percentile(submissionLatencies, 95),
          p99: percentile(submissionLatencies, 99),
        },
        get_leaderboard: {
          p50: percentile(leaderboardLatencies, 50),
          p95: percentile(leaderboardLatencies, 95),
          p99: percentile(leaderboardLatencies, 99),
        },
        get_submissions_feed: {
          p50: percentile(feedLatencies, 50),
          p95: percentile(feedLatencies, 95),
          p99: percentile(feedLatencies, 99),
        },
      },
      throughput_and_errors: {
        api_phase_duration_ms: Number(apiPhaseDurationMs.toFixed(2)),
        total_workload_Plus_drain_duration_ms: Number(totalElapsedMs.toFixed(2)),
        api_throughput_req_per_sec: Number(
          ((totalRequests / apiPhaseDurationMs) * 1000).toFixed(2),
        ),
        http_errors: errorCount,
      },
      asynchronous_judge_metrics_ms: {
        queue_delay_ms: {
          p50: percentile(queueDelays, 50),
          p95: percentile(queueDelays, 95),
          p99: percentile(queueDelays, 99),
        },
        program_execution_deterministic_double_ms: {
          p50: percentile(sandboxDurations, 50),
          p95: percentile(sandboxDurations, 95),
          p99: percentile(sandboxDurations, 99),
        },
        program_execution_real_docker_container_sample_ms: {
          execution_mode: 'docker',
          sample_size: dockerExecDurations.length,
          p50: percentile(dockerExecDurations, 50),
          p95: percentile(dockerExecDurations, 95),
          p99: percentile(dockerExecDurations, 99),
        },
        end_to_end_turnaround_ms: {
          p50: percentile(turnaroundTimes, 50),
          p95: percentile(turnaroundTimes, 95),
          p99: percentile(turnaroundTimes, 99),
        },
      },
      consistency_verification: {
        standings_rebuilt_matches_serving_path:
          rebuildCheck.consistent_with_serving_path,
        verified_participant_count: rebuildCheck.participant_count,
      },
    };

    const resultsDir = path.resolve(process.cwd(), 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(
      path.join(resultsDir, 'workload-benchmark.json'),
      JSON.stringify(report, null, 2),
    );

    console.log(JSON.stringify(report, null, 2));
  } finally {
    secondWorker.stopPolling();
    await secondWorkerApp.close();
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

