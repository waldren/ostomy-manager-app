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

import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';
import { READINESS_FETCH, ReadinessService } from './readiness.service';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [ReadinessService, { provide: READINESS_FETCH, useValue: fetch }],
})
export class HealthModule {}
