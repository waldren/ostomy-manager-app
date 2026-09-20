# Gate B walkthrough — run log

Gate B is the first demonstrable milestone ([`v1-implementation-plan.md`](../design-specs/planning/v1-implementation-plan.md)): one live walkthrough, from an entry made in airplane mode to that entry rendered in the web view. Sprint **R.S1** exists because the gate had never been run — P3 feature work proceeded past it — and revision 2 of the plan made running it blocking.

This file is the record. A clause closes on an observed run, never on an argument that it ought to work.

---

## Run 1 — 2026-09-19, emulator

**Result: BLOCKED. No clause was reached.** ~~Sign-in cannot complete on the mobile client~~, and every clinical screen sits behind sign-in.

> **Corrected by Run 2:** sign-in *does* complete. What failed was where the app landed afterwards. The struck text is left visible rather than deleted so the correction is findable from the claim it replaces.

**Environment.** Windows host; Compose stack rebuilt from `main` at `a87561f` and healthy (8 migrations, none pending); `stable-ileostomy` seeded (1 patient `gate-b-patient-1`, 450 observations); Pixel_8 AVD, API 36; `apps/mobile` debug build installed from `app-debug.apk`; Metro on host 8082.

Recorded as an **emulator** run. It does not touch CLAUDE.md's hardware caveat and closes none of HW-1..HW-10 in [`gate-b-hardware-verification.md`](gate-b-hardware-verification.md).

### Clause status

| # | Gate B clause | Status |
| - | ------------- | ------ |
| 1 | Airplane-mode entry, save confirms instantly from the local write | **Not reached** — blocked on sign-in |
| 2 | Reconnecting syncs the entry | **Not reached** |
| 3 | An audit row carries before/after | **Not reached** |
| 4 | A forced conflict puts the loser in the audit log | **Not reached** |
| 5 | An invalid queued operation surfaces in the correction inbox | **Not reached** |
| 6 | The web view renders the entry with its Measured/Estimated badge | **Not reached** |

### What was found on the way

Four defects, in the order they blocked the run. Three are fixed in this sprint; the fourth is the blocker.

**1 — `makeRedirectUri()` produced an illegal redirect URI. FIXED.**

`AuthSession.makeRedirectUri()` with no arguments returns the bare scheme `ostomydiary://` — no authority, no path, not a legal absolute URI. mock-oauth2-server refused the authorization request before any user interaction:

```
com.nimbusds.oauth2.sdk.ParseException: Illegal redirect_uri parameter
{"error_description":"invalid request: illegal redirect_uri parameter","error":"invalid_request"}
```

So sign-in could never have worked against the development stack. **The unit tests had always used `ostomydiary://redirect` as their fixture** — a legal URI with a path — so they asserted a value the app never produced, and the suite stayed green throughout. `useOidcLogin.ts` has no spec of its own. This is plan risk R8 ("verification is weaker than it looks") in its most literal form.

Fixed by passing `scheme` and `path` explicitly. The authorization endpoint now accepts the request and issues a code.

**2 — The AVD could not complete an OIDC flow at all. FIXED.**

`scripts/android-emulator.sh` built the AVD from the `default` system image. That image ships **no browser providing Custom Tabs** — only `com.android.webview` and the Chromium shell. `WebBrowser.openAuthSessionAsync` needs a Custom Tabs provider.

The original reasoning for `default` was sound and is preserved in the script: nothing here talks to a Google service, and the Play image forbids `adb root`. What it missed is that `google_apis` keeps `adb root` *and* ships Chrome, so it satisfies both constraints rather than trading one away. The script now uses `google_apis`.

Note for the skill: `.claude/skills/android-emulator/SKILL.md` claims the emulator "genuinely exercises … the OIDC browser redirect". On the old image there was no browser to redirect through.

**3 — Metro's port guidance does not work on an existing dev build. FIXED (documented).**

