import { Global, Module } from '@nestjs/common';
import { DockerRunnerService } from './docker-runner.service';
import { DeterministicRunnerService } from './deterministic-runner.service';
import { FaultInjectionService } from './fault-injection.service';
import { WorkerService } from './worker.service';
import { StandingsModule } from '../standings/standings.module';

@Global()
@Module({
  imports: [StandingsModule],
  providers: [
    FaultInjectionService,
    DockerRunnerService,
    DeterministicRunnerService,
    WorkerService,
  ],
  exports: [
    FaultInjectionService,
    DockerRunnerService,
    DeterministicRunnerService,
    WorkerService,
  ],
})
export class JudgeModule {}
