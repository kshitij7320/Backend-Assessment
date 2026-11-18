export type SubmissionVerdict =
  | 'PENDING'
  | 'ACCEPTED'
  | 'WRONG_ANSWER'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'COMPILATION_ERROR'
  | 'RUNTIME_ERROR'
  | 'JUDGE_FAILURE';

export type ExecutionMode = 'docker' | 'deterministic-double';

export interface SandboxRuntimeConfig {
  timeLimitMs: number;
  memoryLimitMb: number;
  outputLimitKb: number;
  pidsLimit?: number;
  maxPoints: number;
}

export interface RunnerTestCase {
  id: string;
  ordinal: number;
  input_data: string;
  expected_output: string;
  is_hidden: boolean;
  points_weight: number;
}

export interface TestCaseExecutionResult {
  ordinal: number;
  is_hidden: boolean;
  verdict: Exclude<SubmissionVerdict, 'PENDING'>;
  execution_time_ms: number;
  output_bytes: number;
  error_reason?: string;
}

export interface SuiteExecutionSummary {
  verdict: Exclude<SubmissionVerdict, 'PENDING'>;
  awarded_points: number;
  execution_time_ms: number;
  memory_kb: number;
  execution_mode: ExecutionMode;
  test_results: TestCaseExecutionResult[];
  error_detail?: string;
}

export interface ExecuteSubmissionInput {
  submissionId: string;
  attemptId: string;
  attemptNumber: number;
  retryCount: number;
  language: 'python' | 'javascript';
  sourceCode: string;
  runtimeConfig: SandboxRuntimeConfig;
  testCases: RunnerTestCase[];
}

