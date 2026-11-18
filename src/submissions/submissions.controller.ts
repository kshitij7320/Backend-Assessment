import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SubmissionsService } from './submissions.service';
import { RequireOrgRole } from '../auth/auth.guard';

@ApiTags('Submissions & Rejudging')
@Controller('api/v1/orgs/:orgId/contests/:contestId/submissions')
export class SubmissionsController {
  constructor(
    @Inject(SubmissionsService)
    private readonly submissionsService: SubmissionsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Submit a solution for asynchronous judging (supports Idempotency-Key header)',
  })
  async createSubmission(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Body() body: Record<string, any>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: any,
  ) {
    return this.submissionsService.createSubmission(
      orgId,
      contestId,
      req.actor,
      body || {},
      idempotencyKey,
    );
  }

  @Get()
  @ApiOperation({
    summary:
      'List submissions in a contest with pagination and stable ordering',
  })
  async listSubmissions(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: any,
  ) {
    return this.submissionsService.listSubmissions(
      orgId,
      contestId,
      req.actor,
      req.orgRole,
      query || {},
    );
  }

  @Get(':submissionId')
  @ApiOperation({
    summary:
      'Inspect submission status, verdict, and attempts (redacts hidden test cases and other users private code for participants)',
  })
  async getSubmission(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Param('submissionId') submissionId: string,
    @Req() req: any,
  ) {
    return this.submissionsService.getSubmission(
      orgId,
      contestId,
      submissionId,
      req.actor,
      req.orgRole,
    );
  }

  @Post(':submissionId/rejudge')
  @RequireOrgRole('organizer')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Rejudge a submission against an explicitly selected problemVersionId and testSuiteVersionId (organizer only)',
  })
  async rejudgeSubmission(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Param('submissionId') submissionId: string,
    @Body() body: Record<string, any>,
    @Req() req: any,
  ) {
    return this.submissionsService.rejudgeSubmission(
      orgId,
      contestId,
      submissionId,
      req.actor,
      body || {},
    );
  }
}
