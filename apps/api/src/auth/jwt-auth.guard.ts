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
import { PATIENT_JWKS_RESOLVER } from './patient-jwks-resolver.token';

/**
 * Patient-facing OIDC authentication guard.
 *
 * INTENTIONAL DUPLICATION: `AdminJwtAuthGuard` (../admin/admin-jwt-auth.guard.ts)
 * implements the same verification shape against a completely separate
 * issuer, audience, and JWKS source. This is not an oversight to be
 * "refactored" into one parameterised guard, a shared base class, or a role
 * check on a common guard. SRS_v2 §4.6 and ADR-0008 put the patient/admin
 * boundary at the identity layer specifically so that a bug in shared
 * authorization code cannot defeat it — sharing this class would put the
 * boundary back in ordinary application logic. If you find yourself wanting
 * to unify these, stop and re-read ADR-0008 first.
 *
 * Provider-agnostic by construction: this file has no knowledge of any
 * specific identity provider by name. It knows only the standard OIDC/JWKS
 * shape (issuer, audience, JWKS endpoint), taken from `AppConfig`, and
 * verifies with `jose` — a generic JWT library, never a vendor SDK. The mock
 * OIDC provider in development and the production identity provider both
 * expose the same standard surface, so nothing here changes between them.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  /**
   * `getKey` is injected (rather than constructed inline from `config.oidc.jwksUri`
   * every time) so a test can substitute a `jose.createLocalJWKSet` backed by an
   * in-memory keypair and never touch the network. Production wiring
   * (`patient-auth.module.ts`) supplies `jose.createRemoteJWKSet`, which does its
   * own bounded-frequency refetching — "sane refresh" without this guard needing
   * to implement caching itself.
   */
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PATIENT_JWKS_RESOLVER) private readonly getKey: JWTVerifyGetKey,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PatientRequest>();
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException({ code: AUTH_ERROR_CODE.MISSING_TOKEN });
    }

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, this.getKey, {
        issuer: this.config.oidc.issuer,
        audience: this.config.oidc.audience,
        algorithms: ['RS256'],
      });
      payload = verified.payload;
    } catch (error) {
      throw new UnauthorizedException({ code: mapVerificationError(error) });
    }

    const subjectClaim = this.config.oidc.claimMapping.subjectClaim;
    const subject = payload[subjectClaim];
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new UnauthorizedException({ code: AUTH_ERROR_CODE.MISSING_SUBJECT_CLAIM });
    }

    request.patient = { id: subject, claims: payload };
    return true;
  }
}

interface PatientRequest extends Request {
  patient?: { id: string; claims: Record<string, unknown> };
}

/** Field identifiers and rule codes only — never the token or claim values (docs/security-hipaa.md "Never log PHI"). */
export const AUTH_ERROR_CODE = {
  MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
  MALFORMED_TOKEN: 'AUTH_MALFORMED_TOKEN',
  INVALID_SIGNATURE: 'AUTH_INVALID_SIGNATURE',
  INVALID_ISSUER: 'AUTH_INVALID_ISSUER',
  INVALID_AUDIENCE: 'AUTH_INVALID_AUDIENCE',
  TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  MISSING_SUBJECT_CLAIM: 'AUTH_MISSING_SUBJECT_CLAIM',
  VERIFICATION_FAILED: 'AUTH_VERIFICATION_FAILED',
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
    return AUTH_ERROR_CODE.INVALID_AUDIENCE;
  }
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'iss') {
    return AUTH_ERROR_CODE.INVALID_ISSUER;
  }
  if (code === 'ERR_JWT_EXPIRED') {
    return AUTH_ERROR_CODE.TOKEN_EXPIRED;
  }
  if (
    code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
    code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'
  ) {
    return AUTH_ERROR_CODE.INVALID_SIGNATURE;
  }
  if (
    code === 'ERR_JWS_INVALID' ||
    code === 'ERR_JWT_INVALID' ||
    code === 'ERR_JWKS_NO_MATCHING_KEY'
  ) {
    return AUTH_ERROR_CODE.MALFORMED_TOKEN;
  }
  return AUTH_ERROR_CODE.VERIFICATION_FAILED;
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
