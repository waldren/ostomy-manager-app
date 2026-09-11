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

import { Injectable, Logger } from '@nestjs/common';

/**
 * The application **security log**: security-relevant events that are not
 * PHI mutations.
 *
 * ## Why this is not `audit_events`
 *
 * `docs/sync-contract.md` §2 rules it out by name: *"A read is not an SRS
 * §5.2 audit event and does not belong in `audit_events` — this goes to the
 * application security log, which is where the question 'did a bulk export
 * happen, and when' has to be answerable from, because that is the
 * determination the breach-notification clock runs on."*
 *
 * The two stores answer different questions and have different shapes.
 * `audit_events` is append-only by grant (ADR-0011) and records **changes**
 * to PHI with before/after values. This records **access and refusal
 * patterns**, carries no clinical values at all, and its retention is an
 * operational question rather than a clinical-record one.
 *
 * ## What may go in a line here
 *
 * An actor identifier, a request id, an event name, and counts. **Never a
 * clinical value**, and never anything derived from a request payload. An
 * actor id is an identifier and that is deliberate — a security log that
 * cannot say *who* answers none of the questions it exists for — but it is
 * the ceiling, not a starting point.
 *
 * ## What this is not, yet
 *
 * A Pino context, not a separate sink. That is the honest amount of
 * infrastructure to build today: it satisfies §2's requirement that the event
 * be recorded and greppable, and it does not pretend to durability the
 * deployment does not have. When the events here need to survive independently
 * of application-log retention — which is a conversation with the same owner
 * as the PHI retention period — this is the seam to route elsewhere, and every
 * caller already goes through it.
 */
@Injectable()
export class SecurityLogService {
  private readonly logger = new Logger(SecurityLogService.name);

  /**
   * A client asked for the patient's entire history (`since=0`).
   *
   * §2: *"`since=0` returns a patient's entire clinical history in pages; it
   * is legitimate exactly at install and reinstall, and it is also what a
   * stolen token is worth."* Legitimate and worth recording are not in
   * tension — the point is that afterwards you can tell the two apart by
   * frequency and timing, which you cannot do if nothing is written down.
   */
  fullHistoryPull(fields: {
    readonly actorSubject: string;
    readonly patientId: string;
    readonly requestId: string | undefined;
    readonly limit: number;
  }): void {
    this.logger.log(
      JSON.stringify({
        event: 'sync.delta.full_history_pull',
        actorSubject: fields.actorSubject,
        patientId: fields.patientId,
        requestId: fields.requestId ?? null,
        limit: fields.limit,
      }),
    );
  }

  /**
   * A patient's token was used against an entity id belonging to someone
   * else.
   *
   * The client is told only that no such entity exists (§2: an id that
   * resolves only to another patient's row *"is treated as not existing"*),
   * so this line is the only place the attempt survives. That asymmetry is
   * the point: the probe learns nothing and the operator still sees it.
   *
   * Carries the entity id, which is a client-supplied UUID naming a row this
   * patient does not own — not a clinical value, and the one field that makes
   * a pattern of probes recognisable as one.
   */
  crossPatientEntityAccess(fields: {
    readonly actorSubject: string;
    readonly patientId: string;
    readonly entityId: string;
    readonly requestId: string | undefined;
  }): void {
    this.logger.warn(
      JSON.stringify({
        event: 'sync.push.cross_patient_entity',
        actorSubject: fields.actorSubject,
        patientId: fields.patientId,
        entityId: fields.entityId,
        requestId: fields.requestId ?? null,
      }),
    );
  }
}
