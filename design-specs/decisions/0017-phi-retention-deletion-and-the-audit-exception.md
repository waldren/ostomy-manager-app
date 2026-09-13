# ADR-0017: PHI lives for the account's lifetime, and deletion reaches the audit log

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §5.2, §4.6 | [ADR-0011](0011-database-roles-and-audit-immutability.md) | [ADR-0014](0014-local-phi-encryption-and-device-ownership.md) | `docs/sync-contract.md` §10 | `docs/compliance/breach-notification.md`

## Context

Two things were open and each was blocking code.

**No retention period existed.** `docs/sync-contract.md` noted that tombstone purge is coupled to a PHI retention period still with counsel, and ADR-0014's on-device tombstones inherit the same gap — so the device accumulates deleted clinical values indefinitely too. Neither purge could be written without a number.

**Deletion could not actually delete.** `audit_events.before_value` and `after_value` are JSON columns holding the prior and new state of the audited row. For an observation that includes `valueQuantity.value` — so the audit log holds clinical values, by design and by requirement (CLAUDE.md: every PHI change is audit-logged "with before/after values"; ADR-0001's `sync_conflict_loser` rows exist specifically to preserve the version that lost).

ADR-0011 then makes that table append-only by **grant**: the runtime role holds `SELECT`/`INSERT` and no `UPDATE`/`DELETE`, deliberately, because append-only enforced by convention is not enforced at all. The correct consequence is that the API cannot purge or redact an audit row — so a deletion request could empty every clinical table and leave the same clinical values sitting in the audit log.

A third fact reframes both. This product is **direct-to-patient**: patients sign up themselves, with no provider relationship, so it is neither a HIPAA covered entity nor a business associate. The FTC Health Breach Notification Rule governs instead (`docs/compliance/breach-notification.md`). That matters here because the FTC's enforcement interest is squarely in *saying one thing and doing another* — telling a patient their data is deleted while retaining it is the deceptive-practice exposure, independent of any security question.

## Decision

We will retain PHI for the lifetime of the account, and honour a deletion request by revoking access immediately and hard-purging within 30 days — **including the patient's audit rows**, via a privileged job that does not run as the API.

Specifically:

- **Retention** is the account's lifetime. No fixed clinical-record term; these are patient-generated entries, not a provider's medical record, and no state record-retention statute reaches them.
- **On a deletion request:** access is revoked and sync refused at once; the device purges at its next launch (ADR-0014 already destroys the local database); the server hard-purges observations, tombstones, queue state, and profile within 30 days.
- **Audit rows for that patient are purged in the same job.** The job runs as the migration/owner role, offline, invoked deliberately — never reachable from request handling.
- The job writes its own record to a separate `deletion_log`: which patient, when, by whom, how many rows of each kind. That log carries **no clinical values**, so it is not itself subject to this policy.
- **Tombstone purge** (server and device) runs on the same trigger. There is no longer a separate open question.

## Consequences

**What this gets us.** "Delete my data" becomes true rather than nearly true, which under the FTC rule is the difference that matters. The 30-day window is not slack: a phone that is offline when the request lands has not purged yet, and needs to reconnect to be told. Immediate hard purge would leave that device holding the diary indefinitely while the server reported success.

**What this costs — and it is a real narrowing.**

ADR-0011's guarantee changes shape. It said, in effect, *nothing deletes an audit row*. It now says *no request can delete an audit row*. A path exists, and a path that exists can be misused or run in error.

Three things keep that narrowing honest, and all three are load-bearing:

1. The job runs as the owner role, which the API process never assumes. Compromising the API does not reach it.
2. It is invoked deliberately and offline. There is no endpoint, no scheduled trigger reading user input, and no code path from a request handler.
3. It records what it destroyed. An audit log whose deletions are unaudited is worse than one with no deletion path at all.

**What this costs elsewhere.** A patient who deletes in error has 30 days and no self-service undo; the recovery is a support action within the window, and after it the data is gone. And a deletion that is interrupted mid-job can leave a patient partly purged — the job must therefore be idempotent and re-runnable, and record completion rather than merely starting.

**What it forecloses.** Nothing structural, but it does mean the audit log can no longer be described as strictly append-only without qualification. Any future statement to a customer, auditor, or in the SRS must say "no request handler can modify or delete an audit row" rather than "audit rows are immutable".

**Not yet built.** This ADR records the decision; the purge job, the `deletion_log` table, and the account-deletion surface do not exist. They are P-TBD work. What *is* now unblocked is tombstone purge on both sides, which no longer waits on an open question.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep clinical values out of audit payloads entirely | Would remove the conflict at the root, and was seriously considered. It contradicts CLAUDE.md's before/after requirement and breaks ADR-0001's `sync_conflict_loser` rows, whose entire purpose is to preserve the losing version — there, the value *is* the record. |
| Retain audit rows and disclose it | No new privileged path, no schema change, and legally survivable if disclosed. Rejected because the disclosure a patient would have to accept — "we keep a record of your clinical values after you delete your account" — is the thing most people mean by deletion, and the FTC's interest is precisely in that gap. |
| A fixed 6–10 year clinical-record term | The commonly cited six-year HIPAA figure is §164.316's requirement for *policy documentation*, not patient records; record retention is state law, aimed at providers. Neither reaches a patient-generated diary, and adopting one would constrain deletion requests for no obligation we actually have. |
| Immediate hard purge, no window | Leaves an offline device holding the local diary with no opportunity to be told to purge, and makes an accidental request unrecoverable. |
| A 90-day window | More forgiving, but keeps the data breachable for three months after someone asked for it to be gone. |
| Let the runtime role delete audit rows | Would dissolve ADR-0011's guarantee entirely, and for the convenience of not writing a separate job. The whole point of that ADR is that a grant, not a convention, is what makes append-only real. |
