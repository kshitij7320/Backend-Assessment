import { Inject, Injectable } from '@nestjs/common';
import { spawn, execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import {
  ExecuteSubmissionInput,
  SuiteExecutionSummary,
  TestCaseExecutionResult,
} from './runner.interface';
import { FaultInjectionService } from './fault-injection.service';

const execFileAsync = promisify(execFile);

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

export function normalizeProgramOutput(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

@Injectable()
export class DockerRunnerService {
  private readonly pythonImage: string;
  private readonly nodeImage: string;

  constructor(
    @Inject(FaultInjectionService)
    private readonly faultInjection: FaultInjectionService,
  ) {
    this.pythonImage = process.env.DOCKER_SANDBOX_IMAGE || 'python:3.12-alpine';
    this.nodeImage = process.env.DOCKER_NODE_SANDBOX_IMAGE || 'node:22-alpine';
  }

  public getIsolationLimitsSummary() {
    return {
      network: 'none (--network none)',
      user: '65534:65534 (unprivileged nobody:nogroup)',
      rootFilesystem: 'read-only (--read-only) with ephemeral noexec tmpfs (/tmp:rw,noexec,nosuid,nodev,size=16m)',
      capabilities: 'all dropped (--cap-drop ALL, --security-opt no-new-privileges:true)',
      cpuQuota: '0.5 vCPU (--cpus 0.5)',
      pidsLimit: 32,
      hostMounts: 'none (zero -v or --mount flags; no host paths or /var/run/docker.sock mounted)',
    };
  }

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
        execution_mode: 'docker',
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
      const tcResult = await this.runSingleTestCaseInDocker(input, tc);
      testResults.push(tcResult);
      totalTimeMs += tcResult.execution_time_ms;

      if (tcResult.verdict !== 'ACCEPTED') {
        overallVerdict = tcResult.verdict;
        errorDetail = tcResult.error_reason;
        // Stop on Compilation Error or Judge Failure immediately
        if (
          tcResult.verdict === 'COMPILATION_ERROR' ||
          tcResult.verdict === 'JUDGE_FAILURE'
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
      memory_kb: input.runtimeConfig.memoryLimitMb * 1024,
      execution_mode: 'docker',
      test_results: testResults,
      error_detail: errorDetail,
    };
  }

  private async runSingleTestCaseInDocker(
    input: ExecuteSubmissionInput,
    tc: ExecuteSubmissionInput['testCases'][number],
  ): Promise<TestCaseExecutionResult> {
    const randSuffix = randomBytes(4).toString('hex');
    const containerName = `shodh-sbx-${input.attemptId.slice(0, 8)}-${tc.ordinal}-${randSuffix}`;

    const memoryMb = Math.max(16, input.runtimeConfig.memoryLimitMb || 128);
    const pidsLimit = input.runtimeConfig.pidsLimit || 32;
    const maxOutputBytes =
      Math.max(4, input.runtimeConfig.outputLimitKb || 64) * 1024;
    const wallTimeLimitMs = Math.max(
      200,
      input.runtimeConfig.timeLimitMs || 2000,
    );

    const codeBase64 = Buffer.from(input.sourceCode, 'utf8').toString('base64');

    const dockerArgs: string[] = [
      'run',
      '--name',
      containerName,
      '--rm',
      '-i',
      '--network',
      'none',
      '--cpus',
      '0.5',
      '--memory',
      `${memoryMb}m`,
      '--memory-swap',
      `${memoryMb}m`,
      '--pids-limit',
      String(pidsLimit),
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--user',
      '65534:65534',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
    ];

    if (input.language === 'python') {
      dockerArgs.push(
        '-e',
        'PYTHONDONTWRITEBYTECODE=1',
        '-e',
        'PYTHONUNBUFFERED=1',
        this.pythonImage,
        'python3',
        '-I',
        '-c',
        PYTHON_HARNESS,
        codeBase64,
      );
    } else {
      const jsHarness = `
        const code = Buffer.from(process.argv[1], 'base64').toString('utf8');
        try { new Function(code); } catch (e) { console.error(e); process.exit(201); }
        eval(code);
      `;
      dockerArgs.push(
        this.nodeImage,
        'node',
        '-e',
        jsHarness,
        codeBase64,
      );
    }

    const startTime = Date.now();
    let timedOut = false;
    let outputExceeded = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    return new Promise<TestCaseExecutionResult>((resolve) => {
      const child = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Add a small allowance for container init so student code gets its full wallTimeLimitMs
      const containerOverheadAllowanceMs = 800;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        void this.forceRemoveContainer(containerName);
      }, wallTimeLimitMs + containerOverheadAllowanceMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          outputExceeded = true;
          child.kill('SIGKILL');
          void this.forceRemoveContainer(containerName);
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          outputExceeded = true;
          child.kill('SIGKILL');
          void this.forceRemoveContainer(containerName);
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on('error', async (err) => {
        clearTimeout(timer);
        await this.forceRemoveContainer(containerName);
        resolve({
          ordinal: tc.ordinal,
          is_hidden: tc.is_hidden,
          verdict: 'JUDGE_FAILURE',
          execution_time_ms: Date.now() - startTime,
          output_bytes: stdoutBytes,
          error_reason: `Docker spawn error: ${err.message}`,
        });
      });

      child.on('close', async (exitCode) => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - startTime;
        const stderrText = Buffer.concat(stderrChunks).toString('utf8');

        if (timedOut || outputExceeded) {
          await this.forceRemoveContainer(containerName);
        }

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
            error_reason: 'Program syntax or compilation error',
          });
        }

        // Docker daemon / CLI internal failure codes (125, 126, 127)
        if (exitCode === 125 || exitCode === 126 || exitCode === 127) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'JUDGE_FAILURE',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
            error_reason: `Docker runtime error (exit code ${exitCode})`,
          });
        }

        // OOM kill inside container (SIGKILL = 137 when not timedOut or outputExceeded)
        if (exitCode === 137 || stderrText.includes('MemoryError')) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'MEMORY_LIMIT_EXCEEDED',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
            error_reason: `Program exceeded memory limit of ${memoryMb}MB`,
          });
        }

        if (exitCode !== 0) {
          return resolve({
            ordinal: tc.ordinal,
            is_hidden: tc.is_hidden,
            verdict: 'RUNTIME_ERROR',
            execution_time_ms: elapsedMs,
            output_bytes: stdoutBytes,
            error_reason: `Program exited with non-zero status (${exitCode})`,
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
            error_reason: 'Output did not match expected output',
          });
        }
      });

      child.stdin.on('error', () => {
        // Ignore EPIPE if process exits before consuming all stdin
      });
      child.stdin.write(tc.input_data);
      child.stdin.end();
    });
  }

  private async forceRemoveContainer(containerName: string): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '-f', containerName]);
    } catch {
      // Container already removed by --rm
    }
  }
}
