# Shodh a Code — Contest Platform Backend

A multi-tenant coding contest platform backend built with **TypeScript**, **NestJS**, **PostgreSQL 16**, and an **isolated Docker Sandbox Judge** across four cumulative stages:
- **Stage 1:** Multi-tenant organizations, RBAC (`organizer` vs `participant`), contest lifecycle windows, immutable problem & test-suite versioning, and deterministic ICPC-style standings.
- **Stage 2:** Asynchronous judge worker queue, ephemeral Docker container execution (`--network none`, `--cpus 0.5`, `--memory 128m`, `--pids-limit 32`, `--read-only`, non-root `65534:65534`, zero host/socket mounts), output/time/memory enforcement, `JUDGE_FAILURE` isolation (zero student penalty), and hidden test case protection.
- **Stage 3:** Persistent idempotency keys with SHA-256 request fingerprint conflict detection, transactional outbox job creation, `FOR UPDATE SKIP LOCKED` lease claiming with monotonic `fencing_token` protection, organizer rejudging against explicit problem/test-suite versions, and out-of-order completion consistency.
- **Stage 4:** Strict cross-organization object-ID denial, correlated structured JSON logging (`request_id`, `submission_id`, `attempt_id`, `fencing_token`) with credential/test-case redaction, repeatable concurrent workload benchmark, and `EXPLAIN (ANALYZE, BUFFERS)` query plan optimization.

---

## 1. Quick Start (`docker compose up --build`)

Start the complete system (PostgreSQL 16, automatic schema migrations, deterministic seed data, NestJS API server, and 2 independent Judge Worker containers):

```bash
docker compose up --build
```

Once running:
- **API Base URL:** `http://localhost:3000`
- **Interactive Swagger / OpenAPI UI:** `http://localhost:3000/api/docs`
- **Static OpenAPI Specification:** [`docs/openapi.json`](./docs/openapi.json)
- **Technical Report (<= 4 pages + AI Verification):** [`docs/REPORT.md`](./docs/REPORT.md)

---

## 2. Evaluation & Verification Commands

With PostgreSQL running on `localhost:5432` (and Docker daemon active):

```bash
# 1. Run all functional, race, recovery, security & real Docker sandbox checks (all 5 scenario families)
npm run verify

# 2. Run the repeatable concurrent workload benchmark (240 overlapping requests, 16 concurrency, 2 workers)
npm run benchmark

# 3. Run the Stage 4 PostgreSQL EXPLAIN (ANALYZE, BUFFERS) bottleneck investigation (before vs after indexes)
npm run bottleneck

# 4. Run Vitest test runner
npm test
```

Saved verification and benchmark outputs (labeled with commit SHA, configuration, data version `2026.1-deterministic`, and execution mode):
- [`results/functional-verification.json`](./results/functional-verification.json)
- [`results/workload-benchmark.json`](./results/workload-benchmark.json)
- [`results/bottleneck-evidence.json`](./results/bottleneck-evidence.json)

---

## 3. Deterministic Seed Bundle & Sample Identities

Seeded automatically on startup (or via `npm run db:seed`):

### Organizations
| Organization | UUID | Slug |
|---|---|---|
| **Alpha Coding Academy** | `11111111-1111-4111-8111-111111111111` | `org-alpha` |
| **Beta Tech Institute** | `22222222-2222-4222-8222-222222222222` | `org-beta` |

### Sample Identities & Bearer Tokens
| Display Name | Organization | Role | User UUID | Bearer Token |
|---|---|---|---|---|
| Dr. Arjun Rao | Alpha | `organizer` | `11111111-1111-4111-8111-111111111101` | `tok-alpha-organizer` |
| Alice Verma | Alpha | `participant` | `11111111-1111-4111-8111-111111111102` | `tok-alpha-alice` |
| Bob Sharma | Alpha | `participant` | `11111111-1111-4111-8111-111111111103` | `tok-alpha-bob` |
| Charlie Nair | Alpha | `participant` | `11111111-1111-4111-8111-111111111104` | `tok-alpha-charlie` |
| Prof. Meera Iyer | Beta | `organizer` | `22222222-2222-4222-8222-222222222201` | `tok-beta-organizer` |
| Diana Kapoor | Beta | `participant` | `22222222-2222-4222-8222-222222222202` | `tok-beta-diana` |

