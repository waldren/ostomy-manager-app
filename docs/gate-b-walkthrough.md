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

---

## Run 3, continued — 2026-09-20: unblocked, five of six clauses closed

The 401 above was **my own regression**, introduced by the audience fix (#58).

### What the 401 actually was

Supplying **any** `JSON_CONFIG` to mock-oauth2-server turns `interactiveLogin` off by default. With it off, the authorize endpoint skips the login form and mints a token with **no `sub` claim**. `apps/api`'s guard verifies the signature, issuer and audience successfully, then rejects it with `MISSING_SUBJECT_CLAIM` — a 401 on an otherwise perfect token. That is why the app's token was 637 chars against curl's 670: the missing claim *was* the missing bytes.

The measurement that settles it:

```
WITH login form: len=670  sub='gate-b-patient-1'  -> 200
NO login form:   len=637  sub=None                -> 401
```

Adding `"interactiveLogin": true` restores the form and the claim.

**A second defect in the same fix:** the mapping matched `client_id: ostomy-patient-app`, but the patient issuer serves **two** clients — the mobile app and the web SPA (`ostomy-web`). The web SPA would have hit the identical 401. The mapping now matches `grant_type` with a wildcard, so both clients get `aud: ostomy-patient-app`.

### Clause results

| # | Clause | Result | Evidence |
| - | ------ | ------ | -------- |
| 1 | Airplane-mode entry, save confirms instantly | **PASS** | Airplane mode on; 450 mL Measured; "Saved on this phone." and "1 entry has not been sent yet." with no network |
| 2 | Reconnecting syncs the entry | **PASS** | Server row: LOINC `79560-9`, `450.0000`, `method 258104002`, one `sync/push` |
| 3 | An audit row carries before/after | **PASS** | `CREATE`, `reason_code sync_applied`, `actor_id gate-b-patient-1`, full `after_value` incl. `enteredMeasurementSystem: METRIC` |
| 4 | A forced conflict puts the loser in the audit log | **PASS** | Older-timestamped update returned `superseded`; audit row `UPDATE` / `sync_conflict_loser` with the losing 999 mL version in `before_value` and `after_value` null |
| 5 | An invalid queued operation reaches the correction inbox | **PASS** | Clock skewed past ADR-0019's allowance; entry rejected server-side (absent from `observations`) and surfaced as "This entry could not be saved. Please check it." with Fix / Delete |
| 6 | The web view renders the entry with its Measured/Estimated badge | **BLOCKED** | **Issue #60** — `apps/api` never enables CORS |

### Clause 6's blocker

Signed into `apps/web` in a real browser, the view renders its shell then shows "We could not load stoma output right now." The API logs `200` for the same request the browser reports as blocked:

```
Access to fetch at 'http://localhost:3000/api/v1/observations?...' from origin
'http://localhost:8088' has been blocked by CORS policy
```

`grep -rn "enableCors" apps/api/src` returns nothing. **`apps/web` has never loaded data from the API in a browser** — its 130 tests all mock `fetch`, so the suite has only ever asserted against a stand-in for the thing that is broken. Same shape as #55.

This is left unfixed deliberately: `app.enableCors()` would silence it, and CORS on a PHI API with two disjoint identity pools deserves a considered, config-driven allowlist rather than a one-line patch inside a walkthrough. See #60.

### Two mistakes in this run, recorded because they nearly became false passes

- **Clause 5 was asserted wrongly twice.** I checked whether my entries reached the server by volume (`275`, `312`) and got `count = 1` both times — but those were *seeded* rows that happened to share the values. Querying by `created_at` showed my entries were never stored, i.e. correctly rejected. Matching on a non-unique clinical value against a seeded database is not an assertion.
- **A stray tap hit "Sign out"** after the home screen's layout shifted, and only ADR-0014's unsent-entry warning ("1 entry is still only on this phone. Signing out removes it for good.") stopped the test state being destroyed. The control earned its place.

### Environment facts this run established

- `adb root` restarts the device's adb daemon and **silently drops every `adb reverse` forward**. The app then fails OIDC discovery with `Failed to connect to localhost:8090`, and nothing syncs until the forwards are re-added.
- Chrome's cookies survive `pm clear` on the *app*, so a second sign-in reuses the IdP session and skips the login form. With `interactiveLogin` off that produced the sub-less token above.

---

## Run 4 — 2026-09-23: CORS fixed, clause 6 closed, **GATE B PASSES**

All six clauses pass. This is the first time the gate has been met.

### What was fixed

`apps/api` never enabled CORS (#60), so `apps/web` had never loaded data from the API in a browser — the API logged `200` for requests the browser discarded. Added as a **config-driven allowlist**, not `app.enableCors()`:

- `CORS_ALLOWED_ORIGINS`, comma-separated, validated at startup as **bare origins** (`new URL(value).origin === value`). A trailing slash, a path, a query — all rejected, because a browser's `Origin` header carries none of them, so such an entry can never match and presents as "CORS is broken" with nothing naming the cause.
- **No wildcard, and no way to express one.** This API serves PHI; `Access-Control-Allow-Origin: *` would let any page read a patient's clinical values given a token obtained by any means.
- **Empty by default**, meaning no cross-origin access at all — and CORS is not enabled at all in that case, which is what every non-browser client already expects.
- `credentials: false`. Tokens travel in the `Authorization` header, never cookies.

**This is not the admin/patient boundary.** That boundary is the two disjoint identity pools and the structurally separate guards (SRS_v2 §4.6). Listing both SPA origins does not let a patient token reach `/api/v1/admin/...`; `AdminJwtAuthGuard` rejects it on issuer and audience. Removing an origin here is a browser-access change, not a security-boundary change — and the code says so, so nobody later mistakes the allowlist for the boundary.

Verified directly before touching the browser:

```
Origin: http://localhost:8088    -> Access-Control-Allow-Origin: http://localhost:8088
Origin: http://evil.example.com  -> (no Access-Control-Allow-Origin header)
```

### Clause 6

Signed into `apps/web` in a real browser, at the day the device's entry belongs to:

```
1 entry loaded for September 20, 2026.
Sep 20, 2026, 2:20 PM UTC | 450 mL | [Measured]
Total stoma output for this day: 450 mL
```

The badge renders as an icon plus text, not colour alone (AC 2.2 AC2). The page also shows Daily Net Fluid Balance as `-450 mL` with its one-sided-day caveat ("No fluid intake was recorded for this day … not a complete balance") and the urine-exclusion note (SRS §3.7). No console errors.

That entry is the same one created on the device in airplane mode for clause 1 — so clauses 1, 2, 3 and 6 are one continuous arc through the system, not six separate demonstrations.

### Final clause status

| # | Clause | Result |
| - | ------ | ------ |
| 1 | Airplane-mode entry, save confirms instantly | **PASS** |
| 2 | Reconnecting syncs the entry | **PASS** |
| 3 | An audit row carries before/after | **PASS** |
| 4 | A forced conflict puts the loser in the audit log | **PASS** |
| 5 | An invalid queued operation reaches the correction inbox | **PASS** |
| 6 | The web view renders the entry with its Measured/Estimated badge | **PASS** |

**Gate B is met.** Plan revision 2's rule holding P3 feature sprints behind an unblocked Gate B run is satisfied; P3.S2 can be dispatched.

### What this still does not prove

An emulator run, recorded as such. It closes **none** of HW-1..HW-10 in [`gate-b-hardware-verification.md`](gate-b-hardware-verification.md), and does not touch CLAUDE.md's "not verified on hardware" caveat. The AVD reports `hardware_keystore` but never `strongbox_keystore` — KeyMint in software.

Two defects found during the runs remain open and were **not** fixed by passing the gate: #59 (the sync worker's first cycle after cold start still runs with no token, and clauses only passed because a manual foreground produced an authenticated one) and #40.

---

## Run 5 — sign-in on a device, after ADR-0021 (2026-09-25)

Not a Gate B run. A single-purpose walkthrough recording the fix for **#72**,
because a green test suite was consistent with sign-in being **entirely broken on
Android** and could not be the evidence.

### What was broken

Tap Sign in, authorize at the provider, and the app returned to the **login
screen** with no session and no message. Reproduced by hand by the repo owner and
under automation, on a clean `wipe`.

The authorization half always worked — the provider issued a code and redirected.
`adb logcat`:

```
START u0 {act=VIEW cat=[BROWSABLE] dat=ostomydiary://redirect/...
          cmp=org.ostomy.diary/.MainActivity} with LAUNCH_SINGLE_TASK
          result code=2
```

`result code=2` is `START_TASK_TO_FRONT`. The redirect resolves to
`MainActivity` — the only component owning the `ostomydiary` BROWSABLE filter —
and `singleTask` brings its task forward, tearing down the Custom Tab.
`BrowserProxyActivity`, which is what resolves `promptAsync()`, is never the
target. The hook awaiting that promise never saw success.

### Three defects, found in this order, each hiding the next

**1. The completer was in the wrong place.** Fixed by ADR-0021: the redirect
route reads the code from its own params and exchanges it. `result code=2` still
appears in the log after the fix — the fix works *with* the platform's behaviour
rather than changing it, which is why no native config changed.

**2. The route navigated away before it could finish.** My own bug, and only a
device showed it. `<Redirect href="/" />` rendered unconditionally, so the route
unmounted before `useAutoDiscovery`'s async fetch resolved. Instrumented trace:

```
[T72] effect discovery= NULL params= {"code":"aU6Buk-…","state":"yxDDZOrkW7"}
```

The code and state arrived correctly and were dropped on the floor. The route now
holds — rendering a "Finishing sign in" screen — and redirects only once the work
is done.

**3. `completeLogin` cannot store a refresh token on a device with no biometric
enrolment.** Not #72, and not introduced by this change:

```
[T72] EXCHANGE FAILED: 'ExpoSecureStore.setValueWithKeyAsync' has been rejected.
→ Caused by: Could not Authenticate the user: No biometrics are currently enrolled
```

That is `setRefreshToken` with ADR-0015's `requireAuthentication: true`. The
exchange had already succeeded. Enrolling a fingerprint
(`android-emulator.sh fingerprint`) let sign-in complete. **A patient whose phone
has no enrolled biometric appears unable to sign in at all** — filed separately;
see below.

### The result

| Step | Observed |
| ---- | -------- |
| Tap Sign in | Chrome Custom Tab opens on `localhost:8090`, hostname preserved by `adb reverse` so `iss` matches |
| Submit `gate-b-patient-1` | Provider redirects to `ostomydiary://redirect` |
| Redirect | Route holds, reads `code` + `state`, verifies state, exchanges |
| `completeLogin` | OS biometric sheet; `emu finger touch 1` |
| Landing | **"You are signed in"**, with Add a stoma entry / Add a drink / **Add a urine entry** / Add a meal |

P3.S2's Add Urine button rendering on a device is the first time any of that
sprint has been seen outside jest.

The session is real, not local: **20 × `"statusCode":200`** from `apps/api` in the
three minutes after landing. (Also one `403`, consistent with #59's
unauthenticated first sync cycle.)

### The failure path was verified too, before the fix was complete

While the exchange was still failing, the login screen rendered *"We could not
sign you in. Please try again."* with a Try again button — proving the other half
of ADR-0021 on the device: a failure reported from the redirect route **survives
the remount** that route's own navigation causes. Before this change that message
was written to `login.tsx`'s local state and discarded in the same moment, which
is why #72 presented as "the screen flashes".

### What this does not prove

An emulator run, recorded as such. It closes **none** of HW-1..HW-10 and does not
touch CLAUDE.md's "not verified on hardware" caveat — the AVD reports
`hardware_keystore` and never `strongbox_keystore`.

It also says nothing about TalkBack. #65 is now **reachable** — Add Urine can be
opened on a device for the first time — but not done.

### Opened by this run

- The no-biometric-enrolment sign-in block (finding 3), which is a product
  question about ADR-0015, not an emulator artifact.
- A spec file placed in `apps/mobile/app/` becomes a **route**: Expo Router
  enumerates that directory with `require.context`, so the spec pulled
  `@testing-library/react-native` into the app bundle and the bundle stopped
  loading, with an error naming neither the file nor the reason. Every other
  mobile spec already lives under `src/`; the redirect route's spec is now
  `src/auth/redirectRoute.spec.tsx`.

---

## Run 6 — Add Urine with TalkBack (#65), 2026-09-25

Not a Gate B run. The accessibility walkthrough #65 asked for, on the AVD, with
TalkBack enabled and driving.

**Method matters here.** With touch exploration on, a single tap moves
accessibility focus and does **not** activate; every action below was performed
with the TalkBack gesture — focus, then double-tap. So the screen was driven the
way a blind patient drives it, not merely inspected.

### The leading question: does the radiogroup collapse its options? — NO

This was #65's first check, because a "yes" would have meant AC 12.1 AC3's fix was
unreachable rather than imperfect: on Android a `ViewGroup` carrying a
`contentDescription` can become a single accessibility-focus target that hides its
children, and `getAllByRole('radio')` is a JS-tree query that cannot see it either
way.

`uiautomator dump` — the tree an accessibility service navigates — shows **six
independent `RadioButton` nodes**, each `focusable`, `clickable`, and carrying its
own accessible name:

```
RadioButton desc='Almost clear — lightest'  [focusable clickable checked=false]
RadioButton desc='Pale yellow'              [focusable clickable checked=false]
RadioButton desc='Yellow'                   [focusable clickable checked=false]
RadioButton desc='Darker yellow'            [focusable clickable checked=false]
RadioButton desc='Orange-brown'             [focusable clickable checked=false]
RadioButton desc='Brown — darkest'          [focusable clickable checked=false]
```

Six reachable stops, six distinct names, no collapse. Removing the group's
redundant `accessibilityLabel` (P3.S2 re-review) was the right call and this is the
evidence for it.

### AC 12.1 AC2, performed entirely through TalkBack

| step | observed |
| ---- | -------- |
| Open Add Urine | the screen renders with the scale |
| Focus + double-tap "Orange-brown" | that node becomes `checked=true`; the other five stay `checked=false`, and the node gains a third child — the check mark `ChoiceGroup` uses as its non-colour signal |
| Focus + double-tap Save | **"Saved on this phone."** |

A colour-only voided-urine entry, created by a screen-reader user, with no amount.
That is the entry the whole feature exists for.

### Fixes from the P3.S2 review, confirmed on the device

- **Save is present-and-disabled with its reason stated.** Before a colour is
  picked: `Button desc='Save entry' [DISABLED]`, with "Add an amount or pick a
  colour. Then you can save this entry." An absent button was the original
  behaviour and read as "this form has no way to finish".
- **The amount label names its noun** — "How much urine did you pass? (optional)".
- **The hint warns the toggle is coming** — "…If you do enter an amount, you will
  say next whether you measured it."
- **The direction of the scale is a visible `Text` node**, not only a hint: "The
  list goes from lightest to darkest." It therefore survives a TalkBack user
  having hints switched off, which was the reviewer's specific point.
- **`entry.urineColorUnavailable` renders and is honest.** Seen for real while the
  cache was empty: "We could not load the colour choices yet. For now, you will
  need to enter an amount to save this entry." The shared string it replaced ended
  "You can still save your entry without them", which would have been false.

### What this run did NOT establish

**Verbatim speech.** The plan was to capture TalkBack's utterances from
`SpeechControllerImpl` at VERBOSE. TalkBack is genuinely running and speaking —
it is bound with `FEEDBACK_SPOKEN`, `touchExplorationEnabled=true`, and
`MediaFocusControl` records it taking audio focus through
`SpeechControllerImpl` — but the release build does not log utterance text, and
`setprop log.tag.SpeechControllerImpl VERBOSE` does not change that. So the
**names, order and reachability** of the six steps are established; the exact
spoken string for each is not.

Three questions therefore remain open on #65 and cannot be closed from here:

1. **Whether the em-dashes in the two end labels are spoken usefully.** "Almost
   clear — dash — lightest" would be worse than a comma. Device- and
   engine-dependent.
2. **Whether the per-option "Step N of 6" hints are announced at all**, and at
   tolerable length. `accessibilityHint` is not exposed in `uiautomator dump`, so
   their presence on the node is not observable this way either.
3. **Whether the ordering is actually perceivable** from labels plus group hint
   plus step numbers. That is a judgement about how people hear words and belongs
   in SRS §5.4's pre-launch usability review (#67), not to any log.

**And this is an emulator.** It closes none of HW-1..HW-10 and does not touch
CLAUDE.md's "not verified on hardware" caveat.

### Two defects this run found, neither in the app's accessibility

- **#76 — the dev host was three merges stale.** `Deploy dev` has never run: zero
  self-hosted runners are registered. Add Urine first rendered "We could not load
  the colour choices yet" because the deployed API predated P3.S2 and had neither
  the migration nor the `urine_color` value set. The client was behaving correctly
  and saying so; the server had nothing to give it. I rebuilt the API container by
  hand to proceed.
- **#77 — both sync endpoints return 403**, on the same token that succeeds
  against `/value-sets` and `/thresholds`. The entry above confirmed locally and
  never reached the server: `observations` holds no `9187-6` row. **Gate B clause
  2 would fail today**, having passed in run 4.

Also worth noting for the next person: the value-set cache only populated after a
background/foreground cycle, which is #59's known shape — the first sync cycle
after a cold start runs unauthenticated and never retries. The screen reads its
cache once on mount, so Add Urine had to be re-entered after the cache filled.
