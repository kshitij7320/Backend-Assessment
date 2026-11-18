import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, OrgRole } from './auth.service';
import { requestContextStorage } from '../common/logger/structured-logger.service';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const REQUIRED_ROLE_KEY = 'requiredOrgRole';
export const RequireOrgRole = (role: OrgRole) =>
  SetMetadata(REQUIRED_ROLE_KEY, role);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const actor = await this.authService.authenticateRequest(request.headers || {});
    request.actor = actor;

    const store = requestContextStorage.getStore();
    if (store) {
      store.actor_id = actor.userId;
      if (request.params?.orgId) {
        store.organization_id = request.params.orgId;
      }
    }

    const requiredRole = this.reflector.getAllAndOverride<OrgRole | undefined>(
      REQUIRED_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (request.params?.orgId) {
      const role = this.authService.assertOrgMembership(
        actor,
        request.params.orgId,
        requiredRole,
      );
      request.orgRole = role;
    }

    return true;
  }
}
