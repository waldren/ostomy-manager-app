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

import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Parses a request body with a zod schema and refuses it in this API's own
 * error vocabulary.
 *
 * ## Why not `ValidationPipe`
 *
 * The same two reasons `observation-body.pipe.ts` gives at length, which are
 * worth not re-deriving. Nest's `ValidationPipe` emits
 * `{"statusCode":400,"message":[...],"error":"Bad Request"}` — a different
 * envelope from the `{ error: { code, fields } }` every other refusal on this
 * API uses, so a client would need two parsers. And it needs `class-validator`
 * and `class-transformer`, a second rule language beside the zod schemas that
 * already define these shapes and already generate the OpenAPI document.
 *
 * ## Fields and rule codes, never the value
 *
 * CLAUDE.md's standing rule: "Validation errors return field identifiers and
 * rule codes, **never the offending clinical value**." An onboarding body
 * carries an ostomy type and a surgery date, both of which are clinical, so
 * this pipe reports `issue.code` and the field path and nothing else.
 *
 * An unrecognised key reports the key name rather than the value — the key is
 * part of the request's shape, not its content, and a client that sent
 * `ostomyTypo` cannot fix it without being told which key was wrong. That is
 * narrower than `observation-body.pipe.ts`, which reports only `payload`,
 * because that pipe answers on the sync wire where `docs/sync-contract.md` §6.2
 * requires the rejection to carry nothing client-supplied at all. This body is
 * not persisted into a rejection a device keeps.
 *
 * ## Deliberately generic
 *
 * It takes the schema rather than importing one, because the next patient-side
 * surface that needs a plain zod body (P4.S3's preferences) should reuse this
 * rather than copy it. `observation-body.pipe.ts` stays separate: its job is
 * the sync contract's reason-code ordering, which is a different contract.
 */
@Injectable()
export class ZodBodyPipe<TSchema extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.infer<TSchema> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      error: {
        code: 'INVALID_ONBOARDING',
        fields: result.error.issues.map((issue) => ({
          field:
            issue.code === 'unrecognized_keys'
              ? issue.keys.join(',')
              : // `(body)` rather than an empty string for a root-level issue —
                // a blank field name in a rejection reads as a missing value
                // rather than as "the body itself".
                issue.path.join('.') || '(body)',
          rule: issue.code,
        })),
      },
    });
  }
}