The skill says to start Metro on 8082 (the admin SPA holds host 8081) and `adb reverse tcp:8082 tcp:8082`. But an already-built dev build has `localhost:8081` baked in as its bundler URL, asks for 8081, reaches the admin SPA and dies with "Unable to load script". The working form is `adb reverse tcp:8081 tcp:8082` — the device's 8081 maps to the host's 8082, and the admin container is untouched.

**4 — Sign-in appeared not to complete. THE BLOCKER at the time — issue #55.**

> **CORRECTED IN RUN 2. The finding below is wrong where it says the token exchange never happens.** It does. Sign-in completes; the app was landing on the wrong screen afterwards. The original text is kept rather than rewritten, because how the wrong conclusion was reached is the useful part — see "What Run 1 got wrong" under Run 2.


With a legal redirect URI and a real Custom Tab, the flow gets further and still fails:

1. The authorization request is accepted; the mock IdP renders its sign-in page in a Chrome Custom Tab.
2. Submitting the subject redirects to `ostomydiary://redirect?code=…&state=…`.
3. The app receives it as an ordinary deep link. **Expo Router has no route for `/redirect` and renders "Unmatched Route".**
4. `promptAsync()` never resolves, so `exchangeAuthorizationCode` never runs. mock-oidc logs **no `/token` request** — confirmed from the server side, not inferred from the screen.

Ruled out during diagnosis:

- *Cold start losing the pending promise.* The app kept PID 3597 throughout; `ActivityManager` shows only `freezing` while Chrome was foreground and `sync unfroze` when the deep link arrived. No restart.
- *Missing Custom Tabs provider.* `com.android.chrome` is installed and the Custom Tab UI is visibly present.
- *Missing `maybeCompleteAuthSession()`.* It is called at module scope in `src/auth/oidcSession.ts`.
- *Illegal redirect URI.* Fixed above; authorization now succeeds and issues a code.

Not established: whether Expo Router consumes the deep link before `expo-auth-session`'s listener, or whether `openAuthSessionAsync`'s interception simply does not match this redirect. There is no route file for the redirect path and no `Linking` handling anywhere in `apps/mobile`. That diagnosis is issue #55's work, not this walkthrough's.

### What this means

> **Corrected by Run 2.** The paragraph below overstates the finding: sign-in completed, and the token exchange worked. What had never been done was *reaching a signed-in screen* — the redirect landed on "Unmatched Route". The conclusion in the second paragraph survives the correction; the first does not.

~~**`apps/mobile` has never completed an OIDC sign-in against the development stack.**~~ **No one had ever reached a signed-in screen in `apps/mobile` against the development stack.** P2.S2a shipped the auth substrate, P2.S2b the sync worker, P3.S1 three entry screens — all behind a redirect that dead-ended, on a suite that was green the whole time.

That is the finding Gate B exists to produce, and it arrived three sprints later than it should have. The plan's own conclusion (revision 2, §3.2 decision 2) stands: a gate that nothing makes blocking is not a step anyone has to take.

### Next

Run 2 follows issue #55. Nothing else in Phase R depends on it — R.S2 has merged and R.S3 is independent — but **no P3 feature sprint should be dispatched until Gate B has an unblocked run**, for the same reason the gate was made blocking in the first place.

---

## Run 2 — 2026-09-19, emulator

**Result: still BLOCKED, on a different and newly identified cause.** Clause 1 was reached and could not be completed. Clauses 2-6 not reached.

### What Run 1 got wrong

Run 1 concluded that OIDC sign-in never completes and that no token exchange happens. **Both are false.** Instrumenting the flow showed, in order: `promptAsync` returning `success`, the authorization code extracted, and `exchangeCodeAsync` returning tokens with an access token present.

The faulty evidence was a `docker compose logs mock-oidc | grep -i token` that returned zero hits. mock-oauth2-server does not log token requests at that level, and **an absence of log lines was read as proof of an absence of requests**. It is the same mistake this document criticises elsewhere: treating a green signal as coverage without checking what the signal actually observes.

