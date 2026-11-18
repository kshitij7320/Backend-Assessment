# Shodh a Code — Contest Platform Backend Technical Report

**Candidate Assessment Report (Stages 1–4)**  
**Stack:** TypeScript 5, NestJS 10, PostgreSQL 16, Isolated Docker Sandbox Runner  
**Data Version:** `2026.1-deterministic`

---

## 1. System Architecture & Component Boundaries

Shodh a Code is designed as a multi-tenant, asynchronous contest evaluation backend using **TypeScript with NestJS**, **PostgreSQL 16** as the single source of truth for relational invariants and transactional job coordination, and an **ephemeral Docker Sandbox Runner** for untrusted student code execution.

Per Stage 4 guidelines (*"Do not introduce a cache, queue product or additional database solely to satisfy a technology checklist"*), the system avoids external message brokers (such as Redis or RabbitMQ) that introduce dual-write split-brain windows between database commit and queue publish. Instead, job queuing, lease recovery, and fencing are enforced directly inside PostgreSQL via `SELECT ... FOR UPDATE SKIP LOCKED` and a monotonic sequence `judging_fencing_seq`.

```
+-----------------------------------------------------------------------+
|                           HTTP Clients                                |
|         (Organizers, Participants, Load & Verification Harness)       |
+-----------------------------------+-----------------------------------+
                                    | Bearer Token / Idempotency-Key
                                    v
+-----------------------------------------------------------------------+
|                        NestJS API Processes                           |
|  - AuthGuard & Multi-Tenant Org/Role Boundary Enforcement             |
|  - Contests, Versioned Problems/Test Suites, Idempotent Submissions   |
|  - Materialized Leaderboard Serving & Authoritative Rebuild Engine    |
+-----------------------------------+-----------------------------------+
                                    | ACID Transactions (pg.Pool)
                                    v
+-----------------------------------------------------------------------+
|                         PostgreSQL 16 Store                           |
|  - Tables: organizations, users, organization_memberships, contests,  |
|    contest_participations, problems, problem_versions,                |
|    test_suite_versions, test_cases, submissions, judging_attempts,    |
|    contest_standings                                                  |
|  - Sequence: judging_fencing_seq (monotonic fencing tokens)           |
+-----------------------------------+-----------------------------------+
                                    | FOR UPDATE SKIP LOCKED + Leases
                                    v
+-----------------------------------------------------------------------+
|                    Independent Judge Worker Processes                 |
|  - Claims queued or lease-expired attempts with fencing_token         |
|  - Executes code in isolated Docker container or deterministic double |
|  - Commits verdict & updates contest_standings under fencing guard    |
+-----------------------------------+-----------------------------------+
                                    | spawn('docker', ['run', '--rm', ...])
                                    v
+-----------------------------------------------------------------------+
|                 Ephemeral Docker Sandbox Containers                   |
|  --network none | --cpus 0.5 | --memory 128m | --pids-limit 32        |
|  --read-only | --tmpfs /tmp:noexec | --user 65534:65534 | no mounts   |
+-----------------------------------------------------------------------+
```

---

## 2. Relational Schema, Transaction Boundaries & Invariants

### 2.1 Immutable Problem & Test-Suite Versioning
To ensure updating a problem never silently changes the meaning of historical verdicts:
- `problems` holds pointers (`current_version_id`, `current_test_suite_version_id`) used only for **new** submissions.
- Every modification to problem limits/statements creates a new immutable row in `problem_versions (problem_id, version_number)`. Every modification to test cases creates a new immutable row in `test_suite_versions (problem_id, suite_version_number)` with a SHA-256 `checksum`.
- When a submission is created, `submissions` and `judging_attempts` freeze the exact `problem_version_id`, `test_suite_version_id`, and `runtime_config` JSONB snapshot inside the creation transaction.

### 2.2 Transaction Boundaries & Database Constraints

