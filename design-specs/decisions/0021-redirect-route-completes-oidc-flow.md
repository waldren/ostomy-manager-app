# ADR-0021: The redirect route completes the OIDC authorization code flow

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §4.2 | [ADR-0014](0014-local-phi-encryption-and-device-ownership.md) | [ADR-0015](0015-biometric-local-access.md) — **narrowed by this ADR** | [ADR-0020](0020-android-only-v1.md) | issue #72 | `docs/gate-b-walkthrough.md`

## Context

**Sign-in could not complete on Android at all.** Not intermittently — never, on a freshly built development client against the development stack. It was found while trying to reach the Add Urine screen on a device for issue #65, and it had survived Gate B passing, 286 passing mobile tests, and two code reviews.

The authorization half works. The provider issues a code and redirects. From `adb logcat`:

```
START u0 {act=android.intent.action.VIEW cat=[android.intent.category.BROWSABLE]
          dat=ostomydiary://redirect/... cmp=org.ostomy.diary/.MainActivity}
  with LAUNCH_SINGLE_TASK from uid 10160 result code=2
```

`result code=2` is `ActivityManager.START_TASK_TO_FRONT`. The redirect is resolved to **`MainActivity`** — the only component in the merged manifest declaring the `ostomydiary` BROWSABLE filter — and `launchMode="singleTask"` brings its existing task to the front, tearing down the Custom Tab.

`expo-web-browser`'s `BrowserProxyActivity` is what resolves `promptAsync()`. It is `launchMode="singleTop"` and owns no filter for this scheme, so it is never the target. The promise the login flow was awaiting therefore never reported success, `extractAuthorizationCode` returned `undefined`, and `login()` resolved `undefined`.

**The code was never lost.** It arrives in the deep link, which Expo Router hands to `app/redirect.tsx` as ordinary route params — a route that already existed, added at R.S1 for a different reason (without it, a patient whose sign-in succeeded landed on the framework's "Unmatched Route" screen). R.S1 recorded that Android "*also*" delivers the redirect as a deep link. On this platform, with this manifest, it is the *only* delivery that happens.

### Why the tests could not see it

Every auth spec mocks `promptAsync`, so all of them assert what the app does **with** a successful authorization:

- `useOidcLogin.spec.ts` asserts only `REDIRECT_URI_OPTIONS` — the hook's behaviour is untested.
- `AuthContext.spec.tsx` mocks `oidcSession` wholesale.

A green suite was consistent with a feature that did not work, and this is the second time in two sprints that a test mocking the boundary hid the defect at it.

### The failure was also invisible, for a separate reason

`app/login.tsx` already handled a failed sign-in properly: a `LoginFailure` union, catalog copy, and an explicit `AccessibilityInfo.announceForAccessibility` call (with a comment noting that `accessibilityLiveRegion` is Android-only). None of it was seen, because `failure` was React state **local to the route** and the redirect navigates — `/redirect` → `/` → `/login` — remounting the screen and discarding it. The message was written and thrown away in the same moment the patient perceived as a flash.

## Decision

**`app/redirect.tsx` owns completion of the authorization code flow**, and `useOidcLogin` launches it without finishing it.

1. **One completer.** The route reads `code` and `state` from its own params, verifies `state`, exchanges, and calls `AuthContext.completeLogin`. `useOidcLogin` exchanges nothing. An authorization code is single-use, so two completers would mean one of them always failing at the token endpoint — and reporting that failure for a sign-in that had succeeded.

2. **`promptAsync()` is still awaited, for dismissal only.** It is reliable for "the browser went away" and, on this platform, not for a code. Without it a patient who presses Back waits on a completion that is never coming. It is never read for `params.code`.

3. **The PKCE verifier, `state`, and the exact `redirect_uri` are persisted** in `SecureStore` before the browser opens, because the completer did not create the request and may not even be the same process — Android may reclaim the app while the browser is foregrounded.

4. **`state` is verified before any token request.** A completer driven by a URL is reachable by anything that can open a link with this app's scheme; without the check it would exchange a code an attacker supplied (RFC 6749 §10.12).

5. **Sign-in outcome state lives on `AuthContext`, not on the login screen.** Any outcome of an OIDC round trip has to survive the remount the redirect causes.

6. **The native manifest does not change.** `MainActivity` keeps `singleTask` and keeps the filter.

### This ADR narrows ADR-0015

ADR-0015 places on-device auth secrets behind `requireAuthentication`, which maps to Android `setUserAuthenticationRequired` and iOS `biometryCurrentSet`. **The pending-request verifier is deliberately stored without that gate.**

ADR-0015 governs *a stored session belonging to an already-enrolled patient*. This value is read in the middle of **establishing** that session, when there is no session and no identity to authenticate against. A biometric prompt there would gate sign-in on the thing sign-in exists to create — a deadlock, not a safeguard.

The exposure that accepts is small and bounded, and the reasoning is what makes it acceptable rather than merely convenient:

- the value is a **single-use** verifier for one **in-flight** request;
- it is worthless without the matching authorization code arriving at this same app's redirect URI;
- it is deleted the moment the exchange resolves, on **every** outcome including failure;
- `keychainAccessible` is unchanged — still `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so the narrowing is to the biometric gate alone, not to keychain accessibility or device binding.

`pendingAuthRequest.spec.ts` asserts `requireAuthentication` is absent, because "same options as the refresh token" is the obvious and wrong instinct for the next person to touch this file.

### Why not the encrypted SQLite store

ADR-0014 binds that store to one OIDC subject and destroys it when a different subject signs in. At this point in the flow the subject is precisely what has not been established. It is the wrong container by construction.

## Alternatives considered

**Change `MainActivity`'s `launchMode` away from `singleTask`.** A one-line `app.json` change that would let `BrowserProxyActivity` win the race. Rejected: it alters deep-link behaviour for the whole app — every link, every background/foreground resume, the biometric re-lock path — and would require re-validating every Gate B clause, which all run through sign-in. It also fixes the symptom while leaving `MainActivity` as the component the filter resolves to.

**Keep both completers, guarded for idempotency.** Robust to either delivery order, including a platform where the deep link does not fire. Rejected as the primary mechanism: the guard becomes the new thing that can be subtly wrong about a single-use credential, and the dismissal signal gives the same protection against a hang with nothing to keep consistent.

**Code comments instead of an ADR.** Rejected because narrowing ADR-0015 is a rule change, and CLAUDE.md requires a rule change to be recorded as one.

## Consequences

- `useOidcLogin().login()` returns a `SignInLaunchOutcome` (`'launched' | 'dismissed' | 'unavailable'`), not tokens. A caller that wants tokens is asking the wrong object.
- `app/redirect.tsx` is load-bearing auth code and is tested as such (`redirect.spec.tsx`), which the pre-existing specs structurally could not be.
- Sign-in has one path on every platform. If iOS is ever built (ADR-0020 defers it), the same route completes it — the deep link is delivered there too.
- **A dismissal that the platform does not report would hang the flow.** The browser closing is the only signal that no redirect is coming; an OS that reports neither would leave the screen waiting. Not reachable on Android, where `dismiss` is delivered, and the recovery is that the patient can start again.
- The failure taxonomy on the login screen is unchanged in copy and in announcement. Only where the state lives changed.

## Verification

A green suite was consistent with this feature being entirely broken, so the exit criterion is a **recorded device walkthrough** in `docs/gate-b-walkthrough.md` — a real sign-in reaching Home, with the logcat line showing the redirect resolving — and not the test suite alone. The specs exist to stop a regression, not to prove the fix.
