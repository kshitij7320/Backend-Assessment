import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import {
  createAuthorizationError,
  createBusinessRuleError,
  createNotFoundError,
} from '../common/errors/domain-errors';
import {
  assertEnum,
  assertNonEmptyString,
  assertUuid,
  parsePagination,
} from '../common/validation/validator';
import { OrgRole } from '../auth/auth.service';

@Injectable()
export class OrganizationsService {
  constructor(private readonly db: DatabaseService) {}

  public async createOrganization(body: Record<string, any>) {
    const id = body.id ? assertUuid(body.id, 'id') : randomUUID();
    const name = assertNonEmptyString(body.name, 'name', 200);
    const slug = body.slug
      ? assertNonEmptyString(body.slug, 'slug', 100).toLowerCase()
      : `org-${id.slice(0, 8)}`;

    return this.db.withTransaction(async (client) => {
      const existingSlug = await client.query(
        `SELECT id FROM organizations WHERE slug = $1 AND id <> $2`,
        [slug, id],
      );
      if ((existingSlug.rowCount ?? 0) > 0) {
        throw createBusinessRuleError(
          'ORG_SLUG_CONFLICT',
          `Organization slug '${slug}' is already in use`,
        );
      }

      const orgRes = await client.query(
        `INSERT INTO organizations (id, slug, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, slug, name, created_at`,
        [id, slug, name],
      );

      return orgRes.rows[0];
    });
  }

  public async getOrganization(orgId: string) {
    assertUuid(orgId, 'orgId');
    const res = await this.db.query(
      `SELECT id, slug, name, created_at FROM organizations WHERE id = $1`,
      [orgId],
    );
    if (res.rowCount === 0) {
      throw createNotFoundError('ORG_NOT_FOUND', 'Organization not found');
    }
    return res.rows[0];
  }

  public async addMember(orgId: string, body: Record<string, any>) {
    assertUuid(orgId, 'orgId');
    const userId = body.userId ? assertUuid(body.userId, 'userId') : randomUUID();
    const email = body.email
      ? assertNonEmptyString(body.email, 'email', 255).toLowerCase()
      : `user-${userId.slice(0, 8)}@shodh.dev`;
    const displayName = body.displayName
      ? assertNonEmptyString(body.displayName, 'displayName', 200)
      : `User ${userId.slice(0, 8)}`;
    const role = assertEnum<OrgRole>(body.role, 'role', [
      'organizer',
      'participant',
    ]);
    const authToken = body.authToken
      ? assertNonEmptyString(body.authToken, 'authToken', 255)
      : `tok-${userId}`;

    return this.db.withTransaction(async (client) => {
      const orgCheck = await client.query(
        `SELECT id FROM organizations WHERE id = $1`,
        [orgId],
      );
      if (orgCheck.rowCount === 0) {
        throw createNotFoundError('ORG_NOT_FOUND', 'Organization not found');
      }

      await client.query(
        `INSERT INTO users (id, email, display_name, auth_token)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET display_name = EXCLUDED.display_name`,
        [userId, email, displayName, authToken],
      );

      await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [orgId, userId, role],
      );

      const userRow = await client.query(
        `SELECT u.id AS user_id, u.email, u.display_name, u.auth_token, om.organization_id, om.role, om.created_at
         FROM users u
         JOIN organization_memberships om ON om.user_id = u.id
         WHERE u.id = $1 AND om.organization_id = $2`,
        [userId, orgId],
      );

      return userRow.rows[0];
    });
  }

  public async listMembers(orgId: string, query: Record<string, unknown>) {
    assertUuid(orgId, 'orgId');
    const { limit, offset } = parsePagination(query);

    const [itemsRes, countRes] = await Promise.all([
      this.db.query(
        `SELECT u.id AS user_id, u.email, u.display_name, om.role, om.created_at
         FROM organization_memberships om
         JOIN users u ON u.id = om.user_id
         WHERE om.organization_id = $1
         ORDER BY om.created_at ASC, u.id ASC
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset],
      ),
      this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM organization_memberships
         WHERE organization_id = $1`,
        [orgId],
      ),
    ]);

    return {
      items: itemsRes.rows,
      pagination: {
        limit,
        offset,
        total: Number(countRes.rows[0]?.total || 0),
      },
    };
  }

  public async assertObjectBelongsToOrg(
    table: 'contests' | 'problems' | 'submissions' | 'judging_attempts',
    objectId: string,
    expectedOrgId: string,
    fieldLabel: string,
  ): Promise<void> {
    assertUuid(objectId, fieldLabel);
    assertUuid(expectedOrgId, 'orgId');

    const res = await this.db.query<{ organization_id: string }>(
      `SELECT organization_id FROM ${table} WHERE id = $1 LIMIT 1`,
      [objectId],
    );

    if (res.rowCount === 0) {
      throw createNotFoundError(
        `${table.toUpperCase()}_NOT_FOUND`,
        `${fieldLabel} '${objectId}' was not found`,
      );
    }

    if (res.rows[0].organization_id !== expectedOrgId) {
      throw createAuthorizationError(
        'CROSS_ORG_ACCESS_DENIED',
        `Access denied: ${fieldLabel} belongs to a different organization`,
        { field: fieldLabel, objectId, expectedOrgId },
      );
    }
  }
}