The symptom Run 1 described was real. The diagnosis attached to it was not.

### The actual defect, and the fix

The OIDC redirect returns to the app as an ordinary deep link *in addition to* resolving `promptAsync()`. Expo Router routes on it, had no route for the redirect path, and rendered "Unmatched Route" — so a patient whose sign-in had fully succeeded, holding a live session, was looking at a page-not-found screen.

`app/redirect.tsx` is the fix: a landing pad that redirects to `/`, leaving `index.tsx` as the single owner of the "which screen does this phase mean" rule. Sending it straight to `/home` would have duplicated that rule and shown the home screen to a patient whose exchange had not finished or had failed.

**Verified on the device:** sign-in now reaches "You are signed in".

### The new blocker

`GET /api/v1/thresholds`, `/api/v1/sync/delta` and `/api/v1/value-sets` all return **401**. `validation_thresholds_cache` is deliberately unseeded (CLAUDE.md), so an unfetched cache blocks the save — the Add Output screen renders but cannot save, and clause 1 cannot complete.

One contributing cause found and corrected, which was **not** sufficient on its own:

- `.env` had `DEV_HOST_ADDRESS=127.0.0.1` while the device reaches the IdP as `localhost:8090` through `adb reverse`. The API compares `iss` by exact string equality, so `http://127.0.0.1:8090/patient-issuer` and `http://localhost:8090/patient-issuer` are different issuers — a valid signature, rejected anyway. `.env.example` documents this trap and warns against both `localhost` and `127.0.0.1`; for the emulator path the value must be exactly what the device uses. Corrected locally (`.env` is gitignored). **The 401s persisted**, so this was not the whole cause.

**Prime remaining suspect, and it is a recorded assumption rather than a mystery.** `apps/mobile/.env.example` states that mock-oauth2-server's issued `aud` equals the authorization request's `client_id` verbatim, and says in terms: *"Verify this empirically the first time this app runs against the real compose stack; if mock-oauth2-server's default `aud` behaviour differs, this is the one value to change."* This walkthrough is that first time, and the assumption is still unverified. A directly minted token confirmed the API's audience check does reject a token whose `aud` is absent.

### Other findings

**A copy defect that misdirects the patient.** The empty-thresholds-cache state renders `common.startupErrorBody` — "Something went wrong while opening your diary on this phone. Close the app and open it again. If that does not work, sign in again." Closing and reopening cannot help; what is needed is a successful threshold fetch while online. The condition is `cached === null` in `app/add-output.tsx` and `app/add-intake.tsx`, which is the thresholds cache, not the database.

**Two environment constraints this walkthrough has to respect, neither previously recorded.**

- **Sign-in requires a secure lock screen.** ADR-0015 stores the refresh token with `requireAuthentication`, which on Android needs one; a fresh AVD has none, and sign-in fails with no message saying why. `scripts/android-emulator.sh fingerprint` establishes it.
- **A development build cannot cold-start in airplane mode**, because its JS bundle is served by Metro over the network. The app must be launched and loaded *before* going offline — which is a property of the dev build, not of the product.

**Behaviour observed and worth recording as expected:** on cold start the app presents "Welcome back / Unlock your diary", then two OS biometric prompts in succession — the app's own `authenticate()` gate, and the OS gate on reading the `requireAuthentication` refresh token. ADR-0015 predicts exactly this pair.

### Clause status

| # | Gate B clause | Status |
| - | ------------- | ------ |
| 1 | Airplane-mode entry, save confirms instantly | **Reached, not completed** — thresholds cache empty, save blocked |
| 2 | Reconnecting syncs the entry | Not reached |
| 3 | An audit row carries before/after | Not reached |
| 4 | A forced conflict puts the loser in the audit log | Not reached |
| 5 | An invalid queued operation reaches the correction inbox | Not reached |
| 6 | The web view renders the entry with its Measured/Estimated badge | Not reached |

