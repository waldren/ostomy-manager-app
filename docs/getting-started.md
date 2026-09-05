# Getting Started

Local setup and prerequisites for working on the ostomy patient management app.

## Prerequisites
- Node.js (LTS) and pnpm
- Expo CLI (for `apps/mobile`)
- Docker with the Compose plugin, if running the stack locally rather than against the shared development server

## Repo layout
This is a monorepo (`apps/*` for mobile, web, and the API; `packages/*` for shared code). See the root `README.md` for the full layout and `docs/architecture.md` for how the pieces fit together.

## Running the apps
- Mobile (Expo): `TBD` — set `EXPO_PUBLIC_API_URL` to the development server's LAN address; the test device must be on the same network
- Web: `TBD`
- API: `TBD`

_Fill in exact commands once each app is scaffolded._

## Shared development environment
A single shared, fully containerized stack runs on an on-premise server — API, PostgreSQL, MinIO, a mock OIDC provider, and both SPAs — reachable over the LAN. It holds synthetic data only and is safe to reset at any time. See `deployment-development.md` for how it is built, deployed, and reseeded.
