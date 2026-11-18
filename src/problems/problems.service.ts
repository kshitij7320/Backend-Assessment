import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  createBusinessRuleError,
  createNotFoundError,
  createValidationError,
} from '../common/errors/domain-errors';
import {
  assertIntInRange,
  assertNonEmptyString,
  assertUuid,
  parsePagination,
} from '../common/validation/validator';
import { AuthenticatedActor, OrgRole } from '../auth/auth.service';

export interface TestCaseInput {
  ordinal?: number;
  inputData: string;
  expectedOutput: string;
  isHidden?: boolean;
  pointsWeight?: number;
}

@Injectable()
export class ProblemsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly orgsService: OrganizationsService,
  ) {}

  private normalizeTestCases(rawCases: unknown): Required<TestCaseInput>[] {
    if (!Array.isArray(rawCases) || rawCases.length === 0) {
      throw createValidationError(
        'INVALID_TEST_CASES',
        'testCases must be a non-empty array of test cases',
      );
    }

    return rawCases.map((tc: any, idx: number) => {
      if (!tc || typeof tc !== 'object') {
        throw createValidationError(
          'INVALID_TEST_CASE_ITEM',
          `testCases[${idx}] must be an object`,
        );
      }
      if (typeof tc.inputData !== 'string') {
        throw createValidationError(
          'INVALID_TEST_CASE_INPUT',
          `testCases[${idx}].inputData must be a string`,
        );
      }
      if (typeof tc.expectedOutput !== 'string') {
        throw createValidationError(
          'INVALID_TEST_CASE_OUTPUT',
          `testCases[${idx}].expectedOutput must be a string`,
        );
      }
      const ordinal =
        tc.ordinal !== undefined
          ? assertIntInRange(tc.ordinal, `testCases[${idx}].ordinal`, 1, 1000)
          : idx + 1;
      const isHidden = tc.isHidden !== undefined ? Boolean(tc.isHidden) : idx > 0;
      const pointsWeight =
        tc.pointsWeight !== undefined
          ? assertIntInRange(
              tc.pointsWeight,
              `testCases[${idx}].pointsWeight`,
              0,
              1000,
            )
          : 1;

      return {
        ordinal,
        inputData: tc.inputData,
        expectedOutput: tc.expectedOutput,
        isHidden,
        pointsWeight,
      };
    });
  }

  private computeSuiteChecksum(cases: Required<TestCaseInput>[]): string {
    const canonical = JSON.stringify(
      cases.map((c) => ({
        ordinal: c.ordinal,
        inputData: c.inputData,
        expectedOutput: c.expectedOutput,
        isHidden: c.isHidden,
        pointsWeight: c.pointsWeight,
      })),
    );
    return createHash('sha256').update(canonical).digest('hex');
  }

  public async createProblem(
    orgId: string,
    contestId: string,
    actor: AuthenticatedActor,
    body: Record<string, any>,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );

    const problemId = body.id ? assertUuid(body.id, 'id') : randomUUID();
    const code = assertNonEmptyString(body.code, 'code', 20).toUpperCase();
    const title = assertNonEmptyString(body.title, 'title', 200);
    const statement = assertNonEmptyString(body.statement, 'statement', 20000);
    const timeLimitMs =
      body.timeLimitMs !== undefined
        ? assertIntInRange(body.timeLimitMs, 'timeLimitMs', 100, 15000)
        : 2000;
    const memoryLimitMb =
      body.memoryLimitMb !== undefined
        ? assertIntInRange(body.memoryLimitMb, 'memoryLimitMb', 16, 1024)
        : 128;
    const outputLimitKb =
      body.outputLimitKb !== undefined
        ? assertIntInRange(body.outputLimitKb, 'outputLimitKb', 4, 4096)
        : 64;
    const maxPoints =
      body.maxPoints !== undefined
        ? assertIntInRange(body.maxPoints, 'maxPoints', 1, 10000)
        : 100;

    const normalizedCases = this.normalizeTestCases(body.testCases);
    const checksum = this.computeSuiteChecksum(normalizedCases);

    const runtimeConfig = {
      timeLimitMs,
      memoryLimitMb,
      outputLimitKb,
      pidsLimit: 32,
      maxPoints,
      allowedLanguages: ['python', 'javascript'],
    };

    return this.db.withTransaction(async (client) => {
      const existingCode = await client.query(
        `SELECT id FROM problems WHERE contest_id = $1 AND code = $2 AND id <> $3`,
        [contestId, code, problemId],
      );
      if ((existingCode.rowCount ?? 0) > 0) {
        throw createBusinessRuleError(
          'PROBLEM_CODE_CONFLICT',
          `Problem code '${code}' already exists in this contest`,
        );
      }

      const probRes = await client.query(
        `INSERT INTO problems (id, organization_id, contest_id, code, title)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [problemId, orgId, contestId, code, title],
      );

      const pvId = body.problemVersionId
        ? assertUuid(body.problemVersionId, 'problemVersionId')
        : randomUUID();
      const pvRes = await client.query(
        `INSERT INTO problem_versions (
           id, problem_id, version_number, statement,
           time_limit_ms, memory_limit_mb, output_limit_kb, max_points,
           runtime_config, created_by
         )
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING *`,
        [
          pvId,
          problemId,
          statement,
          timeLimitMs,
          memoryLimitMb,
          outputLimitKb,
          maxPoints,
          JSON.stringify(runtimeConfig),
          actor.userId,
        ],
      );

      const tsvId = body.testSuiteVersionId
        ? assertUuid(body.testSuiteVersionId, 'testSuiteVersionId')
        : randomUUID();
      const tsvRes = await client.query(
        `INSERT INTO test_suite_versions (
           id, problem_id, problem_version_id, suite_version_number,
           notes, checksum, created_by
         )
         VALUES ($1, $2, $3, 1, $4, $5, $6)
         RETURNING *`,
        [
          tsvId,
          problemId,
          pvId,
          body.notes || 'Initial test suite v1',
          checksum,
          actor.userId,
        ],
      );

      for (const tc of normalizedCases) {
        await client.query(
          `INSERT INTO test_cases (
             test_suite_version_id, ordinal, input_data, expected_output,
             is_hidden, points_weight
           )
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            tsvId,
            tc.ordinal,
            tc.inputData,
            tc.expectedOutput,
            tc.isHidden,
            tc.pointsWeight,
          ],
        );
      }

      await client.query(
        `UPDATE problems
         SET current_version_id = $1,
             current_test_suite_version_id = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [pvId, tsvId, problemId],
      );

      return {
        ...probRes.rows[0],
        current_version_id: pvId,
        current_test_suite_version_id: tsvId,
        current_version: pvRes.rows[0],
        current_test_suite_version: tsvRes.rows[0],
        test_case_count: normalizedCases.length,
      };
    });
  }

  public async createProblemVersion(
    orgId: string,
    contestId: string,
    problemId: string,
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
      'problems',
      problemId,
      orgId,
      'problemId',
    );

    return this.db.withTransaction(async (client) => {
      const probRes = await client.query(
        `SELECT * FROM problems WHERE id = $1 AND contest_id = $2 AND organization_id = $3 FOR UPDATE`,
        [problemId, contestId, orgId],
      );
      if (probRes.rowCount === 0) {
        throw createNotFoundError(
          'PROBLEM_NOT_FOUND',
          'Problem not found in this contest',
        );
      }
      const problem = probRes.rows[0];

      const curVerRes = await client.query(
        `SELECT * FROM problem_versions WHERE id = $1`,
        [problem.current_version_id],
      );
      const curVer = curVerRes.rows[0];

      const maxVerRes = await client.query<{ max_v: number }>(
        `SELECT COALESCE(MAX(version_number), 0)::int AS max_v
         FROM problem_versions WHERE problem_id = $1`,
        [problemId],
      );
      const nextVersionNumber = (maxVerRes.rows[0]?.max_v || 0) + 1;

      const statement =
        body.statement !== undefined
          ? assertNonEmptyString(body.statement, 'statement', 20000)
          : curVer.statement;
      const timeLimitMs =
        body.timeLimitMs !== undefined
          ? assertIntInRange(body.timeLimitMs, 'timeLimitMs', 100, 15000)
          : curVer.time_limit_ms;
      const memoryLimitMb =
        body.memoryLimitMb !== undefined
          ? assertIntInRange(body.memoryLimitMb, 'memoryLimitMb', 16, 1024)
          : curVer.memory_limit_mb;
      const outputLimitKb =
        body.outputLimitKb !== undefined
          ? assertIntInRange(body.outputLimitKb, 'outputLimitKb', 4, 4096)
          : curVer.output_limit_kb;
      const maxPoints =
        body.maxPoints !== undefined
          ? assertIntInRange(body.maxPoints, 'maxPoints', 1, 10000)
          : curVer.max_points;

      const runtimeConfig = {
        timeLimitMs,
        memoryLimitMb,
        outputLimitKb,
        pidsLimit: 32,
        maxPoints,
        allowedLanguages: ['python', 'javascript'],
      };

      const newPvId = body.problemVersionId
        ? assertUuid(body.problemVersionId, 'problemVersionId')
        : randomUUID();
      const newPvRes = await client.query(
        `INSERT INTO problem_versions (
           id, problem_id, version_number, statement,
           time_limit_ms, memory_limit_mb, output_limit_kb, max_points,
           runtime_config, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         RETURNING *`,
        [
          newPvId,
          problemId,
          nextVersionNumber,
          statement,
          timeLimitMs,
          memoryLimitMb,
          outputLimitKb,
          maxPoints,
          JSON.stringify(runtimeConfig),
          actor.userId,
        ],
      );

      let newTsvId = problem.current_test_suite_version_id;
      let newTsvRow: any = null;

      if (body.testCases !== undefined) {
        const normalizedCases = this.normalizeTestCases(body.testCases);
        const checksum = this.computeSuiteChecksum(normalizedCases);

        const maxSuiteRes = await client.query<{ max_s: number }>(
          `SELECT COALESCE(MAX(suite_version_number), 0)::int AS max_s
           FROM test_suite_versions WHERE problem_id = $1`,
          [problemId],
        );
        const nextSuiteNumber = (maxSuiteRes.rows[0]?.max_s || 0) + 1;

        newTsvId = body.testSuiteVersionId
          ? assertUuid(body.testSuiteVersionId, 'testSuiteVersionId')
          : randomUUID();
        const tsvRes = await client.query(
          `INSERT INTO test_suite_versions (
             id, problem_id, problem_version_id, suite_version_number,
             notes, checksum, created_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            newTsvId,
            problemId,
            newPvId,
            nextSuiteNumber,
            body.notes || `Test suite v${nextSuiteNumber}`,
            checksum,
            actor.userId,
          ],
        );
        newTsvRow = tsvRes.rows[0];

        for (const tc of normalizedCases) {
          await client.query(
            `INSERT INTO test_cases (
               test_suite_version_id, ordinal, input_data, expected_output,
               is_hidden, points_weight
             )
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              newTsvId,
              tc.ordinal,
              tc.inputData,
              tc.expectedOutput,
              tc.isHidden,
              tc.pointsWeight,
            ],
          );
        }
      } else {
        const curTsvRes = await client.query(
          `SELECT * FROM test_suite_versions WHERE id = $1`,
          [newTsvId],
        );
        newTsvRow = curTsvRes.rows[0];
      }

      const title =
        body.title !== undefined
          ? assertNonEmptyString(body.title, 'title', 200)
          : problem.title;

      await client.query(
        `UPDATE problems
         SET title = $1,
             current_version_id = $2,
             current_test_suite_version_id = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [title, newPvId, newTsvId, problemId],
      );

      return {
        problem_id: problemId,
        title,
        current_version_id: newPvId,
        current_test_suite_version_id: newTsvId,
        problem_version: newPvRes.rows[0],
        test_suite_version: newTsvRow,
      };
    });
  }

  public async listProblems(
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
    const { limit, offset } = parsePagination(query);

    const [itemsRes, countRes] = await Promise.all([
      this.db.query(
        `SELECT p.id, p.organization_id, p.contest_id, p.code, p.title,
                p.current_version_id, p.current_test_suite_version_id,
                pv.version_number, pv.time_limit_ms, pv.memory_limit_mb,
                pv.output_limit_kb, pv.max_points,
                tsv.suite_version_number
         FROM problems p
         LEFT JOIN problem_versions pv ON pv.id = p.current_version_id
         LEFT JOIN test_suite_versions tsv ON tsv.id = p.current_test_suite_version_id
         WHERE p.contest_id = $1 AND p.organization_id = $2
         ORDER BY p.code ASC, p.id ASC
         LIMIT $3 OFFSET $4`,
        [contestId, orgId, limit, offset],
      ),
      this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM problems WHERE contest_id = $1 AND organization_id = $2`,
        [contestId, orgId],
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

  public async getProblem(
    orgId: string,
    contestId: string,
    problemId: string,
    role: OrgRole,
  ) {
    await this.orgsService.assertObjectBelongsToOrg(
      'contests',
      contestId,
      orgId,
      'contestId',
    );
    await this.orgsService.assertObjectBelongsToOrg(
      'problems',
      problemId,
      orgId,
      'problemId',
    );

    const probRes = await this.db.query(
      `SELECT * FROM problems WHERE id = $1 AND contest_id = $2 AND organization_id = $3`,
      [problemId, contestId, orgId],
    );
    if (probRes.rowCount === 0) {
      throw createNotFoundError(
        'PROBLEM_NOT_FOUND',
        'Problem not found in this contest',
      );
    }
    const problem = probRes.rows[0];

    const [pvRes, tsvRes, allVersionsRes, allSuitesRes, testCasesRes] =
      await Promise.all([
        this.db.query(`SELECT * FROM problem_versions WHERE id = $1`, [
          problem.current_version_id,
        ]),
        this.db.query(`SELECT * FROM test_suite_versions WHERE id = $1`, [
          problem.current_test_suite_version_id,
        ]),
        this.db.query(
          `SELECT id, version_number, time_limit_ms, memory_limit_mb, output_limit_kb, max_points, created_at
           FROM problem_versions WHERE problem_id = $1 ORDER BY version_number DESC`,
          [problemId],
        ),
        this.db.query(
          `SELECT id, suite_version_number, problem_version_id, checksum, notes, created_at
           FROM test_suite_versions WHERE problem_id = $1 ORDER BY suite_version_number DESC`,
          [problemId],
        ),
        this.db.query(
          `SELECT id, ordinal, input_data, expected_output, is_hidden, points_weight
           FROM test_cases
           WHERE test_suite_version_id = $1
           ORDER BY ordinal ASC`,
          [problem.current_test_suite_version_id],
        ),
      ]);

    const allCases = testCasesRes.rows;
    const sampleCases = allCases
      .filter((tc) => !tc.is_hidden)
      .map((tc) => ({
        ordinal: tc.ordinal,
        input_data: tc.input_data,
        expected_output: tc.expected_output,
        is_hidden: false,
      }));
    const hiddenCount = allCases.filter((tc) => tc.is_hidden).length;

    const baseResponse = {
      ...problem,
      current_version: pvRes.rows[0],
      current_test_suite_version: tsvRes.rows[0],
      sample_test_cases: sampleCases,
      hidden_test_case_count: hiddenCount,
    };

    if (role === 'organizer') {
      return {
        ...baseResponse,
        all_test_cases: allCases,
        problem_versions: allVersionsRes.rows,
        test_suite_versions: allSuitesRes.rows,
      };
    }

    return baseResponse;
  }
}
