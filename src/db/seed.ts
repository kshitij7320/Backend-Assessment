import { createHash } from 'crypto';
import { Pool } from 'pg';

export const SEED_DATA_VERSION = '2026.1-deterministic';

export const SEED_IDS = {
  orgs: {
    alpha: '11111111-1111-4111-8111-111111111111',
    beta: '22222222-2222-4222-8222-222222222222',
  },
  users: {
    alphaOrganizer: '11111111-1111-4111-8111-111111111101',
    alphaAlice: '11111111-1111-4111-8111-111111111102',
    alphaBob: '11111111-1111-4111-8111-111111111103',
    alphaCharlie: '11111111-1111-4111-8111-111111111104',
    betaOrganizer: '22222222-2222-4222-8222-222222222201',
    betaDiana: '22222222-2222-4222-8222-222222222202',
  },
  tokens: {
    alphaOrganizer: 'tok-alpha-organizer',
    alphaAlice: 'tok-alpha-alice',
    alphaBob: 'tok-alpha-bob',
    alphaCharlie: 'tok-alpha-charlie',
    betaOrganizer: 'tok-beta-organizer',
    betaDiana: 'tok-beta-diana',
  },
  contests: {
    alphaOpen: '33333333-3333-4333-8333-333333333301',
    betaCup: '33333333-3333-4333-8333-333333333302',
  },
  problems: {
    twoSum: '44444444-4444-4444-8444-444444444401',
    arrayMax: '44444444-4444-4444-8444-444444444402',
    palindrome: '44444444-4444-4444-8444-444444444403',
  },
  problemVersions: {
    twoSumV1: '55555555-5555-4555-8555-555555555501',
    arrayMaxV1: '55555555-5555-4555-8555-555555555502',
    palindromeV1: '55555555-5555-4555-8555-555555555503',
  },
  testSuiteVersions: {
    twoSumS1: '66666666-6666-4666-8666-666666666601',
    arrayMaxS1: '66666666-6666-4666-8666-666666666602',
    palindromeS1: '66666666-6666-4666-8666-666666666603',
  },
} as const;

export const SEED_PROGRAMS = {
  correct_two_sum: `import sys\ndata = sys.stdin.read().split()\nif len(data) >= 2:\n    print(int(data[0]) + int(data[1]))\n`,
  correct_array_max: `import sys\ndata = sys.stdin.read().split()\nif len(data) >= 2:\n    n = int(data[0])\n    arr = [int(x) for x in data[1:n+1]]\n    print(max(arr))\n`,
  correct_palindrome: `import sys\ns = sys.stdin.read().strip()\nprint("YES" if s == s[::-1] else "NO")\n`,
  wrong_output: `import sys\ndata = sys.stdin.read().split()\nif len(data) >= 2:\n    print(int(data[0]) + int(data[1]) + 999)\n`,
  runtime_failure: `import sys\nraise RuntimeError("Intentional student division by zero")\n`,
  compilation_failure: `def broken_syntax(:\n    pass\n`,
  timeout: `import time\nwhile True:\n    time.sleep(0.05)\n`,
  excessive_output: `import sys\nsys.stdout.write("X" * (128 * 1024))\nsys.stdout.flush()\n`,
  controllable_runner_crash_once: `# __SHODH_SIMULATE_RUNNER_CRASH_ONCE__\nimport sys\ndata = sys.stdin.read().split()\nif len(data) >= 2:\n    print(int(data[0]) + int(data[1]))\n`,
  controllable_runner_failure_always: `# __SHODH_SIMULATE_RUNNER_FAILURE_ALWAYS__\nimport sys\nprint(0)\n`,
} as const;

