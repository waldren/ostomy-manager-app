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

import { Module } from '@nestjs/common';

import { PatientAuthModule } from '../auth/patient-auth.module';
import { PrismaModule } from '../prisma/prisma.module';

import { RangesController } from './ranges.controller';
import { RangesService } from './ranges.service';

/**
 * Target ranges and suggestions (P4.S2, SRS §3.9).
 *
 * `RangesService` is exported because anomaly highlighting (P5.S2) resolves the
 * same precedence to decide what to flag, and a second implementation of
 * "which range is in force" is how a threshold and the number shown beside it
 * come to disagree.
 */
@Module({
  // `PatientAuthModule` supplies the JWKS resolver `JwtAuthGuard` injects.
  // Without it the module graph fails to compile — loudly, rather than this
  // route quietly going unguarded.
  imports: [PatientAuthModule, PrismaModule],
  controllers: [RangesController],
  providers: [RangesService],
  exports: [RangesService],
})
export class RangesModule {}
