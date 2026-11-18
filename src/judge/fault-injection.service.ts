import { Injectable } from '@nestjs/common';

export interface BarrierHook {
  promise: Promise<void>;
  release: () => void;
  arrivedCount: number;
  onArrive?: () => void;
}

@Injectable()
export class FaultInjectionService {
  private failAfterCommitSubmissionIds = new Set<string>();
  private failBeforeAckAttemptIds = new Set<string>();
  private failBeforeAckSubmissionOnceIds = new Set<string>();
  private failRunnerSubmissionOnceIds = new Set<string>();
  private failRunnerAlwaysSubmissionIds = new Set<string>();
  private artificialDelayByAttemptId = new Map<string, number>();
  private artificialDelayBySubmissionId = new Map<string, number>();
  private barriersBySubmissionId = new Map<string, BarrierHook>();

  public resetAll(): void {
    this.failAfterCommitSubmissionIds.clear();
    this.failBeforeAckAttemptIds.clear();
    this.failBeforeAckSubmissionOnceIds.clear();
    this.failRunnerSubmissionOnceIds.clear();
    this.failRunnerAlwaysSubmissionIds.clear();
    this.artificialDelayByAttemptId.clear();
    this.artificialDelayBySubmissionId.clear();
    this.barriersBySubmissionId.clear();
  }

  public armFailAfterCommitBeforeDispatch(submissionId: string): void {
    this.failAfterCommitSubmissionIds.add(submissionId);
  }

  public consumeFailAfterCommitBeforeDispatch(submissionId: string): boolean {
    if (this.failAfterCommitSubmissionIds.has(submissionId)) {
      this.failAfterCommitSubmissionIds.delete(submissionId);
      return true;
    }
    return false;
  }

  public armFailBeforeAckOnceForSubmission(submissionId: string): void {
    this.failBeforeAckSubmissionOnceIds.add(submissionId);
  }

  public consumeFailBeforeAck(submissionId: string, attemptId: string): boolean {
    if (this.failBeforeAckAttemptIds.has(attemptId)) {
      this.failBeforeAckAttemptIds.delete(attemptId);
      return true;
    }
    if (this.failBeforeAckSubmissionOnceIds.has(submissionId)) {
      this.failBeforeAckSubmissionOnceIds.delete(submissionId);
      return true;
    }
    return false;
  }

  public armRunnerCrashOnceForSubmission(submissionId: string): void {
    this.failRunnerSubmissionOnceIds.add(submissionId);
  }

  public armRunnerCrashAlwaysForSubmission(submissionId: string): void {
    this.failRunnerAlwaysSubmissionIds.add(submissionId);
  }

  public shouldSimulateRunnerFailure(
    submissionId: string,
    retryCount: number,
    sourceCode: string,
  ): boolean {
    if (this.failRunnerAlwaysSubmissionIds.has(submissionId)) {
      return true;
    }
    if (this.failRunnerSubmissionOnceIds.has(submissionId)) {
      this.failRunnerSubmissionOnceIds.delete(submissionId);
      return true;
    }
    if (sourceCode.includes('__SHODH_SIMULATE_RUNNER_FAILURE_ALWAYS__')) {
      return true;
    }
    if (
      sourceCode.includes('__SHODH_SIMULATE_RUNNER_CRASH_ONCE__') &&
      retryCount === 0
    ) {
      return true;
    }
    return false;
  }

  public setArtificialDelayForSubmission(
    submissionId: string,
    delayMs: number,
  ): void {
    this.artificialDelayBySubmissionId.set(submissionId, delayMs);
  }

  public setArtificialDelayForAttempt(attemptId: string, delayMs: number): void {
    this.artificialDelayByAttemptId.set(attemptId, delayMs);
  }

  public getArtificialDelayMs(submissionId: string, attemptId: string): number {
    return (
      this.artificialDelayByAttemptId.get(attemptId) ??
      this.artificialDelayBySubmissionId.get(submissionId) ??
      0
    );
  }

  public registerSubmissionBarrier(
    submissionId: string,
    onArrive?: () => void,
  ): BarrierHook {
    let releaseFn!: () => void;
    const promise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    const hook: BarrierHook = {
      promise,
      release: releaseFn,
      arrivedCount: 0,
      onArrive,
    };
    this.barriersBySubmissionId.set(submissionId, hook);
    return hook;
  }

  public getSubmissionBarrier(submissionId: string): BarrierHook | undefined {
    return this.barriersBySubmissionId.get(submissionId);
  }
}
