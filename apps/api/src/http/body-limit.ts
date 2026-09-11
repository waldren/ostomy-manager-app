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

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The JSON request-body limit.
 *
 * **This is coupled to `SYNC_PUSH_MAX_OPERATIONS` and the coupling is not
 * obvious, which is why it is written down.** `docs/sync-contract.md` §3.3
 * sets the batch bound at 500 operations by default. One push operation
 * serialises to roughly 460 bytes, so a full batch is about 226 KB — well
 * over Express's 100 KB default.
 *
 * Left at the default, the configured bound is a lie: a client that batched
 * to exactly the documented 500 would be refused at around 215 by the body
 * parser instead, with `BATCH_TOO_LARGE` never reached and §6.1's `413`
 * never returned. The batch limit would be enforced by a number nobody chose.
 *
 * 1 MB leaves roughly 4x headroom, so the operation count stays the binding
 * constraint even if a payload grows a field or two. If
 * `SYNC_PUSH_MAX_OPERATIONS` is ever raised substantially, raise this with
 * it — `sync.integration.spec.ts` pushes a maximum-size batch specifically
 * so the two cannot silently diverge.
 */
export const JSON_BODY_LIMIT = '1mb';

/**
 * Applies the limit above.
 *
 * Exported and called from **both** `main.ts` and the integration harness,
 * rather than written out in each. A body-parser limit configured only in
 * `main.ts` is absent from every `Test.createTestingModule()` graph, so the
 * suite would exercise a 100 KB cap while production ran with 1 MB — and the
 * batch-size test would pass for the wrong reason, or fail for one. This
 * repo already has that trap once (`CapturingLoggingModule` duplicates the
 * production pino config), and once is enough.
 */
export function applyJsonBodyLimit(app: INestApplication): void {
  (app as NestExpressApplication).useBodyParser('json', { limit: JSON_BODY_LIMIT });
}
