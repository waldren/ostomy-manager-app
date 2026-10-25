# Architecture

High-level system architecture for the ostomy patient management app.

## Overview
- `apps/mobile` — React Native (Expo) app, **Android only in v1** (iOS deferred, [ADR-0020](../design-specs/decisions/0020-android-only-v1.md))
- `apps/web` — React web app
- `apps/api` — backend/API: auth, sync, FHIR + RxNorm integration
- `packages/ui` — shared design-system components used by mobile and web
- `packages/core` — shared types, business logic, FHIR mapping utilities, validation
- `packages/config` — shared lint/tsconfig/build config

## Key design constraints (from the SRS)
- Offline-first: local database on-device (SQLite/Realm), syncs to the cloud API when connectivity returns.
- Data model maps to FHIR R4 `Observation` (see `design-specs/data-model/`).
- Medications keyed by RxNorm RXCUIs.
- HIPAA compliance is a day-one requirement, not a later add-on (see `docs/security-hipaa.md`).

## Environments
- **Development** — on-premise Docker Compose, no AWS dependency. See `deployment-development.md`.
- **Staging** — AWS, mirrors production; the parity gate for everything development cannot exercise.
- **Production** — the only environment permitted to hold real PHI. It is either the AWS shape (SRS §4.6), or one self-managed Linux host under Docker Compose ([ADR-0022](../design-specs/decisions/0022-self-hosted-production-on-one-host.md)). A self-managed host is initialised as synthetic or real and never changes class. A real one needs every item in `compliance/real-data-readiness.md` signed off first.

_Expand with diagrams and sync/data-flow details as the architecture solidifies._