### Next

Resolve the 401. Verify the `aud` claim the device's token actually carries against `OIDC_AUDIENCE` — that is the one recorded assumption standing between this run and clause 1, and confirming or refuting it is a single observation, not an investigation.

---

## Run 3 — 2026-09-20, emulator

**Result: still BLOCKED. Clause 1 reached, not completable. Clauses 2–6 not reached.**

The `aud: "default"` fix (#58) is real and verified — a token minted by curl against this stack is accepted by the API and `/thresholds` returns its values. **It did not unblock the app**, which turns out to have a second, independent problem in the same area.

### Confirmed: the sync worker fires before the token exists, and does not retry

Instrumenting the worker's token accessor and correlating with the API's access log, on every cold start:

```
06:10:38  worker token segments=0 len=0     <- two calls, NO token
06:10:42  refreshed aud="ostomy-patient-app"  <- token arrives, 4s later
06:10:54  worker token segments=3 len=637   <- only after a manual foreground
```

So the app issues `/sync/delta`, `/thresholds` and `/value-sets` **unauthenticated** at startup, and **no further cycle runs on its own** — no retry was observed in 80 seconds of idling. `AuthContext.unlock()` sets `phase` to `authenticated` *before* the refresh completes, so `SyncProvider`'s "becoming authenticated" trigger fires against a state that has no token yet, and the token's later arrival is not itself a trigger.

This is the same shape as #40: a phase that claims more than the session can back. Its consequence here is that a patient who was offline gets no thresholds, and the deliberately-unseeded cache correctly refuses to let them save.

### Unresolved: the app's token is rejected where an equivalent one is accepted

Even with a token present, all three endpoints still return 401. What is established:

- the app's token is a well-formed JWT, 3 segments;
- the refresh path's token carries `aud: "ostomy-patient-app"` and the correct `iss` — logged from the device;
- a token minted by curl against the same issuer, **670 chars**, is accepted (200, with the thresholds payload) and is still accepted five minutes later, so neither expiry nor JWKS staleness explains it;
- the app's token is consistently **637 chars** — a different claim set from anything this IdP produces for curl;
- clocks on host, device, API container and IdP container agree exactly;
- `kid` is `patient-issuer` on both sides, and the JWKS advertises exactly that key.

**Tried and refuted:** widening the `requestMappings` match from `client_id` to a `grant_type` wildcard, on the theory that expo-auth-session's code exchange omits `client_id` as a form param. The app's token stayed 637 chars and still 401'd, so that was not the cause. The change was reverted rather than left in unverified.

**What the next attempt needs** is the API's side of the story: the guard throws `UnauthorizedException({ code: mapVerificationError(error) })`, so the 401 body already names the reason — issuer, audience, expiry, signature or missing subject. Nothing logs it and the client discards it. Capturing that one code turns this from a search into a lookup, and is a better next step than any further guessing from the client side.

### Clause status

| # | Gate B clause | Status |
| - | ------------- | ------ |
| 1 | Airplane-mode entry, save confirms instantly | **Reached, not completable** — thresholds cache empty |
| 2 | Reconnecting syncs the entry | Not reached |
| 3 | An audit row carries before/after | Not reached |
| 4 | A forced conflict puts the loser in the audit log | Not reached |
| 5 | An invalid queued operation reaches the correction inbox | Not reached |
| 6 | The web view renders the entry with its Measured/Estimated badge | Not reached |

### Environment notes earned in this run

- Chrome remembers the mock IdP session, so a second sign-in **skips the login form entirely** and goes straight to the OS biometric prompt. Blind tap sequences written for the first sign-in will land on that prompt and fail the sign-in. Check `dumpsys window | grep mCurrentFocus` between steps rather than assuming a screen.
- A Metro process can survive its shell being killed, keep answering `packager-status:running`, and still fail to serve a bundle. Fetch an actual bundle before trusting it.
