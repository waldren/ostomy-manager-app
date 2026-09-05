# Scripts

Development and build tooling scripts.

- `check-no-committed-env.sh` — CI guard; rejects a committed `.env` and scans every `.env.example` against a fixed prefix list (AWS/GitHub/Slack/Stripe-shaped keys, a JWT, a PEM private-key header, credentials embedded in a URL). That is a fast, dependency-free tripwire for those specific shapes — not a general "is this a real credential" scanner, and it will not catch an ordinary password. Run via `pnpm check:env`.
- `dev-reset.sh` — wipes and recreates the shared Docker Compose development stack (`infra/docker-compose.yml`). See `docs/deployment-development.md` "Database lifecycle". Committed with the executable bit set (`chmod +x`, required on the Ubuntu host); also runnable as `pnpm dev:reset` from any checkout, including Windows, where the executable bit doesn't survive a clone.
