import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContestsService } from './contests.service';
import { RequireOrgRole } from '../auth/auth.guard';

@ApiTags('Contests')
@Controller('api/v1/orgs/:orgId/contests')
export class ContestsController {
  constructor(
    @Inject(ContestsService) private readonly contestsService: ContestsService,
  ) {}

  @Post()
  @RequireOrgRole('organizer')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a contest in an organization (organizer only)' })
  async createContest(
    @Param('orgId') orgId: string,
    @Body() body: Record<string, any>,
    @Req() req: any,
  ) {
    return this.contestsService.createContest(orgId, req.actor, body || {});
  }

  @Patch(':contestId')
  @RequireOrgRole('organizer')
  @ApiOperation({ summary: 'Update contest window or status override (organizer only)' })
  async updateContest(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.contestsService.updateContest(orgId, contestId, body || {});
  }

  @Get()
  @ApiOperation({ summary: 'List contests in an organization with pagination and stable ordering' })
  async listContests(
    @Param('orgId') orgId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.contestsService.listContests(orgId, query || {});
  }

  @Get(':contestId')
  @ApiOperation({ summary: 'Get contest details and deterministic open/closed state' })
  async getContest(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
  ) {
    return this.contestsService.getContest(orgId, contestId);
  }

  @Post(':contestId/join')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join a contest as a participant' })
  async joinContest(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Req() req: any,
  ) {
    return this.contestsService.joinContest(orgId, contestId, req.actor);
  }
}
