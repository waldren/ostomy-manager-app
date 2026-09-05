# Architecture

High-level system architecture for the ostomy patient management app.

## Overview
- `apps/mobile` — React Native (Expo) app for iOS/Android
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
- **Production** — AWS, the only environment permitted to hold real PHI.

_Expand with diagrams and sync/data-flow details as the architecture solidifies._
