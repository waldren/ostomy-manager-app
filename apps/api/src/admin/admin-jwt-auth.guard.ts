/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';
import { ADMIN_JWKS_RESOLVER } from './admin-jwks-resolver.token';

/**
 * Admin-console OIDC authentication guard.
 *
 * INTENTIONAL DUPLICATION: this is a deliberate, near-verbatim copy of
 * `JwtAuthGuard` (../auth/jwt-auth.guard.ts), bound to `config.adminOidc`
 * instead of `config.oidc`. Do not extract a shared base class, a shared
 * verification function, or a role check on one guard that takes a
 * "patient vs admin" flag. SRS_v2 §4.6 and ADR-0008 require the admin
 * console's zero-PHI boundary to be enforced at the identity layer — a
 * separate identity-provider user pool with a disjoint issuer and audience —
 * precisely so that a bug in shared authorization code cannot let a patient
 * token reach an admin endpoint or vice versa. Unifying this class with the
 * patient guard would turn that identity-layer property back into an
 * ordinary (and therefore eventually buggy) authorization check. If you find
 * yourself wanting to unify these, stop and re-read ADR-0008 first.
 *
 * Provider-agnostic by construction, same as the patient guard: no
 * vendor-specific SDK import, no vendor-specific claim shape — only the
 * standard OIDC/JWKS surface, taken from `AppConfig`, verified with `jose`.
 */
@Injectable()
export class AdminJwtAuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ADMIN_JWKS_RESOLVER) private readonly getKey: JWTVerifyGetKey,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException({ code: ADMIN_AUTH_ERROR_CODE.MISSING_TOKEN });
    }

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, this.getKey, {
        issuer: this.config.adminOidc.issuer,
        audience: this.config.adminOidc.audience,
        algorithms: ['RS256'],
      });
      payload = verified.payload;
    } catch (error) {
      throw new UnauthorizedException({ code: mapVerificationError(error) });
    }

    const subjectClaim = this.config.adminOidc.claimMapping.subjectClaim;
    const subject = payload[subjectClaim];
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new UnauthorizedException({ code: ADMIN_AUTH_ERROR_CODE.MISSING_SUBJECT_CLAIM });
    }

    request.admin = { id: subject, claims: payload };
    return true;
  }
}

interface AdminRequest extends Request {
  admin?: { id: string; claims: Record<string, unknown> };
}

/** Field identifiers and rule codes only — never the token or claim values (docs/security-hipaa.md "Never log PHI"). */
export const ADMIN_AUTH_ERROR_CODE = {
  MISSING_TOKEN: 'ADMIN_AUTH_MISSING_TOKEN',
  MALFORMED_TOKEN: 'ADMIN_AUTH_MALFORMED_TOKEN',
  INVALID_SIGNATURE: 'ADMIN_AUTH_INVALID_SIGNATURE',
  INVALID_ISSUER: 'ADMIN_AUTH_INVALID_ISSUER',
  INVALID_AUDIENCE: 'ADMIN_AUTH_INVALID_AUDIENCE',
  TOKEN_EXPIRED: 'ADMIN_AUTH_TOKEN_EXPIRED',
  MISSING_SUBJECT_CLAIM: 'ADMIN_AUTH_MISSING_SUBJECT_CLAIM',
  VERIFICATION_FAILED: 'ADMIN_AUTH_VERIFICATION_FAILED',
} as const;

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;
  return value;
}

function mapVerificationError(error: unknown): string {
  const code = getJoseErrorCode(error);
  const claim = getJoseFailedClaim(error);

  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'aud') {
    return ADMIN_AUTH_ERROR_CODE.INVALID_AUDIENCE;
  }
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'iss') {
    return ADMIN_AUTH_ERROR_CODE.INVALID_ISSUER;
  }
  if (code === 'ERR_JWT_EXPIRED') {
    return ADMIN_AUTH_ERROR_CODE.TOKEN_EXPIRED;
  }
  if (
    code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
    code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'
  ) {
    return ADMIN_AUTH_ERROR_CODE.INVALID_SIGNATURE;
  }
  if (
    code === 'ERR_JWS_INVALID' ||
    code === 'ERR_JWT_INVALID' ||
    code === 'ERR_JWKS_NO_MATCHING_KEY'
  ) {
    return ADMIN_AUTH_ERROR_CODE.MALFORMED_TOKEN;
  }
  return ADMIN_AUTH_ERROR_CODE.VERIFICATION_FAILED;
}

function getJoseErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function getJoseFailedClaim(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'claim' in error) {
    const claim = (error as { claim?: unknown }).claim;
    return typeof claim === 'string' ? claim : undefined;
  }
  return undefined;
}