export async function seedDeterministicData(
  pool: Pool,
  options: { resetExisting?: boolean } = {},
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (options.resetExisting) {
      await client.query(`
        TRUNCATE TABLE
          contest_standings,
          judging_attempts,
          submissions,
          test_cases,
          test_suite_versions,
          problem_versions,
          problems,
          contest_participations,
          contests,
          organization_memberships,
          users,
          organizations
        RESTART IDENTITY CASCADE;
      `);
      await client.query(`ALTER SEQUENCE judging_fencing_seq RESTART WITH 1;`);
    }

    // 1. Seed 2 Organizations
    await client.query(
      `INSERT INTO organizations (id, slug, name)
       VALUES
         ($1, 'org-alpha', 'Alpha Coding Academy'),
         ($2, 'org-beta', 'Beta Tech Institute')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [SEED_IDS.orgs.alpha, SEED_IDS.orgs.beta],
    );

    // 2. Seed Users (Organizers & Participants)
    const usersToInsert = [
      [
        SEED_IDS.users.alphaOrganizer,
        'organizer@alpha.edu',
        'Dr. Arjun Rao (Alpha Organizer)',
        SEED_IDS.tokens.alphaOrganizer,
      ],
      [
        SEED_IDS.users.alphaAlice,
        'alice@alpha.edu',
        'Alice Verma',
        SEED_IDS.tokens.alphaAlice,
      ],
      [
        SEED_IDS.users.alphaBob,
        'bob@alpha.edu',
        'Bob Sharma',
        SEED_IDS.tokens.alphaBob,
      ],
      [
        SEED_IDS.users.alphaCharlie,
        'charlie@alpha.edu',
        'Charlie Nair',
        SEED_IDS.tokens.alphaCharlie,
      ],
      [
        SEED_IDS.users.betaOrganizer,
        'organizer@beta.edu',
        'Prof. Meera Iyer (Beta Organizer)',
        SEED_IDS.tokens.betaOrganizer,
      ],
      [
        SEED_IDS.users.betaDiana,
        'diana@beta.edu',
        'Diana Kapoor',
        SEED_IDS.tokens.betaDiana,
      ],
    ];

    for (const [id, email, displayName, token] of usersToInsert) {
      await client.query(
        `INSERT INTO users (id, email, display_name, auth_token)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           display_name = EXCLUDED.display_name,
           auth_token = EXCLUDED.auth_token`,
        [id, email, displayName, token],
      );
    }

    // 3. Seed Organization Memberships
    const memberships = [
      [SEED_IDS.orgs.alpha, SEED_IDS.users.alphaOrganizer, 'organizer'],
      [SEED_IDS.orgs.alpha, SEED_IDS.users.alphaAlice, 'participant'],
      [SEED_IDS.orgs.alpha, SEED_IDS.users.alphaBob, 'participant'],
      [SEED_IDS.orgs.alpha, SEED_IDS.users.alphaCharlie, 'participant'],
      [SEED_IDS.orgs.beta, SEED_IDS.users.betaOrganizer, 'organizer'],
      [SEED_IDS.orgs.beta, SEED_IDS.users.betaDiana, 'participant'],
    ];

    for (const [orgId, userId, role] of memberships) {
      await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [orgId, userId, role],
      );
    }

    // 4. Seed 2 Contests (open window covering current date +/- 30 days)
    const startsAt = new Date(Date.now() - 3600_000).toISOString();
    const endsAt = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();

    await client.query(
      `INSERT INTO contests (
         id, organization_id, slug, title, description,
         starts_at, ends_at, penalty_minutes, status_override, created_by
       )
       VALUES
         ($1, $2, 'alpha-spring-open', 'Alpha Spring Algorithmic Open', 'Flagship coding contest for Alpha Coding Academy', $3, $4, 20, NULL, $5),
         ($6, $7, 'beta-winter-cup', 'Beta Winter Programming Cup', 'Private contest for Beta Tech Institute', $3, $4, 15, NULL, $8)
       ON CONFLICT (id) DO UPDATE SET
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         status_override = NULL`,
      [
        SEED_IDS.contests.alphaOpen,
        SEED_IDS.orgs.alpha,
        startsAt,
        endsAt,
        SEED_IDS.users.alphaOrganizer,
        SEED_IDS.contests.betaCup,
        SEED_IDS.orgs.beta,
        SEED_IDS.users.betaOrganizer,
      ],
    );

    // 5. Seed Contest Participations & Initial Standings
    const participations = [
      [SEED_IDS.contests.alphaOpen, SEED_IDS.orgs.alpha, SEED_IDS.users.alphaAlice],
      [SEED_IDS.contests.alphaOpen, SEED_IDS.orgs.alpha, SEED_IDS.users.alphaBob],
      [SEED_IDS.contests.alphaOpen, SEED_IDS.orgs.alpha, SEED_IDS.users.alphaCharlie],
      [SEED_IDS.contests.betaCup, SEED_IDS.orgs.beta, SEED_IDS.users.betaDiana],
    ];

    for (const [contestId, orgId, userId] of participations) {
      await client.query(
        `INSERT INTO contest_participations (contest_id, organization_id, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (contest_id, user_id) DO NOTHING`,
        [contestId, orgId, userId],
      );
      await client.query(
        `INSERT INTO contest_standings (
           contest_id, organization_id, user_id,
           total_points, total_penalty_seconds, solved_count, problem_breakdown
         )
         VALUES ($1, $2, $3, 0, 0, 0, '{}'::jsonb)
         ON CONFLICT (contest_id, user_id) DO NOTHING`,
        [contestId, orgId, userId],
      );
    }

    // 6. Seed 3 Small Problems with Version 1 and Test Suite Version 1
    const problemsSpec = [
      {
        problemId: SEED_IDS.problems.twoSum,
        orgId: SEED_IDS.orgs.alpha,
        contestId: SEED_IDS.contests.alphaOpen,
        code: 'A',
        title: 'Two Integer Sum',
        statement:
          'Given two space-separated integers A and B on standard input, print their sum A + B.',
        pvId: SEED_IDS.problemVersions.twoSumV1,
        tsvId: SEED_IDS.testSuiteVersions.twoSumS1,
        timeLimitMs: 1200,
        memoryLimitMb: 128,
        outputLimitKb: 16,
        maxPoints: 100,
        creatorId: SEED_IDS.users.alphaOrganizer,
        cases: [
          { ordinal: 1, input: '3 5\n', expected: '8', isHidden: false },
          { ordinal: 2, input: '100 -25\n', expected: '75', isHidden: true },
          { ordinal: 3, input: '999999 1\n', expected: '1000000', isHidden: true },
        ],
      },
      {
        problemId: SEED_IDS.problems.arrayMax,
        orgId: SEED_IDS.orgs.alpha,
        contestId: SEED_IDS.contests.alphaOpen,
        code: 'B',
        title: 'Array Maximum',
        statement:
          'Given N followed by N space-separated integers, output the maximum integer.',
        pvId: SEED_IDS.problemVersions.arrayMaxV1,
        tsvId: SEED_IDS.testSuiteVersions.arrayMaxS1,
        timeLimitMs: 1200,
        memoryLimitMb: 128,
        outputLimitKb: 16,
        maxPoints: 200,
        creatorId: SEED_IDS.users.alphaOrganizer,
        cases: [
          { ordinal: 1, input: '4\n1 9 3 4\n', expected: '9', isHidden: false },
          {
            ordinal: 2,
            input: '5\n-10 -3 -50 -1 -99\n',
            expected: '-1',
            isHidden: true,
          },
        ],
      },
      {
        problemId: SEED_IDS.problems.palindrome,
        orgId: SEED_IDS.orgs.beta,
        contestId: SEED_IDS.contests.betaCup,
        code: 'C',
        title: 'Palindrome Check',
        statement:
          'Given a single lowercase word, output YES if it is a palindrome, otherwise NO.',
        pvId: SEED_IDS.problemVersions.palindromeV1,
        tsvId: SEED_IDS.testSuiteVersions.palindromeS1,
        timeLimitMs: 1200,
        memoryLimitMb: 128,
        outputLimitKb: 16,
        maxPoints: 150,
        creatorId: SEED_IDS.users.betaOrganizer,
        cases: [
          { ordinal: 1, input: 'racecar\n', expected: 'YES', isHidden: false },
          { ordinal: 2, input: 'shodhcode\n', expected: 'NO', isHidden: true },
        ],
      },
    ];

    for (const p of problemsSpec) {
      await client.query(
        `INSERT INTO problems (id, organization_id, contest_id, code, title)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
        [p.problemId, p.orgId, p.contestId, p.code, p.title],
      );

      const runtimeConfig = {
        timeLimitMs: p.timeLimitMs,
        memoryLimitMb: p.memoryLimitMb,
        outputLimitKb: p.outputLimitKb,
        pidsLimit: 32,
        maxPoints: p.maxPoints,
      };

      await client.query(
        `INSERT INTO problem_versions (
           id, problem_id, version_number, statement,
           time_limit_ms, memory_limit_mb, output_limit_kb, max_points,
           runtime_config, created_by
         )
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.pvId,
          p.problemId,
          p.statement,
          p.timeLimitMs,
          p.memoryLimitMb,
          p.outputLimitKb,
          p.maxPoints,
          JSON.stringify(runtimeConfig),
          p.creatorId,
        ],
      );

      const checksum = createHash('sha256')
        .update(JSON.stringify(p.cases))
        .digest('hex');

      await client.query(
        `INSERT INTO test_suite_versions (
           id, problem_id, problem_version_id, suite_version_number,
           notes, checksum, created_by
         )
         VALUES ($1, $2, $3, 1, 'Seed test suite v1', $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [p.tsvId, p.problemId, p.pvId, checksum, p.creatorId],
      );

      for (const tc of p.cases) {
        await client.query(
          `INSERT INTO test_cases (
             test_suite_version_id, ordinal, input_data, expected_output,
             is_hidden, points_weight
           )
           VALUES ($1, $2, $3, $4, $5, 1)
           ON CONFLICT (test_suite_version_id, ordinal) DO UPDATE SET
             input_data = EXCLUDED.input_data,
             expected_output = EXCLUDED.expected_output,
             is_hidden = EXCLUDED.is_hidden`,
          [p.tsvId, tc.ordinal, tc.input, tc.expected, tc.isHidden],
        );
      }

      await client.query(
        `UPDATE problems
         SET current_version_id = $1,
             current_test_suite_version_id = $2
         WHERE id = $3 AND current_version_id IS NULL`,
        [p.pvId, p.tsvId, p.problemId],
      );
    }

    await client.query('COMMIT');
    return {
      seed_version: SEED_DATA_VERSION,
      organizations: 2,
      users: usersToInsert.length,
      contests: 2,
      problems: problemsSpec.length,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
