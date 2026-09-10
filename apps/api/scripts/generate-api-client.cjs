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

// Generates `packages/core/src/api-client` from `apps/api/openapi.json`.
//
//   pnpm --filter @ostomy/api api-client:generate
//
// ADR-0007 makes `packages/core/src/api-client` generated and never
// hand-edited by anyone. This script is what makes that claim true rather
// than aspirational: the client is reproducible from the document the server
// itself emits, so "the client and the server disagree" is not a state the
// repository can be in for longer than one regeneration.
//
// **Why a purpose-built generator rather than an off-the-shelf one.** The
// output has to satisfy constraints an off-the-shelf template does not know
// about: `packages/core` is ESM under `nodenext`, so every relative import
// needs an explicit `.js` extension; `verbatimModuleSyntax` requires
// `import type` for type-only imports; `exactOptionalPropertyTypes` makes
// "key absent" and "key present and undefined" different things; and
// ADR-0010 forbids top-level await anywhere in this package's entry graph,
// because `apps/api` loads it through `require(esm)` and would throw
// `ERR_REQUIRE_ASYNC_MODULE`. It also adds no dependency to a package that
// currently has none. The scope this has to cover is one API surface we
// control the schemas of, and `packages/core`'s own build typechecks the
// output on every `pnpm verify` — a generator that emits something invalid
// fails loudly rather than subtly.
//
// The document is authored by zod schemas next to the handlers
// (`observation-openapi.ts`), so a named type here comes from a schema
// `title` and nothing is inferred from a decorator's parameter name.
//
/* eslint-disable no-console -- a code generator's output is its console. */
/* eslint-disable @typescript-eslint/no-require-imports -- this is a plain
   CommonJS script run with `node`, not compiled TypeScript source; see
   scripts/require-core-smoke.cjs for the same exemption. */
'use strict';

const prettier = require('prettier');
const fs = require('node:fs');
const path = require('node:path');

/** `--check` compares the on-disk client against a fresh emit and writes nothing. */
const CHECK_ONLY = process.argv.includes('--check');

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
const DOCUMENT_PATH = path.join(API_ROOT, 'openapi.json');
const OUTPUT_DIR = path.join(REPO_ROOT, 'packages', 'core', 'src', 'api-client');

const LICENSE_HEADER = `/*
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
`;

const GENERATED_BANNER = `
// GENERATED FILE — DO NOT EDIT.
//
// Regenerate with: pnpm --filter @ostomy/api api-client:generate
// Source: apps/api/openapi.json, emitted from the running module graph.
// Owner: nobody. ADR-0007 makes this path generated and never hand-edited.
`;

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function pascalCase(value) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function camelCase(value) {
  const pascal = pascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function isSafeIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function propertyKey(name) {
  return isSafeIdentifier(name) ? name : JSON.stringify(name);
}

// ---------------------------------------------------------------------------
// Schema -> TypeScript
// ---------------------------------------------------------------------------

/** Named interfaces collected from schema `title`s, keyed by name. */
const namedTypes = new Map();

function registerNamedType(name, body, description) {
  const existing = namedTypes.get(name);
  if (existing && existing.body !== body) {
    throw new Error(
      `Two different schemas both claim the title "${name}". A title is the generated ` +
        `type name, so this would silently emit one shape under a name that means another. ` +
        `Give one of them a distinct .meta({ title }) in apps/api.`,
    );
  }
  namedTypes.set(name, { body, description });
}

function indent(text, depth) {
  const pad = '  '.repeat(depth);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/**
 * Renders `oneOf`/`anyOf`/`allOf` members into a union or intersection.
 *
 * Parenthesised whenever there is more than one member: `A | B | null` reads
 * correctly by luck, but `ReadonlyArray<A | B>` and a trailing `& C` do not,
 * and the `nullable` suffix below appends without knowing what it is
 * appending to.
 */
function renderComposite(members, separator, depth, keyword) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error(`A schema declares an empty \`${keyword}\`, which describes no value.`);
  }
  const rendered = members.map((member) => renderType(member, depth));
  const unique = [...new Set(rendered)];
  return unique.length === 1 ? unique[0] : `(${unique.join(separator)})`;
}