| Operation | Transaction Boundary & Isolation | Enforced Database Constraints / Locks |
|---|---|---|
| **Create Submission** | Single `READ COMMITTED` transaction inserting both `submissions` and initial `judging_attempts` (`attempt_number = 1`). | `UNIQUE (contest_id, user_id, idempotency_key)` via `INSERT ... ON CONFLICT DO NOTHING`. Eliminates the commit-to-dispatch loss window. |
| **Claim Judging Job** | Single transaction selecting 1 eligible attempt and updating `status = 'running'`, `fencing_token = nextval('judging_fencing_seq')`, `lease_expires_at`. | `FOR UPDATE SKIP LOCKED` on `judging_attempts` prevents two competing workers from claiming the same active lease. |
| **Complete Attempt & Update Standings** | Single transaction locking the attempt, parent submission, and participant standing row, then updating attempt, submission, and `contest_standings`. | `SELECT ... FOR UPDATE` on `judging_attempts`, `submissions`, and `contest_participations` (per-user standing serialization lock) + `WHERE fencing_token = $2`. |
| **Organizer Rejudge** | Single transaction locking `submissions FOR UPDATE`, incrementing `latest_attempt_number`, superseding queued older attempts, and inserting the new attempt. | `UNIQUE (submission_id, attempt_number)` and `latest_attempt_number` authoritative invariant. |

---

## 3. Retry, Concurrency, and Rejudge Protocol

### 3.1 Division of Guarantees
1. **Enforced by Persistent Storage (PostgreSQL):**
   - Idempotency uniqueness (`UNIQUE (contest_id, user_id, idempotency_key)` + SHA-256 `request_fingerprint` conflict check).
   - Atomic outbox persistence (`submissions` and `judging_attempts` committed together).
   - Monotonic `fencing_token` generation (`judging_fencing_seq`) and `UNIQUE (submission_id, attempt_number)`.
2. **Enforced by Worker Protocol (`WorkerService`):**
   - Lease-based abandonment recovery: if a worker crashes mid-execution (`status = 'running' AND lease_expires_at <= NOW()`), another worker reclaims the attempt, increments `retry_count`, and obtains a strictly higher `fencing_token`.
   - Fencing verification on completion: `completeAttempt` locks `judging_attempts FOR UPDATE` and verifies `current.fencing_token === worker.fencing_token && current.status === 'running'`. Any delayed completion from an old worker with a superseded `fencing_token` is rejected (`STALE_FENCING_TOKEN`) and cannot overwrite verdicts or award points twice.
   - Authoritative attempt rule: only the attempt where `attempt_number === submissions.latest_attempt_number` may update `submissions.authoritative_attempt_id`, `final_verdict`, `awarded_points`, and `contest_standings`. Delayed completions from older attempts replaced by an organizer rejudge are recorded with `status = 'superseded'` for audit history without mutating standings.
   - Out-of-order completion consistency: `StandingsService.recomputeUserStandingInTx` locks the user's `contest_participations` row (`FOR UPDATE`) and recomputes the user's problem breakdown across all authoritative submissions ordered by `(submitted_at ASC, id ASC)`. Completing `Sub 2 (ACCEPTED, t2)` before `Sub 1 (WRONG_ANSWER, t1)` yields the exact same penalty and score as in-order completion.
3. **Enforced by Sandbox Runner (`DockerRunnerService`):**
   - Wall-clock timeout enforcement, output buffer capping, compilation vs. runtime exit code classification (`201` for syntax/compilation error, `137`/`MemoryError` for OOM, `125/126/127` for Docker daemon failure), and container cleanup (`docker rm -f`).

---

## 4. Sandbox Isolation Choices & Environment Limits

Submitted programs execute inside ephemeral `python:3.12-alpine` (or `node:22-alpine`) containers invoked via `docker run --rm -i`:
- **CPU & Memory Bounds:** `--cpus 0.5`, `--memory <limit>m`, `--memory-swap <limit>m` (swap disabled so memory limits are strictly enforced).
- **Process Count & Fork-Bomb Protection:** `--pids-limit 32`.
- **Network Isolation:** `--network none` disables all network interfaces inside the sandbox.
- **Filesystem & User Isolation:** `--user 65534:65534` (`nobody:nogroup`), `--read-only` root filesystem, and `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m`.
- **Privilege & Socket Separation:** `--cap-drop ALL`, `--security-opt no-new-privileges:true`. No `-v` host volume mounts or environment credentials are passed into student containers; code is injected via base64 command-line argv and test input via `stdin`. Submitted code has **zero access** to `/var/run/docker.sock`.
- **Known Isolation Limits:** Standard Linux containers share the host Linux kernel (or Docker Desktop VM kernel on macOS). While namespaces, cgroups, `no-new-privileges`, and dropped capabilities block userland breakouts, kernel syscall vulnerabilities require a microVM runtime (`gVisor` / `runsc` or Firecracker) in hostile multi-tenant production environments.

