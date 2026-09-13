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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { SyncDeltaRequest, SyncDeltaResponse } from './delta.js';
import { toEntityId, toOperationId, toServerSequence } from './identifiers.js';
import { SYNC_PROTOCOL_ERROR_CODE, type SyncProtocolErrorResponse } from './protocolErrors.js';
import { SYNC_REASON_CODE } from './reasonCodes.js';
import type { SyncPushRequest, SyncPushResponse } from './push.js';

/**
 * `docs/sync-contract.md` is normative and these types implement it: "This
 * document and those types must agree; where they disagree, this document
 * is wrong until it is corrected."
 *
 * Agreement is asserted here rather than assumed. Each of the document's
 * own examples is extracted from the Markdown at test time and compared
 * against a literal that `tsc` has already checked against the
 * corresponding type. Two failure modes are covered by one test:
 *
 *   - Editing the document's example without updating the type fails the
 *     `toEqual`.
 *   - Editing the type without updating the document fails the typecheck
 *     of the literal, or the `toEqual`, or both.
 *
 * Neither side can drift silently, which is the property worth having in
 * a contract whose whole premise is that it is frozen once clients ship.
 *
 * **All values below are synthetic.** They are the document's own
 * illustrative figures — no real or realistic patient data appears in this
 * repository's fixtures, ever (docs/testing.md, CLAUDE.md).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = join(HERE, '..', '..', '..', '..', 'docs', 'sync-contract.md');

const contractSource = readFileSync(CONTRACT_PATH, 'utf8');

function fencedJsonBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of markdown.matchAll(/^```json\r?\n([\s\S]*?)^```/gm)) {
    const body = match[1];
    if (body === undefined) continue;
    blocks.push(JSON.parse(body));
  }
  return blocks;
}

const jsonExamples = fencedJsonBlocks(contractSource);

/**
 * The document's normative TABLES, not only its JSON fences.
 *
 * The fences are the shapes; the tables are the vocabularies, and a table
 * is what an implementer actually works from when writing a handler. They
 * were mirrored by hand-typed lists in `reasonCodes.spec.ts` and
 * `protocolErrors.spec.ts`, which means the document and the constants
 * could have drifted in exactly the place a drift is least visible — a
 * code added to one and not the other reads as complete on both sides.
 *
 * Extracts every `CODE_LIKE_THIS` appearing in a backtick-quoted cell of
 * the table under `heading`.
 */
function codesInTableUnder(heading: string): Set<string> {
  const start = contractSource.indexOf(heading);
  if (start === -1) throw new Error(`heading not found in the contract: ${heading}`);

  const afterHeading = contractSource.slice(start + heading.length);
  const nextHeading = afterHeading.search(/^#{2,4} /m);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);

  const codes = new Set<string>();
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    for (const cell of line.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)) {
      const code = cell[1];
      if (code !== undefined) codes.add(code);
    }
  }
  return codes;
}

const [pushRequestExample, pushResponseExample, deltaResponseExample, protocolErrorExample] =
  jsonExamples;

