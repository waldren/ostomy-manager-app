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

import { PrismaService } from './prisma.service';

/**
 * Not `@Global()` and not imported by `AppModule` in this sprint (P1.S3) —
 * see `AppModule`'s own comment. The first module that actually needs a
 * database connection (P1.S5's audit/threshold module, or P2.S1a's
 * observations module) imports this explicitly and re-exports it or
 * imports it itself; deciding whether it should become global at that
 * point is that sprint's call, not this one's.
 */
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