> **Trusted Development Auth Fixture for Unseen Identities:**  
> In addition to creating organizations (`POST /api/v1/orgs`) and members (`POST /api/v1/orgs/:orgId/members`), evaluators may pass `Authorization: Bearer dev:<userUuid>:<orgUuid>:<organizer|participant>` (or headers `X-Actor-Id`, `X-Actor-Org-Id`, `X-Actor-Role`) to provision unseen identities on the fly while still enforcing all organization and role authorization checks.

### Contests & Problems
- **Alpha Spring Algorithmic Open** (`33333333-3333-4333-8333-333333333301` in `org-alpha`, penalty: 20 min):
  - **Problem A (`44444444-4444-4444-8444-444444444401`):** *Two Integer Sum* (100 pts, 1200 ms, 128 MB)
  - **Problem B (`44444444-4444-4444-8444-444444444402`):** *Array Maximum* (200 pts, 1200 ms, 128 MB)
- **Beta Winter Programming Cup** (`33333333-3333-4333-8333-333333333302` in `org-beta`, penalty: 15 min):
  - **Problem C (`44444444-4444-4444-8444-444444444403`):** *Palindrome Check* (150 pts, 1200 ms, 128 MB)

---

## 4. Submission & Attempt State Model

### Submission States (`submissions.status`)
```
[queued] ---> [running] ---> [completed] (ACCEPTED, WRONG_ANSWER, TLE, MLE, OLE, CE, RE)
   |             |
   |             +---------> [failed]    (JUDGE_FAILURE after max_retries exhausted)
   |
   +--(organizer rejudge increments latest_attempt_number and re-enters [queued])
```

### Judging Attempt States (`judging_attempts.status`)
- `queued`: Persisted in PostgreSQL and waiting to be claimed by a worker.
- `running`: Claimed by a worker with a monotonic `fencing_token` and `lease_expires_at`. If the worker crashes before acknowledging completion and the lease expires while `retry_count < max_retries`, another worker reclaims the attempt with a new `fencing_token`. If a transient `JUDGE_FAILURE` occurs while `retry_count < max_retries`, the attempt transitions back to `queued` with `retry_count + 1`.
- `completed`: Sandbox evaluation finished with a valid student verdict (`ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `OUTPUT_LIMIT_EXCEEDED`, `COMPILATION_ERROR`, `RUNTIME_ERROR`) and `attempt_number === submission.latest_attempt_number`.
- `failed`: Terminal `JUDGE_FAILURE` after exhausting `max_retries`. Never penalizes the student or increments `wrong_attempts`.
- `superseded`: An older attempt (`attempt_number < submission.latest_attempt_number`) that was replaced by an organizer rejudge. Preserved for audit history, but never updates `submissions.authoritative_attempt_id` or leaderboard standings.

---

## 5. Deterministic Scoring, Penalties & Tie-Breaking Rules

1. **Eligibility:** A participant must belong to the contest's organization and have joined the contest (`POST .../join`), and the contest state must be `open` (`starts_at <= now < ends_at` or `status_override = 'force_open'`).
2. **Authoritative Attempt:** For each submission, only the completed attempt matching `submissions.latest_attempt_number` (`authoritative_attempt_id`) counts toward standings.
3. **Problem Solve & Penalty Calculation:**
   - Submissions by a participant for a problem are evaluated in chronological order `(submitted_at ASC, id ASC)`.
   - The **first `ACCEPTED`** submission solves the problem and awards `max_points`.
   - Each student-error submission (`WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `OUTPUT_LIMIT_EXCEEDED`, `COMPILATION_ERROR`, `RUNTIME_ERROR`) submitted **before** the first `ACCEPTED` adds `contest.penalty_minutes * 60` seconds to that problem's penalty once solved.
   - Submissions after the first `ACCEPTED` on the same problem add 0 points and 0 penalty.
   - `JUDGE_FAILURE` attempts add **0 wrong attempts and 0 penalty**.
