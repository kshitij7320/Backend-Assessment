import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './auth/auth.guard';
import { DatabaseService } from './db/database.service';
import { DockerRunnerService } from './judge/docker-runner.service';

@ApiTags('Health & Diagnostics')
@Controller('api/v1/health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly dockerRunner: DockerRunnerService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'System health check, execution mode, and sandbox isolation limits',
  })
  async getHealth() {
    await this.db.query('SELECT 1');
    return {
      status: 'ok',
      execution_mode: process.env.JUDGE_EXECUTION_MODE || 'docker',
      isolation_limits: this.dockerRunner.getIsolationLimitsSummary(),
      timestamp: new Date().toISOString(),
    };
  }
}
