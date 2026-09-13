# ADR-0014: Encrypt the on-device clinical store, and bind it to one patient

- **Status:** Accepted
- **Date:** 2026-09-12
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §4.2, §5.2, §4.6 | [ADR-0011](0011-database-roles-and-audit-immutability.md) | [ADR-0015](0015-biometric-local-access.md) | `docs/sync-contract.md` §2, §9 | PR #15

## Context

`apps/mobile` is the only offline-capable client (SRS_v2 §4.2). That is a settled architectural decision and is not reopened here. Its consequence is that this app is the one place in the system where PHI rests on hardware nobody in the covered entity controls, and where the usual server-side protections — ADR-0011's grant-enforced append-only audit table, the runtime role that cannot `UPDATE` or `DELETE` — simply do not reach.

The P2.S2a substrate created that surface for the first time: an `observations` table and a `sync_queue` whose `payload` column holds the same clinical values as JSON. Three properties of the initial implementation forced this decision.

**The store was plaintext.** `expo-sqlite` does not encrypt by default, and the app config explicitly set `useSQLCipher: false`. The file is readable with `sqlite3` on a rooted or jailbroken device, on a device handed to a repair shop, and in any forensic extraction. OS full-disk encryption is a partial mitigation keyed to the screen lock, so it provides nothing at all on an Android device with no lock set.

**The file entered consumer cloud backup.** Expo's Android default is `allowBackup: true`, and nothing excluded the SQLite directory from iOS backup. So the diary was copied into the patient's personal Google Drive or iCloud account. Apple and Google do not execute BAAs for consumer backup, which means these destinations can never appear on SRS_v2 §4.6's covered-service list — this is PHI leaving the covered boundary through a default nobody turned off.

**Nothing bound the database to a patient.** No table carried a subject column, `sync_cursor` was a hardcoded single row, and sign-out cleared only the refresh token. On a shared, handed-down, or clinic-issued phone this produces an escalating sequence: patient A's diary survives their sign-out; patient B signs in and reads it, because `listObservationsByCode` filters on LOINC code alone; and once the sync worker lands, A's queued rows are pushed with B's token. The server resolves `patientId` and `actorId` from the presented token's subject and never from the payload (`docs/sync-contract.md` §2) — correctly, since that field is the one that would otherwise carry an attack — so A's clinical values land in B's record and the audit row names B as the author of an entry B never made.

The third is what makes this urgent rather than merely important. An audit log is the authoritative reconstruction of who did what, ADR-0011 makes it append-only by grant, and a false row in it cannot be corrected afterwards. It is also cheap to prevent now and expensive after P2.S2b, when there is a sync worker and a populated queue.

## Decision

We will encrypt the local clinical database with SQLCipher, keyed by a 32-byte CSPRNG value generated on first run and held in `expo-secure-store`; we will keep the database out of OS cloud backup as far as each platform allows; and we will bind the database to exactly one OIDC subject, destroying it whenever that subject changes or the patient signs out.

Specifically:

- `useSQLCipher: true`, with `PRAGMA key` issued as the first statement on every connection (`db/expoSqliteExecutor.ts`).
- The key lives in `expo-secure-store` under `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` and **without** `requireAuthentication` — see Consequences (`db/databaseKey.ts`).
- `allowBackup: false` on Android.
- The owning subject is stored in `expo-secure-store`, read before the database is opened, and compared on every sign-in (`db/databaseOwner.ts`). A mismatch, or an absent owner, purges.
- Purge deletes the database *file* and then the key, never `DELETE FROM` (`db/purge.ts`).
- Sign-out purges.

## Consequences

**What this gets us.** Encryption at rest per the HHS guidance is the breach-notification safe harbour: a lost phone holding an encrypted store is not a reportable breach, while the same phone holding a plaintext one is. Without it, every lost patient phone becomes an incident-response event. Subject binding removes the cross-patient disclosure and, more importantly, removes the path by which one patient's entries acquire another patient's name in an immutable audit log.

**What this costs.**

*Unsynced entries are destroyed on sign-out.* This is the real price and it is not yet mitigated. `docs/sync-contract.md` §9 is explicit that a rejected operation is retained locally and surfaced for correction, never dropped, and the same principle says a patient should not silently lose entries they made offline. The correct behaviour is to count pending operations and warn — "you have N entries that haven't synced yet" — which needs UI that does not exist in P2.S2a. Purging unconditionally is the deliberate interim choice, because leaving one patient's clinical values on a device for the next patient is worse than a loss the patient initiated. **This must land with the sync worker in P2.S2b**, when there is finally something in the queue to lose.

*A lost key is a lost diary.* There is no recovery path by design: the key is device-bound and never escrowed. A patient who restores a backup onto a new phone gets ciphertext they cannot read. That is the same property that makes the backup copy safe, so it cannot be softened without giving up the protection.

*Debugging is harder.* No one can open the database with `sqlite3` any more, including us on a development device.

**What it forecloses.** Migrating an existing plaintext database to an encrypted one requires a data-migration path nobody has written, so this had to be decided before any real device carried data — which is why it is being made at P2.S2a rather than when it was noticed. It also forecloses any future feature that needs the database readable outside the app process.

**Known gap, recorded rather than skipped.** iOS backup exclusion is *not* implemented: `expo-file-system@57` removed `setIsExcludedFromBackupAsync`, so the attribute cannot be set from JavaScript at this version, and the database still enters iCloud backup. What makes that acceptable rather than a hole is the pairing of SQLCipher with a `_THIS_DEVICE_ONLY` key that the keychain does not migrate on restore: a backup restored onto a different phone yields an undecryptable file, while a restore onto the same device still works. Adding the exclusion via an Expo config plugin remains worthwhile as defence in depth — it would stop the ciphertext leaving the device at all rather than relying on key separation.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Rely on OS full-disk encryption | Keyed to the screen lock, so it provides nothing on an Android device with no lock configured, and nothing at all against the backup path — the file leaves the device already decrypted. |
| Add a `subject` column to each table and filter on it | Fixes the read path and leaves the data on disk. It hides patient A's diary from patient B rather than removing it, does nothing for "sign out means my data is gone", and leaves the `sync_queue` rows that produce the false audit attribution. |
| `DELETE FROM` each table instead of deleting the file | Leaves values in freed SQLite pages and in the WAL until a `VACUUM` that may never run, so the rows stay recoverable with ordinary forensic tooling. For an affordance whose entire purpose is "this data is no longer on this device", that would make the control a lie. |
| Derive the SQLCipher key from the patient's subject | A key derived from an identifier an attacker can also obtain is not a key. |
| Protect the SQLCipher key with `requireAuthentication` | An invalidated key costs the patient every unsynced entry, permanently, with no recovery — the ciphertext becomes undecryptable. A patient who adds a fingerprint must not lose their diary. The refresh token takes that flag precisely because losing it costs only a re-login (ADR-0015). |
| Defer all of this to P2.S2b | The audit-attribution defect gets materially more expensive once a sync worker exists, and the encryption decision gets *impossible* to make cheaply once any real device carries plaintext data. |
