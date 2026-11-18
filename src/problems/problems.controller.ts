import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProblemsService } from './problems.service';
import { RequireOrgRole } from '../auth/auth.guard';

@ApiTags('Problems')
@Controller('api/v1/orgs/:orgId/contests/:contestId/problems')
export class ProblemsController {
  constructor(private readonly problemsService: ProblemsService) {}

  @Post()
  @RequireOrgRole('organizer')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a problem with initial version and test suite (organizer only)',
  })
  async createProblem(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Body() body: Record<string, any>,
    @Req() req: any,
  ) {
    return this.problemsService.createProblem(
      orgId,
      contestId,
      req.actor,
      body || {},
    );
  }

  @Post(':problemId/versions')
  @RequireOrgRole('organizer')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Publish a new immutable problem version and/or test-suite version without mutating historical verdicts (organizer only)',
  })
  async createProblemVersion(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Param('problemId') problemId: string,
    @Body() body: Record<string, any>,
    @Req() req: any,
  ) {
    return this.problemsService.createProblemVersion(
      orgId,
      contestId,
      problemId,
      req.actor,
      body || {},
    );
  }

  @Get()
  @ApiOperation({ summary: 'List problems in a contest with pagination and stable ordering' })
  async listProblems(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.problemsService.listProblems(orgId, contestId, query || {});
  }

  @Get(':problemId')
  @ApiOperation({
    summary:
      'Get problem details (hides hidden test case inputs/outputs from participants)',
  })
  async getProblem(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Param('problemId') problemId: string,
    @Req() req: any,
  ) {
    return this.problemsService.getProblem(
      orgId,
      contestId,
      problemId,
      req.orgRole,
    );
  }
}
