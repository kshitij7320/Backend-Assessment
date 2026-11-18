import {
  Body,
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
import { OrganizationsService } from './organizations.service';
import { Public, RequireOrgRole } from '../auth/auth.guard';

@ApiTags('Organizations')
@Controller('api/v1/orgs')
export class OrganizationsController {
  constructor(
    @Inject(OrganizationsService)
    private readonly orgsService: OrganizationsService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or register an organization' })
  async createOrganization(@Body() body: Record<string, any>) {
    return this.orgsService.createOrganization(body || {});
  }

  @Get(':orgId')
  @ApiOperation({ summary: 'Get organization details (requires org membership)' })
  async getOrganization(@Param('orgId') orgId: string) {
    return this.orgsService.getOrganization(orgId);
  }

  @Post(':orgId/members')
  @RequireOrgRole('organizer')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add or update a member in an organization (organizer only)' })
  async addMember(
    @Param('orgId') orgId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.orgsService.addMember(orgId, body || {});
  }

  @Get(':orgId/members')
  @ApiOperation({ summary: 'List members in an organization with pagination' })
  async listMembers(
    @Param('orgId') orgId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.orgsService.listMembers(orgId, query || {});
  }
}