describe('docs/sync-contract.md — the document own examples satisfy packages/core/src/sync', () => {
  it('has exactly the four JSON examples these types cover (§3.1, §3.4, §5.2, §6.1)', () => {
    // A deliberate tripwire, not a fragile assertion: a new example in the
    // document is a new wire shape, and whoever adds one needs to be sent
    // here to give it a type.
    expect(jsonExamples).toHaveLength(4);
  });

  it('§3.1 — the push request example is a SyncPushRequest', () => {
    const expected: SyncPushRequest = {
      operations: [
        {
          operationId: toOperationId('0f9c3b4e-6a2d-4c1b-9f3a-1d2e3f4a5b6c'),
          entityType: 'Observation',
          entityId: toEntityId('7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d'),
          operationType: 'create',
          clientTimestamp: '2026-09-07T22:04:11.412Z',
          payload: {
            resourceType: 'Observation',
            id: toEntityId('7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d'),
            status: 'final',
            code: '79560-9',
            valueQuantity: { value: 350, unit: 'mL' },
            effectiveDateTime: '2026-09-07T14:00:00.000Z',
            method: null,
            enteredMeasurementSystem: 'metric',
            enteredTimezone: 'America/Chicago',
          },
        },
      ],
    };

    expect(pushRequestExample).toEqual(expected);
  });

  it('§3.4 — the push response example is a SyncPushResponse, one result per status', () => {
    const expected: SyncPushResponse = {
      results: [
        {
          operationId: toOperationId('0f9c3b4e-6a2d-4c1b-9f3a-1d2e3f4a5b6c'),
          status: 'accepted',
          entityId: toEntityId('7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d'),
          appliedServerSequence: toServerSequence('48213'),
          replayed: false,
        },
        {
          operationId: toOperationId('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e'),
          status: 'rejected',
          entityId: toEntityId('8b2f3c4d-5e6f-4a7b-8c9d-1e2f3a4b5c6d'),
          reasonCode: 'VALUE_NOT_POSITIVE',
          field: 'valueQuantity.value',
          replayed: false,
        },
        {
          operationId: toOperationId('2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'),
          status: 'superseded',
          entityId: toEntityId('9c3f4d5e-6f7a-4b8c-9d0e-2f3a4b5c6d7e'),
          appliedServerSequence: toServerSequence('48198'),
          replayed: false,
        },
      ],
    };

    expect(pushResponseExample).toEqual(expected);
  });

  it('§5.2 — the delta response example is a SyncDeltaResponse, with a payload-free tombstone', () => {
    const expected: SyncDeltaResponse = {
      changes: [
        {
          entityType: 'Observation',
          entityId: toEntityId('7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d'),
          serverSequence: toServerSequence('48213'),
          deleted: false,
          clientUpdatedAt: '2026-09-07T22:04:11.412Z',
          payload: {
            resourceType: 'Observation',
            id: toEntityId('7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d'),
            status: 'final',
            code: '79560-9',
            valueQuantity: { value: 350, unit: 'mL' },
            effectiveDateTime: '2026-09-07T14:00:00.000Z',
            method: null,
            enteredMeasurementSystem: 'metric',
            enteredTimezone: 'America/Chicago',
          },
        },
        {
          entityType: 'Observation',
          entityId: toEntityId('8b2f3c4d-5e6f-4a7b-8c9d-1e2f3a4b5c6d'),
          serverSequence: toServerSequence('48214'),
          deleted: true,
          clientUpdatedAt: '2026-09-07T22:09:03.001Z',
        },
      ],
      cursor: toServerSequence('48214'),
      hasMore: false,
    };

    expect(deltaResponseExample).toEqual(expected);
  });

  it('§5.1 — the delta request example parses into a SyncDeltaRequest', () => {
    const match = contractSource.match(/^GET (\/api\/v1\/sync\/delta\?\S+)$/m);
    expect(match?.[1]).toBeDefined();

    const url = new URL(match?.[1] ?? '', 'http://sync.invalid');
    const since = url.searchParams.get('since');
    const limit = url.searchParams.get('limit');

    expect(since).not.toBeNull();
    expect(limit).not.toBeNull();

    const request: SyncDeltaRequest = {
      since: toServerSequence(since ?? ''),
      limit: Number(limit),
    };

    // `since` is the exclusive server-sequence cursor and stays a string
    // all the way through (§7.3). `limit` is an ordinary page size whose
    // default and maximum are server configuration, not values named here.
    expect(request.since).toBe(since);
    expect([...url.searchParams.keys()]).toEqual(['since', 'limit']);
  });

  it('§5.1 — `since: "0"` is a legal initial-sync cursor', () => {
    const initial: SyncDeltaRequest = { since: toServerSequence('0') };
    expect(initial.since).toBe('0');
  });

  it('§6.1 — the code table and SYNC_PROTOCOL_ERROR_CODE name the same set', () => {
    const documented = codesInTableUnder('### 6.1 Protocol errors');
    // SYNC_PUSH_MAX_OPERATIONS is named in that table as the bound whose
    // breach raises BATCH_TOO_LARGE; it is configuration, not a code.
    documented.delete('SYNC_PUSH_MAX_OPERATIONS');

    expect([...documented].sort()).toEqual(Object.values(SYNC_PROTOCOL_ERROR_CODE).sort());
  });

  it('§6.2 — the reason-code table and SYNC_REASON_CODE name the same set', () => {
    const documented = codesInTableUnder('### 6.2 Data errors');
    // The Tier 1 row names TIER1_RULE_CODE as the source of its codes
    // rather than being a code itself.
    documented.delete('TIER1_RULE_CODE');

    expect([...documented].sort()).toEqual(Object.values(SYNC_REASON_CODE).sort());
  });

  it('§6.1 — the protocol-error body is a SyncProtocolErrorResponse and carries nothing else', () => {
    const expected: SyncProtocolErrorResponse = { error: { code: 'BATCH_OUT_OF_ORDER' } };

    expect(protocolErrorExample).toEqual(expected);

    // The assertion that matters is not the code but the closure: §6.1
    // forbids prose, a field path, echoed request content, or an index
    // into the offending operation, and the request a protocol error
    // would quote is a batch of clinical values.
    expect(Object.keys(expected.error)).toEqual(['code']);
    expect(Object.keys(expected)).toEqual(['error']);
  });
});