function renderObject(schema, depth) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return 'Record<string, unknown>';
  }

  const lines = entries.map(([name, property]) => {
    const optional = required.has(name) ? '' : '?';
    const doc = property.description
      ? `/** ${property.description.replace(/\*\//g, '*\\/')} */\n`
      : '';
    return `${doc}readonly ${propertyKey(name)}${optional}: ${renderType(property, depth + 1)};`;
  });

  return `{\n${indent(lines.join('\n'), depth + 1)}\n${'  '.repeat(depth)}}`;
}

function renderType(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') {
    return 'unknown';
  }
  // A titled schema always renders its body at depth 0: it becomes a
  // top-level `export type`, and rendering it at the caller's depth would
  // make the same schema produce differently-indented bodies at different
  // call sites, which the collision guard below would then read as two
  // different schemas sharing one title.
  const effectiveDepth = schema.title ? 0 : depth;
  depth = effectiveDepth;
  if (schema.$ref) {
    // The document this generator consumes inlines everything (schemas come
    // from zod, one call per operation), so a `$ref` means the emitter
    // changed shape and this generator has not caught up. Failing loudly
    // beats emitting `unknown` for a clinical payload.
    throw new Error(`Unsupported $ref in schema: ${schema.$ref}`);
  }

  let rendered;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    rendered = schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  } else if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    // `z.union` and `z.discriminatedUnion` both land here. Rendered as a
    // TypeScript union, parenthesised so a later `| null` from `nullable`
    // cannot bind to only the last member.
    const members = schema.oneOf ?? schema.anyOf;
    rendered = renderComposite(members, ' | ', depth, 'oneOf/anyOf');
  } else if (Array.isArray(schema.allOf)) {
    rendered = renderComposite(schema.allOf, ' & ', depth, 'allOf');
  } else if (schema.type === 'array') {
    rendered = `ReadonlyArray<${renderType(schema.items ?? {}, depth)}>`;
  } else if (schema.type === 'object' || schema.properties) {
    rendered = renderObject(schema, depth);
  } else if (schema.type === 'string') {
    rendered = 'string';
  } else if (schema.type === 'number' || schema.type === 'integer') {
    rendered = 'number';
  } else if (schema.type === 'boolean') {
    rendered = 'boolean';
  } else {
    // Fails loudly, exactly as the `$ref` branch above does and for the same
    // reason. This used to emit `unknown`: the output compiled, `pnpm verify`
    // stayed green, and every consumer of the field silently lost type
    // safety with no signal anywhere. For a clinical payload that is the
    // worst available outcome — a wrong client that looks right.
    throw new Error(
      `Unsupported schema shape, refusing to emit \`unknown\` for it: ${JSON.stringify(schema)}. ` +
        'Add a branch to renderType() in scripts/generate-api-client.cjs.',
    );
  }

  if (schema.nullable === true) {
    rendered = `${rendered} | null`;
  }

  if (schema.title) {
    // A titled schema becomes a named interface, referenced by name
    // everywhere it appears.
    registerNamedType(schema.title, rendered, schema.description);
    return schema.title;
  }
  return rendered;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * Registers every response body's named types, including error bodies.
 *
 * A client that cannot name the shape of a rejection cannot act on one, and
 * acting on a rejection — surfacing it for correction rather than dropping
 * or blindly retrying it — is a requirement (AC 13.1 AC 4), not a nicety.
 * Only success bodies become method return types; error bodies are emitted
 * as types a caller narrows `ApiError.body` to.
 */
function registerResponseTypes(operation) {
  for (const response of Object.values(operation.responses ?? {})) {
    const schema = response.content?.['application/json']?.schema;
    if (schema) {
      renderType(schema);
    }
  }
}

