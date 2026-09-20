# Gate B walkthrough — run log

Gate B is the first demonstrable milestone ([`v1-implementation-plan.md`](../design-specs/planning/v1-implementation-plan.md)): one live walkthrough, from an entry made in airplane mode to that entry rendered in the web view. Sprint **R.S1** exists because the gate had never been run — P3 feature work proceeded past it — and revision 2 of the plan made running it blocking.

This file is the record. A clause closes on an observed run, never on an argument that it ought to work.

---

## Run 1 — 2026-09-19, emulator

**Result: BLOCKED. No clause was reached.** Sign-in cannot complete on the mobile client, and every clinical screen sits behind sign-in.

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

**4 — OIDC sign-in still does not complete. THE BLOCKER — issue #55.**

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

**`apps/mobile` has never completed an OIDC sign-in against the development stack.** P2.S2a shipped the auth substrate, P2.S2b the sync worker, P3.S1 three entry screens — all behind a sign-in that could not succeed, on a suite that was green the whole time.

That is the finding Gate B exists to produce, and it arrived three sprints later than it should have. The plan's own conclusion (revision 2, §3.2 decision 2) stands: a gate that nothing makes blocking is not a step anyone has to take.

### Next

Run 2 follows issue #55. Nothing else in Phase R depends on it — R.S2 has merged and R.S3 is independent — but **no P3 feature sprint should be dispatched until Gate B has an unblocked run**, for the same reason the gate was made blocking in the first place.
