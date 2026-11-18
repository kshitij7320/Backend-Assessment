import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import {
  createAuthenticationError,
  createAuthorizationError,
} from '../common/errors/domain-errors';
import { assertUuid } from '../common/validation/validator';

export type OrgRole = 'organizer' | 'participant';

export interface AuthenticatedActor {
  userId: string;
  email: string;
  displayName: string;
  memberships: Record<string, OrgRole>;
}

@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService) {}

  public async authenticateRequest(headers: Record<string, any>): Promise<AuthenticatedActor> {
    const authHeader = headers['authorization'] || headers['Authorization'];
    const actorTokenHeader = headers['x-actor-token'];
    let token: string | undefined;

    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice('Bearer '.length).trim();
    } else if (typeof actorTokenHeader === 'string' && actorTokenHeader.trim().length > 0) {
      token = actorTokenHeader.trim();
    }

    // Support explicit trusted dev fixture headers: X-Actor-Id + X-Actor-Org-Id + X-Actor-Role
    const devUserId = headers['x-actor-id'];
    const devOrgId = headers['x-actor-org-id'];
    const devRole = headers['x-actor-role'];

    if (!token && devUserId && devOrgId && devRole) {
      token = `dev:${devUserId}:${devOrgId}:${devRole}`;
    }

    if (!token) {
      throw createAuthenticationError(
        'MISSING_CREDENTIALS',
        'Authentication required via Authorization: Bearer <token> or X-Actor-Token header',
      );
    }

    // Check if token is a structured trusted dev fixture: dev:<userId>:<orgId>:<role>
    if (token.startsWith('dev:')) {
      return this.resolveDevFixtureToken(token);
    }

    const userRes = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
    }>(
      `SELECT id, email, display_name FROM users WHERE auth_token = $1 LIMIT 1`,
      [token],
    );

    if (userRes.rowCount === 0) {
      throw createAuthenticationError(
        'INVALID_TOKEN',
        'Provided authentication token is not recognized',
      );
    }

    const user = userRes.rows[0];
    const membershipsRes = await this.db.query<{
      organization_id: string;
      role: OrgRole;
    }>(
      `SELECT organization_id, role FROM organization_memberships WHERE user_id = $1`,
      [user.id],
    );

    const memberships: Record<string, OrgRole> = {};
    for (const row of membershipsRes.rows) {
      memberships[row.organization_id] = row.role;
    }

    return {
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      memberships,
    };
  }

  private async resolveDevFixtureToken(token: string): Promise<AuthenticatedActor> {
    const parts = token.split(':');
    if (parts.length !== 4) {
      throw createAuthenticationError(
        'INVALID_DEV_FIXTURE',
        'Dev fixture token must follow format dev:<userUuid>:<orgUuid>:<organizer|participant>',
      );
    }
    const [, userId, orgId, roleStr] = parts;
    assertUuid(userId, 'devFixture.userId');
    assertUuid(orgId, 'devFixture.orgId');
    if (roleStr !== 'organizer' && roleStr !== 'participant') {
      throw createAuthenticationError(
        'INVALID_DEV_FIXTURE_ROLE',
        'Dev fixture role must be organizer or participant',
      );
    }

    // Ensure unseen organization and user identity exist deterministically
    await this.db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [orgId, `org-${orgId.slice(0, 8)}`, `Organization ${orgId.slice(0, 8)}`],
      );

      await client.query(
        `INSERT INTO users (id, email, display_name, auth_token)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [
          userId,
          `user-${userId.slice(0, 8)}@shodh.dev`,
          `User ${userId.slice(0, 8)}`,
          token,
        ],
      );

      await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [orgId, userId, roleStr],
      );
    });

    const membershipsRes = await this.db.query<{
      organization_id: string;
      role: OrgRole;
    }>(
      `SELECT organization_id, role FROM organization_memberships WHERE user_id = $1`,
      [userId],
    );

    const memberships: Record<string, OrgRole> = {};
    for (const row of membershipsRes.rows) {
      memberships[row.organization_id] = row.role;
    }

    return {
      userId,
      email: `user-${userId.slice(0, 8)}@shodh.dev`,
      displayName: `User ${userId.slice(0, 8)}`,
      memberships,
    };
  }

  public assertOrgMembership(
    actor: AuthenticatedActor,
    organizationId: string,
    requiredRole?: OrgRole,
  ): OrgRole {
    assertUuid(organizationId, 'orgId');
    const role = actor.memberships[organizationId];
    if (!role) {
      throw createAuthorizationError(
        'CROSS_ORG_ACCESS_DENIED',
        'Access denied: identity does not belong to target organization',
        { organizationId, actorId: actor.userId },
      );
    }

    if (requiredRole === 'organizer' && role !== 'organizer') {
      throw createAuthorizationError(
        'INSUFFICIENT_ROLE',
        'Access denied: organizer role is required for this operation',
        { organizationId, requiredRole: 'organizer', actualRole: role },
      );
    }

    return role;
  }
}