function successResponse(operation) {
  const responses = operation.responses ?? {};
  const code = Object.keys(responses)
    .filter((status) => /^2\d\d$/.test(status))
    .sort()[0];
  if (!code) {
    return { status: 200, type: 'void' };
  }
  const content = responses[code].content?.['application/json'];
  return {
    status: Number(code),
    type: content?.schema ? renderType(content.schema) : 'void',
  };
}

/**
 * Routes the patient client must not contain.
 *
 * The admin API is backed by a Cognito pool disjoint from the patient pool
 * (SRS_v2 §4.6, ADR-0008) — the boundary is enforced at the identity layer
 * rather than by authorization logic. But `createApiClient` has ONE token
 * supplier, documented as "the patient access token", and every operation
 * marked `requiresAuth` draws from it. Emitting `/api/v1/admin/**` into this
 * client therefore produces a method that can only ever be called with a
 * patient bearer token against an admin endpoint.
 *
 * That is not a server-side hole — `AdminJwtAuthGuard` is bound to a
 * different issuer and audience, and `route-guard-coverage.spec.ts` proves
 * the guards never mix — but it is one token supplier spanning two identity
 * pools, in a client whose stated boundary is structural. Today it is one
 * stub route; at P3.S3 it is the real value-set and threshold surface, and
 * by P8 it is the client's published shape.
 *
 * Excluded rather than emitted into a second module, deliberately: a
 * separate admin client needs its own `packages/core` subpath, its own entry
 * in `packages/config/eslint/index.js`'s admin allow-list, and an owner
 * under ADR-0007. `apps/admin` does not exist yet (P8.S1), so inventing that
 * policy now would be designing for a consumer nobody has written. The
 * sprint that builds the admin API surface for real (P3.S3) owns it.
 *
 * The exclusion is reported on stdout, never silent — a generated client
 * quietly missing an endpoint is its own kind of defect.
 */
const EXCLUDED_ROUTE_PREFIX = '/api/v1/admin';

function collectOperations(document) {
  const operations = [];
  const excluded = [];
  for (const [route, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      if (route.startsWith(EXCLUDED_ROUTE_PREFIX)) {
        excluded.push(`${method.toUpperCase()} ${route}`);
        continue;
      }

      const tag = operation.tags?.[0] ?? 'default';
      const group = camelCase(tag);
      const rawName = (operation.operationId ?? `${method}${route}`).split('_').slice(1).join('_');
      const name = camelCase(rawName || method);

      // Path parameters come from the route template rather than from the
      // document's `parameters` array: the template is what the request URL
      // is built from, so deriving them from anything else can produce a
      // method that cannot construct its own URL.
      const pathParams = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const queryParams = (operation.parameters ?? [])
        .filter((parameter) => parameter.in === 'query')
        .sort((left, right) => left.name.localeCompare(right.name));

      const queryTypeName = queryParams.length
        ? `${pascalCase(tag)}${pascalCase(name)}Query`
        : undefined;
      if (queryTypeName) {
        const lines = queryParams.map((parameter) => {
          const doc = parameter.description
            ? `/** ${parameter.description.replace(/\*\//g, '*\\/')} */\n`
            : '';
          const optional = parameter.required ? '' : '?';
          return `${doc}readonly ${propertyKey(parameter.name)}${optional}: ${renderType(parameter.schema ?? {}, 1)};`;
        });
        registerNamedType(queryTypeName, `{\n${indent(lines.join('\n'), 1)}\n}`, undefined);
      }

      registerResponseTypes(operation);

      const bodySchema = operation.requestBody?.content?.['application/json']?.schema;

      operations.push({
        route,
        method,
        group,
        name,
        summary: operation.summary,
        description: operation.description,
        pathParams,
        queryTypeName,
        bodyType: bodySchema ? renderType(bodySchema) : undefined,
        response: successResponse(operation),
        requiresAuth: Array.isArray(operation.security) && operation.security.length > 0,
      });
    }
  }

  if (excluded.length > 0) {
    console.log(
      `Excluded ${excluded.length} admin operation(s) from the patient client ` +
        `(disjoint identity pool, ADR-0008): ${excluded.join(', ')}`,
    );
  }

  return operations;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function emitTypes() {
  const blocks = [...namedTypes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, { body, description }]) => {
      const doc = description ? `/**\n * ${description.replace(/\*\//g, '*\\/')}\n */\n` : '';
      return `${doc}export type ${name} = ${body};`;
    });

  return `${LICENSE_HEADER}${GENERATED_BANNER}
${blocks.join('\n\n')}
`;
}

