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

// GENERATED FILE — DO NOT EDIT.
//
// Regenerate with: pnpm --filter @ostomy/api api-client:generate
// Source: apps/api/openapi.json, emitted from the running module graph.
// Owner: nobody. ADR-0007 makes this path generated and never hand-edited.

import type {
  Observation,
  ObservationCreateResponse,
  ObservationListResponse,
  ObservationsListQuery,
} from './types.js';

/**
 * The subset of `fetch` this client uses, declared structurally.
 *
 * Not `typeof globalThis.fetch`: `packages/core` compiles against the ES2022
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
 * `body` is deliberately `unknown`: an error body is server-controlled
 * content and must be narrowed before use. Reason codes are clinically
 * expressive on their own — `EFFECTIVE_DATE_TIME_BEFORE_SURGERY` discloses
 * that the subject has a surgery date — so a rejection must not be forwarded
 * to third-party error tracking, attached to a crash report, or included in
 * any diagnostic bundle that leaves the device (docs/sync-contract.md §6.3).
 *
 * That rule used to be a doc comment saying "never log it," which is not a
 * control. `body` is now **non-enumerable**, so the things that carry an
 * error off-device by default no longer see it: `JSON.stringify(error)`,
 * React Native's LogBox and `console.error(error)`, `util.inspect`, and
 * Sentry's `ExtraErrorData` integration all enumerate own properties. Read
 * it deliberately, through `rejectionForCorrectionQueue()`, at the one place
 * that routes a rejection into the correction inbox.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
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
  // Explicit `| undefined` on an optional property: `packages/core` compiles
  // with `exactOptionalPropertyTypes`, where "absent" and "present and
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
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function request<TResponse>(requestOptions: RequestOptions): Promise<TResponse> {
    const headers: Record<string, string> = { accept: 'application/json' };

    if (requestOptions.requiresAuth) {
      const token = await options.getAccessToken?.();
      if (!token) {
        throw new MissingAccessTokenError();
      }
      headers.authorization = `Bearer ${token}`;
    }
    if (requestOptions.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const url = baseUrl + requestOptions.path + encodeQuery(requestOptions.query);

    const response = await resolveFetch(options.fetch)(url, {
      method: requestOptions.method,
      headers,
      ...(requestOptions.body !== undefined ? { body: JSON.stringify(requestOptions.body) } : {}),
    });

    const text = await response.text();
    const parsed: unknown = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

    if (!response.ok) {
      throw new ApiError(response.status, parsed);
    }
    return parsed as TResponse;
  }

  return {
    adminAuth: {
      /**
       * Returns the authenticated admin subject. Stub only.
       */
      get: (): Promise<void> =>
        request<void>({
          method: 'GET',
          path: `/api/v1/admin/auth-stub`,
          requiresAuth: true,
        }),
    },

    auth: {
      /**
       * Returns the authenticated patient subject. Stub only.
       */
      get: (): Promise<void> =>
        request<void>({
          method: 'GET',
          path: `/api/v1/auth-stub`,
          requiresAuth: true,
        }),
    },

    health: {
      /**
       * Liveness check. Always unauthenticated.
       */
      check: (): Promise<void> =>
        request<void>({
          method: 'GET',
          path: `/api/v1/health`,
          requiresAuth: false,
        }),
    },

    observations: {
      /**
       * Record one stoma-output observation
       *
       * Creates one observation. The payload is FHIR R4 shaped and identical to the sync wire payload (docs/sync-contract.md §7.2). Every packages/core Tier 1 rule is re-enforced here regardless of client-side validation; a Tier 2 warning is returned alongside a successful write and never blocks it.
       */
      create: (body: Observation): Promise<ObservationCreateResponse> =>
        request<ObservationCreateResponse>({
          method: 'POST',
          path: `/api/v1/observations`,
          body,
          requiresAuth: true,
        }),

      /**
       * Read one of this patient's observations
       *
       * Returns 404 both when no such observation exists and when it belongs to another patient — the lookup is scoped to (patient, id) together and never learns the difference, so this endpoint cannot be used to confirm that another patient's row exists.
       */
      findOne: (id: string): Promise<Observation> =>
        request<Observation>({
          method: 'GET',
          path: `/api/v1/observations/${encodeURIComponent(id)}`,
          requiresAuth: true,
        }),

      /**
       * List this patient's stoma-output observations
       *
       * Returns this patient's observations, most recent clinical moment first. Reads are not PHI mutations and are not audit events (SRS §5.2).
       */
      list: (query?: ObservationsListQuery): Promise<ObservationListResponse> =>
        request<ObservationListResponse>({
          method: 'GET',
          path: `/api/v1/observations`,
          query,
          requiresAuth: true,
        }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
