# Ostomy Patient Management Application

A dual-platform (mobile + web) patient-facing app to help ostomy patients track stoma output, fluid intake, meals, and medications, and to inform patients and their care team on care-plan efficacy. Built offline-first, with a data model designed for future FHIR/EHR interoperability.

See `design-specs/requirements/Ostomy_App_Specification_v1.pdf` for the full v1.0 SRS.

## Repo layout

```
design-specs/   # product & design docs, by type
  requirements/   # SRS, PRD versions, epics & user stories
  user-research/  # interviews, personas, journey maps
  data-model/     # FHIR/RxNorm mapping notes, ERDs
  wireframes/     # low-fi sketches, screen flows
  ui-mockups/     # high-fi mockups (incl. Claude Design exports), design tokens
  compliance/     # HIPAA, security architecture, BAA notes
  decisions/      # ADRs

docs/           # developer/engineering docs (setup, architecture, standards, workflow)

apps/
  mobile/         # Expo React Native app (iOS/Android)
  web/            # React web app
  api/            # backend/API (auth, sync, FHIR + RxNorm integration)

packages/
  ui/             # shared design-system components
  core/           # shared types, business logic, FHIR mapping utilities
  config/         # shared lint/tsconfig/build config

infra/          # deployment, cloud infra, CI/CD
scripts/        # dev tooling scripts
.github/        # CI workflows
```

## Stack
- Mobile: React Native (Expo)
- Web: React
- Monorepo managed with pnpm workspaces

## Getting started
See `docs/getting-started.md`.