function methodSignature(operation) {
  const args = [];
  for (const parameter of operation.pathParams) {
    args.push(`${camelCase(parameter)}: string`);
  }
  if (operation.bodyType) {
    args.push(`body: ${operation.bodyType}`);
  }
  if (operation.queryTypeName) {
    args.push(`query?: ${operation.queryTypeName}`);
  }
  return args.join(', ');
}

function urlExpression(operation) {
  let template = operation.route;
  for (const parameter of operation.pathParams) {
    template = template.replace(
      `{${parameter}}`,
      `\${encodeURIComponent(${camelCase(parameter)})}`,
    );
  }
  return `\`${template}\``;
}

function emitClient(operations) {
  const byGroup = new Map();
  for (const operation of operations) {
    if (!byGroup.has(operation.group)) {
      byGroup.set(operation.group, []);
    }
    byGroup.get(operation.group).push(operation);
  }

  // Only the names the emitted methods actually mention: `packages/core`
  // compiles with `noUnusedLocals`, so importing every generated type would
  // fail the build the moment one of them appears only in an error body.
  const usedTypeNames = new Set();
  for (const operation of operations) {
    if (operation.bodyType) usedTypeNames.add(operation.bodyType);
    if (operation.queryTypeName) usedTypeNames.add(operation.queryTypeName);
    if (operation.response.type !== 'void') usedTypeNames.add(operation.response.type);
  }
  const typeImports = [...namedTypes.keys()].filter((name) => usedTypeNames.has(name)).sort();

  const groupBlocks = [...byGroup.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, groupOperations]) => {
      const methods = groupOperations
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((operation) => {
          const docLines = [operation.summary, operation.description].filter(Boolean);
          const doc = docLines.length
            ? `/**\n${docLines.map((line) => ` * ${line.replace(/\*\//g, '*\\/')}`).join('\n *\n')}\n */\n`
            : '';
          const call = [
            `request<${operation.response.type === 'void' ? 'void' : operation.response.type}>({`,
            `  method: '${operation.method.toUpperCase()}',`,
            `  path: ${urlExpression(operation)},`,
            operation.bodyType ? '  body,' : undefined,
            operation.queryTypeName ? '  query,' : undefined,
            `  requiresAuth: ${operation.requiresAuth},`,
            '})',
          ]
            .filter((line) => line !== undefined)
            .join('\n');

          return `${doc}${operation.name}: (${methodSignature(operation)}): Promise<${
            operation.response.type === 'void' ? 'void' : operation.response.type
          }> =>\n${indent(call, 1)},`;
        });

      return `${group}: {\n${indent(methods.join('\n\n'), 1)}\n},`;
    });

  return `${LICENSE_HEADER}${GENERATED_BANNER}
import type {
${typeImports.map((name) => `  ${name},`).join('\n')}
} from './types.js';

/**
 * The subset of \`fetch\` this client uses, declared structurally.
 *
 * Not \`typeof globalThis.fetch\`: \`packages/core\` compiles against the ES2022
 * lib with no DOM, deliberately — it is consumed by React Native, a browser
 * SPA and a Node service, and taking a DOM lib dependency here would put
 * browser globals into the type space of all three. A structural type also
 * makes this client testable without stubbing a global.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface ApiClientOptions {
  /** Origin the API is served from, with no trailing slash. */
  readonly baseUrl: string;
  /**
   * Supplies the patient access token for endpoints that require one.
   * Called per request rather than captured once, so a refreshed token is
   * picked up without rebuilding the client.
   */
  readonly getAccessToken?: () => string | undefined | Promise<string | undefined>;
  /** Injectable for tests and for runtimes whose fetch is not global. */
  readonly fetch?: FetchLike;
}

/**
 * A non-2xx response.
 *
 * \`body\` is deliberately \`unknown\`: an error body is server-controlled
 * content and must be narrowed before use. Reason codes are clinically
 * expressive on their own — \`EFFECTIVE_DATE_TIME_BEFORE_SURGERY\` discloses
 * that the subject has a surgery date — so a rejection must not be forwarded
 * to third-party error tracking, attached to a crash report, or included in
 * any diagnostic bundle that leaves the device (docs/sync-contract.md §6.3).
 *
 * That rule used to be a doc comment saying "never log it," which is not a
 * control. \`body\` is now **non-enumerable**, so the things that carry an
 * error off-device by default no longer see it: \`JSON.stringify(error)\`,
 * React Native's LogBox and \`console.error(error)\`, \`util.inspect\`, and
 * Sentry's \`ExtraErrorData\` integration all enumerate own properties. Read
 * it deliberately, through \`rejectionForCorrectionQueue()\`, at the one place
 * that routes a rejection into the correction inbox.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, body: unknown) {
    super(\`API request failed with status \${status}\`);
    this.name = 'ApiError';
    this.status = status;
    // Non-enumerable and non-writable. See the class comment: this is the
    // difference between a rule and a control.
    Object.defineProperty(this, 'body', {
      value: body,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  /**
   * The rejection body, for the one caller that routes it into the patient's
   * correction queue. Named for that purpose so a call site that is doing
   * anything else — logging, reporting, bundling — reads as obviously wrong.
   */
  rejectionForCorrectionQueue(): unknown {
    return Object.getOwnPropertyDescriptor(this, 'body')?.value;
  }
}

/** Thrown when an endpoint that requires a token is called without one. */
export class MissingAccessTokenError extends Error {
  constructor() {
    super('This endpoint requires a patient access token, and none was supplied.');
    this.name = 'MissingAccessTokenError';
  }
}

type QueryParameters = Readonly<Record<string, string | number | boolean | undefined>>;

interface RequestOptions {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  // Explicit \`| undefined\` on an optional property: \`packages/core\` compiles
  // with \`exactOptionalPropertyTypes\`, where "absent" and "present and
  // undefined" are different types.
  readonly query?: QueryParameters | undefined;
  readonly requiresAuth: boolean;
}

function resolveFetch(injected: FetchLike | undefined): FetchLike {
  if (injected) {
    return injected;
  }
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    throw new Error('No fetch implementation is available. Pass one as ApiClientOptions.fetch.');
  }
  return candidate as FetchLike;
}

function encodeQuery(query: QueryParameters | undefined): string {
  const pairs = Object.entries(query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => \`\${encodeURIComponent(key)}=\${encodeURIComponent(String(value))}\`);
  return pairs.length > 0 ? \`?\${pairs.join('&')}\` : '';
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\\/+$/, '');

  async function request<TResponse>(requestOptions: RequestOptions): Promise<TResponse> {
    const headers: Record<string, string> = { accept: 'application/json' };

    if (requestOptions.requiresAuth) {
      const token = await options.getAccessToken?.();
      if (!token) {
        throw new MissingAccessTokenError();
      }
      headers.authorization = \`Bearer \${token}\`;
    }
    if (requestOptions.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const url = baseUrl + requestOptions.path + encodeQuery(requestOptions.query);

    const response = await resolveFetch(options.fetch)(url, {
      method: requestOptions.method,
      headers,
      ...(requestOptions.body !== undefined
        ? { body: JSON.stringify(requestOptions.body) }
        : {}),
    });

    const text = await response.text();
    const parsed: unknown = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

    if (!response.ok) {
      throw new ApiError(response.status, parsed);
    }
    return parsed as TResponse;
  }

  return {
${indent(groupBlocks.join('\n\n'), 2)}
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
`;
}

