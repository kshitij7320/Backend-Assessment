import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StandingsService } from './standings.service';
import { RequireOrgRole } from '../auth/auth.guard';

@ApiTags('Leaderboard & Standings')
@Controller('api/v1/orgs/:orgId/contests/:contestId/leaderboard')
export class StandingsController {
  constructor(
    @Inject(StandingsService)
    private readonly standingsService: StandingsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Query deterministic contest leaderboard with pagination and tie-breaking',
  })
  async getLeaderboard(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.standingsService.getLeaderboard(orgId, contestId, query || {});
  }

  @Post('rebuild')
  @RequireOrgRole('organizer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rebuild contest standings from authoritative stored submissions and verify parity with serving path (organizer only)',
  })
  async rebuildLeaderboard(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
  ) {
    return this.standingsService.rebuildStandings(orgId, contestId);
  }
}
