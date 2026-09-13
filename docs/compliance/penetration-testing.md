# Penetration testing

- **Owner:** [Security & Privacy Officer — TBD]
- **Last reviewed:** [ ]
- **Next review:** [ ]

## Status: committed, not yet performed

No penetration test has been carried out. Nothing in this product has been tested by anyone who was not also building it.

Not required under the FTC Health Breach Notification Rule. Committed to voluntarily, and recorded here with a cadence, because a testing intention without a trigger date does not happen — and because the first test usually reshapes a roadmap rather than confirming it.

## Cadence

| Trigger | Scope |
|---|---|
| **Before the first production PHI** | Full scope: API, both clients, auth flows, sync protocol, infrastructure. This is the blocking one. |
| **Annually thereafter** | Full scope |
| **After any change to auth, sync, or the admin boundary** | Targeted to the change |
| **Before the first clinic or provider customer** | Full scope, because that relationship makes HIPAA apply for real (`breach-notification.md`) |

## Areas a tester should be pointed at first

Not to narrow the scope — to say where this codebase already knows it is interesting.

- **The sync protocol.** `docs/sync-contract.md` governs it and is normative. The patient is resolved from the token subject and never from the payload (§2); confirm no path reintroduces a client-supplied patient identifier.
- **The admin/patient identity boundary.** Disjoint user pools by design (SRS_v2 §4.6), enforced at the identity layer rather than by authorization logic. There is no `apps/admin` yet, so this is a design review today.
- **The audit log's new deletion path.** ADR-0017 narrowed ADR-0011's guarantee from "nothing deletes an audit row" to "no request can delete an audit row". The privileged purge job is the thing to attack: any route from a request handler to it is a critical finding.
- **On-device storage.** ADR-0014 and ADR-0015. **These are the controls with no automated coverage at all** — jest runs no keychain and cannot simulate biometric enrolment invalidation, so a green build proves nothing about them. Physical-device testing is where they are first verified.
- **Token handling on both clients.** Refresh-token storage, RP-initiated logout, the session-epoch guard that prevents an in-flight refresh resurrecting a signed-out session.

## What a finding blocks

Decided in advance, so it is not negotiated under deadline pressure:

- **Critical or high, reachable from an unauthenticated request:** blocks release.
- **Critical or high, requiring a valid token:** blocks release.
- **Anything touching PHI confidentiality:** blocks release regardless of rated severity.
- **Medium and below:** tracked with a fix date, does not block.

## Open items

- [ ] Select a tester and scope the first engagement
- [ ] Budget and schedule it against the production-launch date
- [ ] Decide whether findings are tracked in the repo or held separately
