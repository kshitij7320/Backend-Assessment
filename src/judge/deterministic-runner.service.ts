import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import {
  ExecuteSubmissionInput,
  SuiteExecutionSummary,
  TestCaseExecutionResult,
} from './runner.interface';
import { FaultInjectionService } from './fault-injection.service';
import { normalizeProgramOutput } from './docker-runner.service';

const PYTHON_HARNESS = `
import base64, sys
code_b64 = sys.argv[1]
try:
    source = base64.b64decode(code_b64).decode('utf-8')
    compiled = compile(source, 'solution.py', 'exec')
except SyntaxError as e:
    sys.stderr.write(f"SyntaxError: {e}\\n")
    sys.exit(201)
except Exception as e:
    sys.stderr.write(f"CompileDecodeError: {e}\\n")
    sys.exit(201)

exec(compiled, {'__name__': '__main__'})
`.trim();

@Injectable()
export class DeterministicRunnerService {
  constructor(private readonly faultInjection: FaultInjectionService) {}

  public async executeSuite(
    input: ExecuteSubmissionInput,
  ): Promise<SuiteExecutionSummary> {
    if (
      this.faultInjection.shouldSimulateRunnerFailure(
        input.submissionId,
        input.retryCount,
        input.sourceCode,
      )
    ) {
      return {
        verdict: 'JUDGE_FAILURE',
        awarded_points: 0,
        execution_time_ms: 0,
        memory_kb: 0,
        execution_mode: 'deterministic-double',
        test_results: [],
        error_detail: 'Simulated judge runner infrastructure failure',
      };
    }

    const artificialDelay = this.faultInjection.getArtificialDelayMs(
      input.submissionId,
      input.attemptId,
    );
    if (artificialDelay > 0) {
      await new Promise((r) => setTimeout(r, artificialDelay));
    }

    const barrier = this.faultInjection.getSubmissionBarrier(input.submissionId);
    if (barrier) {
      barrier.arrivedCount += 1;
      barrier.onArrive?.();
      await barrier.promise;
    }

    const testResults: TestCaseExecutionResult[] = [];
    let totalTimeMs = 0;
    let overallVerdict: SuiteExecutionSummary['verdict'] = 'ACCEPTED';
    let errorDetail: string | undefined;

    for (const tc of input.testCases) {
      const res = await this.runTestCaseSubprocess(input, tc);
      testResults.push(res);
      totalTimeMs += res.execution_time_ms;

      if (res.verdict !== 'ACCEPTED') {
        overallVerdict = res.verdict;
        errorDetail = res.error_reason;
        if (
          res.verdict === 'COMPILATION_ERROR' ||
          res.verdict === 'JUDGE_FAILURE'
        ) {
          break;
        }
      }
    }

    const awardedPoints =
      overallVerdict === 'ACCEPTED' ? input.runtimeConfig.maxPoints : 0;

    return {
      verdict: overallVerdict,
      awarded_points: awardedPoints,
      execution_time_ms: totalTimeMs,
      memory_kb: 16384,
      execution_mode: 'deterministic-double',
      test_results: testResults,
      error_detail: errorDetail,
    };
  }

  private async runTestCaseSubprocess(
    input: ExecuteSubmissionInput,
    tc: ExecuteSubmissionInput['testCases'][number],
  ): Promise<TestCaseExecutionResult> {
    const wallTimeLimitMs = Math.max(
      100,
      input.runtimeConfig.timeLimitMs || 2000,
    );
    const maxOutputBytes =
      Math.max(4, input.runtimeConfig.outputLimitKb || 64) * 1024;
    const codeBase64 = Buffer.from(input.sourceCode, 'utf8').toString('base64');

    const cmd = input.language === 'python' ? 'python3' : 'node';
    const args =
      input.language === 'python'
        ? ['-I', '-c', PYTHON_HARNESS, codeBase64]
        : [
            '-e',
            `const c=Buffer.from(process.argv[1],'base64').toString('utf8');try{new Function(c);}catch(e){process.exit(201);}eval(c);`,
            codeBase64,
          ];

    const startTime = Date.now();
    let timedOut = false;
    let outputExceeded = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    return new Promise<TestCaseExecutionResult>((resolve) => {
      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/bin:/bin:/opt/homebrew/bin' },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, wallTimeLimitMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          outputExceeded = true;
          child.kill('SIGKILL');
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          outputExceeded = true;
          child.kill('SIGKILL');
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          ordinal: tc.ordinal,
          is_hidden: tc.is_hidden,
          verdict: 'JUDGE_FAILURE',
          execution_time_ms: Date.now() - startTime,
          output_bytes: stdoutBytes,
          error_reason: `Runner process error: ${err.message}`,
        });
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - startTime;
        const stderrText = Buffer.concat(stderrChunks).toString('utf8');

        if (outputExceeded) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'OUTPUT_LIMIT_EXCEEDED',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes + stderrBytes,
            error_reason: `Output exceeded limit of ${maxOutputBytes} bytes`,
          });
        }

        if (timedOut) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'TIME_LIMIT_EXCEEDED',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
            error_reason: `Execution exceeded wall time limit of ${wallTimeLimitMs}ms`,
          });
        }

        if (exitCode === 201) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'COMPILATION_ERROR',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
            error_reason: 'Syntax or compilation error',
          });
        }

        if (stderrText.includes('MemoryError')) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'MEMORY_LIMIT_EXCEEDED',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
            error_reason: 'MemoryLimitExceeded',
          });
        }

        if (exitCode !== 0) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'RUNTIME_ERROR',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
            error_reason: `Non-zero exit code ${exitCode}`,
          });
        }

        const actualOutput = normalizeProgramOutput(
          Buffer.concat(stdoutChunks).toString('utf8'),
        );
        const expectedOutput = normalizeProgramOutput(tc.expected_output);

        if (actualOutput === expectedOutput) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'ACCEPTED',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
          });
        } else {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'WRONG_ANSWER',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
            error_reason: 'Output mismatch',
          });
        }
      });

      child.stdin.on('error', () => {});
      child.stdin.write(tc.input_data);
      child.stdin.end();
    });
  }
}