---

## 5. Performance Evidence & Bottleneck Investigation

### 5.1 Repeatable Concurrent Workload (`results/workload-benchmark.json`)
- **Environment:** Apple M4 (10 cores, 16 GB RAM, macOS arm64, Node.js v26.9.0, PostgreSQL 16).
- **Dataset & Workload:** 2 organizations, 2 contests, 40 active participants, 3 problems; **240 overlapping requests** at **concurrency = 16** across **2 worker instances** (35% `POST /submissions`, 45% `GET /leaderboard`, 20% `GET /submissions`).
- **Measured Results:**
  - **Throughput & Errors:** `680.77 req/s` API throughput, `0` HTTP errors.
  - **API Overhead (separated from sandbox execution):**
    - Overall API: `p50 = 15.55 ms`, `p95 = 48.31 ms`, `p99 = 70.31 ms`
    - `POST /submissions` (API + DB commit): `p50 = 30.29 ms`, `p95 = 63.55 ms`, `p99 = 76.19 ms`
    - `GET /leaderboard`: `p50 = 12.11 ms`, `p95 = 45.53 ms`, `p99 = 60.15 ms`
    - `GET /submissions`: `p50 = 12.45 ms`, `p95 = 31.62 ms`, `p99 = 36.23 ms`
  - **Queue & Sandbox Execution Delay:**
    - Queue delay (`started_at - created_at`): `p50 = 528.72 ms`, `p95 = 970.68 ms`, `p99 = 1026.30 ms`
    - Program execution (`deterministic-double`): `p50 = 65 ms`, `p95 = 101 ms`, `p99 = 155 ms`
    - Program execution (`docker` container mode): `p50 = 512 ms`, `p95 = 624 ms`, `p99 = 624 ms`
  - **Standings Consistency Check:** `consistent_with_serving_path = true` across all 40 participants after concurrent load.

### 5.2 Bottleneck Investigation (`results/bottleneck-evidence.json`)
Under a dataset of **250 participants and 4,500 submissions**, we profiled `StandingsService.recomputeUserStandingInTx` and `SubmissionsService.listSubmissions` using `EXPLAIN (ANALYZE, BUFFERS)`:
- **Before (`001_initial_schema.sql` only):**
  - `listSubmissions` executed `Seq Scan on submissions s (rows=4500)` followed by `Sort (top-N heapsort Memory: 38kB)`, touching **205 shared buffers** with execution time **`0.969 ms`**.
  - `recomputeUserStandingInTx` required an explicit `Sort (quicksort Memory: 26kB)` on `(submitted_at, id)`, with execution time **`0.102 ms`**.
  - Combined workload latency (300 iterations): `p50 = 1.239 ms`, `p95 = 1.472 ms`, `p99 = 1.568 ms`.
- **After (`002_performance_indexes.sql`):**
  - Added partial composite index `idx_submissions_user_standing_recompute ON submissions (contest_id, user_id, submitted_at ASC, id ASC) WHERE authoritative_attempt_id IS NOT NULL`, `idx_submissions_contest_feed ON submissions (contest_id, organization_id, submitted_at DESC, id ASC)`, and `idx_contest_standings_leaderboard_order`.
  - `listSubmissions` switched to `Index Scan using idx_submissions_contest_feed` with **zero Sort node**, touching only **5 buffers** (`shared hit=3 read=2`) and completing in **`0.025 ms`** (**38.7x faster**).
  - `recomputeUserStandingInTx` eliminated its `Sort` node via `Index Scan using idx_submissions_user_standing_recompute`, dropping to **`0.069 ms`**.
  - Combined workload latency dropped to `p50 = 0.677 ms` (**-45.4%**), `p95 = 0.793 ms` (**-46.1%**), `p99 = 0.924 ms` (**-41.1%**).
