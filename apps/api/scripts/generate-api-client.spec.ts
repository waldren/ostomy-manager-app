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

/**
 * Tests for the API client generator's schema-to-TypeScript rendering.
 *
 * The generator shipped with no tests, which is the pattern CLAUDE.md
 * already calls out: "two of the three shipped broken the first time
 * precisely because they had none." Its failure mode is also the quiet kind
 * — bad output still compiles, so `pnpm verify` stays green while every
 * consumer of a mis-rendered field loses type safety.
 *
 * `renderType` is the part with real branching, so it is the part under
 * test. Whole-file emission is covered by `verify:api-client`, which
 * regenerates and diffs on every `pnpm verify`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

// The generator is a plain CommonJS script, not compiled TypeScript source;
// see its own header for why. `require` is how it is loaded.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderType, collectOperations, namedTypes } = require('./generate-api-client.cjs') as {
  renderType: (schema: unknown, depth?: number) => string;
  collectOperations: (document: unknown) => Array<{ route: string }>;
  namedTypes: Map<string, unknown>;
};

beforeEach(() => {
  // `renderType` registers titled schemas into module-level state.
  namedTypes.clear();
});

describe('primitives and containers', () => {
  it.each([
    ['string', { type: 'string' }, 'string'],
    ['number', { type: 'number' }, 'number'],
    ['integer', { type: 'integer' }, 'number'],
    ['boolean', { type: 'boolean' }, 'boolean'],
    ['an enum', { type: 'string', enum: ['a', 'b'] }, '"a" | "b"'],
    ['an array', { type: 'array', items: { type: 'string' } }, 'ReadonlyArray<string>'],
  ])('renders %s', (_label, schema, expected) => {
    expect(renderType(schema)).toBe(expected);
  });

  it('appends null for a nullable schema', () => {
    expect(renderType({ type: 'string', nullable: true })).toBe('string | null');
  });
});

/**
 * The finding this file was written for. Before it, `oneOf`/`anyOf`/`allOf`
 * hit the catch-all and rendered as `unknown`.
 *
 * This is not hypothetical for the next sprint: `docs/sync-contract.md`
 * §6.2 defines the push result as a three-way discriminated union
 * (accepted / superseded / rejected), and P2.S1b is the sprint that puts it
 * on the wire. A field typed `unknown` there would compile, pass every
 * test, and silently defeat the four structural invariants ADR-0001 spent a
 * sprint making unrepresentable.
 */
describe('unions and intersections', () => {
  it('renders oneOf as a parenthesised union', () => {
    expect(renderType({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe(
      '(string | number)',
    );
  });

  it('renders anyOf the same way', () => {
    expect(renderType({ anyOf: [{ type: 'string' }, { type: 'boolean' }] })).toBe(
      '(string | boolean)',
    );
  });

  it('renders allOf as an intersection', () => {
    expect(
      renderType({
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      }),
    ).toBe('({\n  readonly a: string;\n} & {\n  readonly b: number;\n})');
  });

  it('collapses a union whose members render identically', () => {
    expect(renderType({ oneOf: [{ type: 'string' }, { type: 'string' }] })).toBe('string');
  });

  it('parenthesises so a nullable suffix cannot bind to the last member alone', () => {
    // `string | number | null` would be right by luck here, but the same
    // rendering inside ReadonlyArray<> or before an `&` would not be.
    expect(renderType({ oneOf: [{ type: 'string' }, { type: 'number' }], nullable: true })).toBe(
      '(string | number) | null',
    );
  });

  it('parenthesises inside an array, where an unparenthesised union changes meaning', () => {
    expect(
      renderType({ type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } }),
    ).toBe('ReadonlyArray<(string | number)>');
  });

  it('renders a discriminated union the shape P2.S1b will emit', () => {
    const rendered = renderType({
      oneOf: [
        {
          type: 'object',
          properties: { status: { type: 'string', enum: ['accepted'] } },
          required: ['status'],
        },
        {
          type: 'object',
          properties: { status: { type: 'string', enum: ['rejected'] } },
          required: ['status'],
        },
      ],
    });

    // Both arms survive with their literal discriminants — the property
    // that makes the union narrowable at all.
    expect(rendered).toContain('"accepted"');
    expect(rendered).toContain('"rejected"');
    expect(rendered).not.toContain('unknown');
  });

  it('refuses an empty oneOf rather than emitting something that describes no value', () => {
    expect(() => renderType({ oneOf: [] })).toThrow(/describes no value/);
  });
});

/**
 * The other half of the same finding: the catch-all used to emit `unknown`,
 * while the `$ref` branch directly above it threw — with a comment saying
 * "failing loudly beats emitting `unknown` for a clinical payload." The two
 * now agree.
 */
describe('unsupported shapes fail loudly rather than degrading to unknown', () => {
  it('throws on a schema shape it does not recognise', () => {
    expect(() => renderType({ type: 'bigint' })).toThrow(/Unsupported schema shape/);
  });

  it('names the offending schema and the function to fix, so the error is actionable', () => {
    expect(() => renderType({ type: 'bigint' })).toThrow(/renderType\(\)/);
  });

  it('still throws on a $ref, which this document should never contain', () => {
    expect(() => renderType({ $ref: '#/components/schemas/Observation' })).toThrow(
      /Unsupported \$ref/,
    );
  });

  it('does not mistake a nullable-only schema for an unsupported one', () => {
    // `{ nullable: true }` with no type reaches the catch-all. That IS
    // unsupported and should throw — pinned so a future "helpful" fallback
    // does not quietly reintroduce `unknown` through this door.
    expect(() => renderType({ nullable: true })).toThrow(/Unsupported schema shape/);
  });
});

/**
 * The patient client has ONE token supplier, documented as the patient
 * access token, and every `requiresAuth` operation draws from it. An admin
 * operation emitted here is therefore a method callable only with a patient
 * token against an endpoint backed by a disjoint Cognito pool (ADR-0008).
 *
 * One stub route today; the real value-set and threshold surface at P3.S3.
 */
describe('the admin surface never reaches the patient client', () => {
  const documentWithAdmin = {
    paths: {
      '/api/v1/observations': {
        get: { tags: ['observations'], operationId: 'Observations_list', responses: {} },
      },
      '/api/v1/admin/auth-stub': {
        get: { tags: ['admin-auth'], operationId: 'AdminAuth_get', responses: {} },
      },
      '/api/v1/admin/value-sets': {
        post: { tags: ['admin'], operationId: 'Admin_createValueSet', responses: {} },
        get: { tags: ['admin'], operationId: 'Admin_listValueSets', responses: {} },
      },
    },
  };

  it('excludes every /api/v1/admin route, whatever its tag or method', () => {
    const routes = collectOperations(documentWithAdmin).map((operation) => operation.route);

    expect(routes).toEqual(['/api/v1/observations']);
    expect(routes.some((route) => route.includes('admin'))).toBe(false);
  });

  it('keeps a patient route whose path merely contains the word elsewhere', () => {
    // Guards the prefix check against becoming a substring check — an
    // over-broad exclusion silently drops patient endpoints, which is the
    // opposite failure and just as quiet.
    const routes = collectOperations({
      paths: {
        '/api/v1/observations/admin-notes': {
          get: { tags: ['observations'], operationId: 'Observations_notes', responses: {} },
        },
      },
    }).map((operation) => operation.route);

    expect(routes).toEqual(['/api/v1/observations/admin-notes']);
  });
});
