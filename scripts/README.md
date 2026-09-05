# Scripts

Development and build tooling scripts.

- `check-no-committed-env.sh` — CI guard; rejects a committed `.env` and scans every `.env.example` for anything that looks like a real credential. Run via `pnpm check:env`.
- `dev-reset.sh` — wipes and recreates the shared Docker Compose development stack (`infra/docker-compose.yml`). See `docs/deployment-development.md` "Database lifecycle".
