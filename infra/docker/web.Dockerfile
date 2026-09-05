# syntax=docker/dockerfile:1
#
# Placeholder image for apps/web, which is not yet scaffolded (see
# design-specs/planning/v1-implementation-plan.md, P2.S3). Serves a static
# "not yet deployed" page so `docker compose up` produces a complete
# environment now, per docs/deployment-development.md's "Frontends" row.
#
# Replace this single-stage placeholder with the real multi-stage build
# described in docs/deployment-development.md ("Image build") once
# apps/web exists: deps -> build -> nginx runtime, same shape as
# infra/docker/api.Dockerfile's first three stages.
# Runs as root (nginx:1.29-alpine's default user) — fine for a static
# placeholder page with no data of any kind behind it, but do not let the
# real multi-stage build inherit this by omission: infra/docker/api.Dockerfile
# creates and switches to a non-root `app` user, and this image's real
# replacement should do the same in its own nginx runtime stage.
FROM nginx:1.29-alpine

COPY infra/placeholder-pages/web/index.html /usr/share/nginx/html/index.html

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget --quiet --spider http://localhost/ || exit 1
