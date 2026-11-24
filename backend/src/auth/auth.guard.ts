import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { appConfig } from '../config/app.config';
import { verifySessionToken } from '../common/crypto.util';
import { CasService } from './cas.service';
import type { UserRow } from '../database/database.service';

export interface AuthenticatedRequest extends Request {
  user?: UserRow;
  authProvider?: string;
}

function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[appConfig.sessionCookieName];
  if (cookieToken && typeof cookieToken === 'string') {
    return cookieToken;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly casService: CasService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractToken(req);
    if (!token) {
      throw new UnauthorizedException('请先通过大外 CAS 统一身份认证登录');
    }

    const payload = verifySessionToken(token);
    if (!payload) {
      throw new UnauthorizedException('登录会话已过期，请重新登录');
    }

    const user = this.casService.findUserById(payload.uid);
    if (!user) {
      throw new UnauthorizedException('用户会话失效，请重新登录');
    }

    req.user = user;
    req.authProvider = payload.authProvider;
    return true;
  }
}

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly casService: CasService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractToken(req);
    if (token) {
      const payload = verifySessionToken(token);
      if (payload) {
        const user = this.casService.findUserById(payload.uid);
        if (user) {
          req.user = user;
          req.authProvider = payload.authProvider;
        }
      }
    }
    return true;
  }
}
