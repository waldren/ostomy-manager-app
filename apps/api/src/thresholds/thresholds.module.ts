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
import { ThresholdsController } from './thresholds.controller';
import { ThresholdsService } from './thresholds.service';
import { ValueSetsController } from './value-sets.controller';

/**
 * `PatientAuthModule` is imported because `ThresholdsController` is guarded
 * by `JwtAuthGuard`, which resolves its dependencies from that module —
 * a controller with a guard whose providers are not in scope fails at
 * `app.init()`, not at compile time.
 */
@Module({
  imports: [PatientAuthModule, PrismaModule],
  controllers: [ThresholdsController, ValueSetsController],
  providers: [ThresholdsService],
  exports: [ThresholdsService],
})
export class ThresholdsModule {}