- **Trade-off:** Extra B-tree index maintenance on `INSERT/UPDATE` (~3 additional index page updates per submission) and ~400 KB of index storage per 4,500 rows in exchange for eliminating `O(N log N)` sorts and full-table scans on the hot path.

---

## 6. Investigated Infrastructure Failure & Recovery Walkthrough

In `scripts/verify-all.ts` (Scenario Family 3), we inject two infrastructure failures and trace them via correlated structured logs (`request_id`, `submission_id`, `attempt_id`, `fencing_token`):
1. **Worker Crash After Judging Before Completion Ack (`FAIL_BEFORE_ACK_INJECTED`):**
   - Submission `c1bff24a-3a67-47e8-a4d9-e60e95d16d1d` is claimed by `worker-crash-1` with a 60 ms lease (`fencing_token = 9`).
   - The runner finishes evaluating the code, but `FaultInjectionService.consumeFailBeforeAck` aborts the worker before `completeAttempt` runs (`event: "worker_fail_before_ack_triggered"`).
   - Once `lease_expires_at` passes, `worker-recover-2` reclaims the abandoned row via `FOR UPDATE SKIP LOCKED`, increments `retry_count = 1`, obtains `fencing_token = 10` (`event: "attempt_claimed"`), executes the submission, and commits `final_verdict = 'ACCEPTED'` (`event: "attempt_completed_authoritative"`).
2. **Runner Crash (`JUDGE_FAILURE`):**
   - When a submission experiences a transient runner crash (`retry_count = 0 < max_retries`), `completeAttempt` transitions the attempt back to `status = 'queued'` with `retry_count = 1` (`event: "attempt_requeued_after_judge_failure"`), recovering automatically on the next tick. When retries are exhausted, the submission settles in `status = 'failed', final_verdict = 'JUDGE_FAILURE'` with **0 penalty and 0 wrong attempts** on the student's standing.

---

## 7. Material AI Assistance & Verification Statement (Page 5)

### 7.1 How AI Tools Were Used
AI assistance was used to accelerate NestJS boilerplate generation, draft SQL migrationDDL and composite index definitions, and structure the multi-instance test harness (`scripts/verify-all.ts`) and benchmark runner (`scripts/workload-benchmark.ts`).

### 7.2 How Every Result Was Verified and Debugged
Every architectural guarantee and reported metric was verified against live PostgreSQL 16 and Docker containers:
1. **Constructor Metadata Bug Caught During Verification:** When running `scripts/workload-benchmark.ts` under `tsx` (`esbuild`), NestJS dependency injection initially failed with `TypeError: Cannot read properties of undefined (reading 'error')` because `esbuild` omits `emitDecoratorMetadata` parameter types unless explicit `@Inject(...)` decorators are present, and `@nestjs/swagger` required compiled `dist/` metadata for OpenAPI exploration. We added explicit `@Inject(...)` annotations across all services/controllers and verified both `tsx` execution and `tsc` compiled output (`dist/`).
2. **Rejudge Attempt Retry Semantics Caught During Verification:** In Scenario 3.3 of `scripts/verify-all.ts`, rejudging a submission that contained the `# __SHODH_SIMULATE_RUNNER_CRASH_ONCE__` pragma caused the newly created Attempt 3 (`retry_count = 0`) to enter `requeued` state on its first tick rather than `completed`. Inspecting the assertion failure confirmed that `retry_count` is scoped per `judging_attempts` row; separating the rejudge version test onto a clean submission verified both explicit version selection and superseded attempt fencing.
3. **Real Container & Query Plan Verification:** All 5 scenario families in `npm run verify` execute against real `python:3.12-alpine` Docker containers (including live verification that `os.getuid() == 65534`, `/var/run/docker.sock` is absent, `/` is read-only, outbound sockets to `1.1.1.1:80` fail with `Network is unreachable`, and `docker ps -a --filter "name=shodh-sbx-"` is empty after execution), and all query plans in `results/bottleneck-evidence.json` were captured directly from `EXPLAIN (ANALYZE, BUFFERS)` on PostgreSQL 16.

