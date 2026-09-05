# CI Workflows

GitHub Actions workflows go here (lint/test/build pipelines, etc.).

- `pr.yml` — lint, typecheck, test and dependency scan on every pull request and on push to `main`. Runs on GitHub-hosted runners.
- `deploy-dev.yml` — builds, migrates, deploys, and health-checks the shared on-premise development stack on push to `main`. Runs on the self-hosted runner (labels `self-hosted`, `linux`, `x64`, `ostomy-dev`) — see `docs/deployment-development.md` "Deployment pipeline" and "Runner operational notes". Does not itself lint, typecheck, or test — but it also has no `needs:`/`workflow_run:` dependency on `pr.yml`; both trigger independently on push to `main` and run concurrently. It assumes `pr.yml` already verified the commit being deployed; that assumption is enforced by branch protection on `main` (an organizational setting), not by anything in either workflow file.