4. **Deterministic Tie-Breaking Order:**
   1. `total_points DESC`
   2. `total_penalty_seconds ASC`
   3. `last_accepted_at ASC NULLS LAST`
   4. `user_id ASC`

---

## 6. Authorization Rules & Error Categories

| Endpoint / Action | Participant (Same Org) | Organizer (Same Org) | Any User (Different Org) |
|---|---|---|---|
| View org, contests, leaderboard | Allowed | Allowed | `403 CROSS_ORG_ACCESS_DENIED` |
| View problem statement & sample tests | Allowed (hidden tests redacted) | Allowed (full test suite & versions) | `403 CROSS_ORG_ACCESS_DENIED` |
| Create/update contest or problem version | `403 INSUFFICIENT_ROLE` | Allowed | `403 CROSS_ORG_ACCESS_DENIED` |
| Join contest & submit solution | Allowed (when contest `open`) | Allowed | `403 CROSS_ORG_ACCESS_DENIED` |
| Inspect own submission | Allowed (hidden test I/O redacted) | Allowed | `403 CROSS_ORG_ACCESS_DENIED` |
| Inspect another participant's submission/code | `403 PRIVATE_SUBMISSION_ACCESS_DENIED` | Allowed (full diagnostics & attempts) | `403 CROSS_ORG_ACCESS_DENIED` |
| Rejudge submission / Rebuild standings | `403 INSUFFICIENT_ROLE` | Allowed | `403 CROSS_ORG_ACCESS_DENIED` |

All error responses separate failure classes via `error.category`:
- `VALIDATION_ERROR` (`400 Bad Request`)
- `AUTH_ERROR` (`401 Unauthorized`, `403 Forbidden`)
- `BUSINESS_RULE_ERROR` (`404 Not Found`, `409 Conflict`, `422 Unprocessable Entity`)
- `INFRASTRUCTURE_ERROR` (`503 Service Unavailable`, `500 Internal Server Error`)

---

## 7. API Request Examples

```bash
# 1. Join Alpha Open Contest as Alice
curl -X POST http://localhost:3000/api/v1/orgs/11111111-1111-4111-8111-111111111111/contests/33333333-3333-4333-8333-333333333301/join \
  -H "Authorization: Bearer tok-alpha-alice"

# 2. Submit an Idempotent Python Solution to Problem A (Two Integer Sum)
curl -X POST http://localhost:3000/api/v1/orgs/11111111-1111-4111-8111-111111111111/contests/33333333-3333-4333-8333-333333333301/submissions \
  -H "Authorization: Bearer tok-alpha-alice" \
  -H "Idempotency-Key: alice-prob-a-sub-1" \
  -H "Content-Type: application/json" \
  -d '{
    "problemId": "44444444-4444-4444-8444-444444444401",
    "language": "python",
    "sourceCode": "import sys\ndata = sys.stdin.read().split()\nprint(int(data[0]) + int(data[1]))\n"
  }'

# 3. Query the Contest Leaderboard
curl http://localhost:3000/api/v1/orgs/11111111-1111-4111-8111-111111111111/contests/33333333-3333-4333-8333-333333333301/leaderboard \
  -H "Authorization: Bearer tok-alpha-alice"

# 4. Organizer: Rejudge a Submission Against Explicit Problem & Test-Suite Version
curl -X POST http://localhost:3000/api/v1/orgs/11111111-1111-4111-8111-111111111111/contests/33333333-3333-4333-8333-333333333301/submissions/<SUBMISSION_ID>/rejudge \
  -H "Authorization: Bearer tok-alpha-organizer" \
  -H "Content-Type: application/json" \
  -d '{
    "problemVersionId": "55555555-5555-4555-8555-555555555501",
    "testSuiteVersionId": "66666666-6666-4666-8666-666666666601"
  }'
```