function emitIndex() {
  return `${LICENSE_HEADER}${GENERATED_BANNER}
export * from './types.js';
export { ApiError, MissingAccessTokenError, createApiClient } from './client.js';
export type { ApiClient, ApiClientOptions, FetchLike } from './client.js';
`;
}

// ---------------------------------------------------------------------------

async function formatFor(filePath, contents) {
  const config = await prettier.resolveConfig(filePath);
  return prettier.format(contents, {
    ...(config ?? {}),
    filepath: filePath,
    parser: 'typescript',
  });
}

async function main() {
  if (!fs.existsSync(DOCUMENT_PATH)) {
    throw new Error(
      `No OpenAPI document at ${DOCUMENT_PATH}. Run \`pnpm --filter @ostomy/api openapi:generate\` first.`,
    );
  }
  const document = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf-8'));
  const operations = collectOperations(document);
  if (operations.length === 0) {
    throw new Error(
      'The OpenAPI document declares no operations — refusing to emit an empty client.',
    );
  }

  // Formatted with the repository's own Prettier config before being
  // written. `pnpm verify` runs `prettier --check .` across every workspace,
  // generated files included — so an unformatted emit would fail the build
  // for everyone, at a file nobody is allowed to fix by hand.
  const emitted = new Map([
    ['types.ts', await formatFor(path.join(OUTPUT_DIR, 'types.ts'), emitTypes())],
    ['client.ts', await formatFor(path.join(OUTPUT_DIR, 'client.ts'), emitClient(operations))],
    ['index.ts', await formatFor(path.join(OUTPUT_DIR, 'index.ts'), emitIndex())],
  ]);

  if (CHECK_ONLY) {
    return reportDrift(emitted);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const [fileName, contents] of emitted) {
    fs.writeFileSync(path.join(OUTPUT_DIR, fileName), contents, 'utf-8');
  }

  console.log(
    `Generated ${operations.length} operations and ${namedTypes.size} types into ${OUTPUT_DIR}`,
  );
}

/**
 * `--check`: regenerate into memory and compare against what is on disk,
 * changing nothing.
 *
 * Without this, the ADR-0007 claim that `packages/core/src/api-client` is
 * generated from the server's own document is true of this script and false
 * of the repository — `openapi.json` is gitignored, nothing in `pnpm verify`
 * regenerates, and CI runs only `pnpm verify`. A change to a handler's zod
 * schema committed without running `api-client:generate` therefore leaves a
 * client describing an API the server no longer serves, with a fully green
 * build and no signal to anyone.
 */
function reportDrift(emitted) {
  const stale = [];
  for (const [fileName, expected] of emitted) {
    const filePath = path.join(OUTPUT_DIR, fileName);
    const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    if (actual === null) {
      stale.push(`  ${fileName}: missing`);
    } else if (actual !== expected) {
      stale.push(`  ${fileName}: differs from what the current OpenAPI document generates`);
    }
  }

  if (stale.length > 0) {
    console.error(
      ['The generated API client is out of date:', ...stale, ''].join('\n') +
        '\nRegenerate it with `pnpm --filter @ostomy/api api-client:generate` and commit the result. ' +
        'Never hand-edit these files (ADR-0007) — if the output is wrong, fix the zod schemas next ' +
        'to the handlers and regenerate.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`API client is up to date with ${DOCUMENT_PATH} (${emitted.size} files checked)`);
}

// Only when run as a script. Without this guard the generator executes on
// `require()`, which is why it had no tests: importing it to exercise
// `renderType()` would regenerate the client as a side effect.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

// Exported for `generate-api-client.spec.ts`. The schema-to-TypeScript
// rendering is the part with real branching and the part whose failure mode
// is silent, so it is the part under test.
module.exports = { renderType, renderComposite, collectOperations, namedTypes };
