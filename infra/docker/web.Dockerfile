# syntax=docker/dockerfile:1
#
# The patient web SPA (apps/web, P2.S3). Multi-stage, in the shape the
# placeholder this replaces described: deps -> build -> nginx runtime, the
# same first three stages as infra/docker/api.Dockerfile.
#
# WHY THIS WAS A PLACEHOLDER FOR THREE SPRINTS
#
# The file this replaces served a static "not yet scaffolded" page and said
# so in its own comment — accurate at P1.S2, when apps/web did not exist.
# apps/web landed at P2.S3 and nobody came back here, so `docker compose up`
# kept producing a complete-looking environment whose web container answered
# 200 with a stub. A 200 from a placeholder is indistinguishable from a 200
# from the real SPA, which is how a Gate B rehearsal got as far as "the web
# view renders the entry" before noticing.
#
# Same root cause as the API image being unbuildable for five PRs (#22):
# nothing in CI builds these images, so an image that stops matching the
# repository produces no signal anywhere. Worth fixing at the CI level, not
# just here.
#
# CONFIGURATION IS BAKED IN AT BUILD TIME, NOT READ AT RUNTIME
#
# Vite inlines `import.meta.env.VITE_*` into the bundle when it builds; there
# is no process environment in a browser to read later. So every value below
# is a build ARG, and changing one means rebuilding the image — `docker
# compose build web`, not `docker compose restart web`. That is a real
# operational difference from the `api` service, whose config is runtime
# environment, and it is the thing most likely to confuse someone who
# changes DEV_HOST_ADDRESS and wonders why the SPA still talks to the old
# address.
#
# None of these are secrets. An OIDC public client's id and the URLs it talks
# to are shipped to every browser that loads the app by definition — baking
# them into a layer discloses nothing that opening devtools would not. Do not
# add anything here that is not already public by that standard.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.29-alpine
ARG PNPM_VERSION=10.34.5

# --- base -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /workspace

# --- deps -------------------------------------------------------------------
# Manifests only, so this layer and its `pnpm install` stay cached until a
# lockfile or a package.json actually changes.
#
# Every workspace apps/web's graph needs must be listed. `@ostomy/core` and
# `@ostomy/ui` are its workspace dependencies; omitting either is exactly the
# failure that made the API image unbuildable (#22), so the list is explicit
# rather than a wildcard copy.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
# `@ostomy/core` and `@ostomy/ui` are built BEFORE apps/web, for the reason
# the API image records: both resolve through their `exports` maps to `dist/`,
# and .dockerignore excludes `**/dist` so no host build can leak in. This is
# the root `build:deps` script's job outside Docker.
FROM deps AS build
COPY packages/config packages/config
COPY packages/core packages/core
COPY packages/ui packages/ui
COPY apps/web apps/web

ARG VITE_API_BASE_URL=http://localhost:3000
ARG VITE_OIDC_ISSUER=http://localhost:8090/patient-issuer
ARG VITE_OIDC_CLIENT_ID=ostomy-web
ARG VITE_OIDC_AUDIENCE=ostomy-patient-app
ARG VITE_OIDC_REDIRECT_URI=http://localhost:8080/
ARG VITE_OIDC_SCOPE
ARG VITE_SESSION_IDLE_TIMEOUT_MINUTES

ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_OIDC_ISSUER=${VITE_OIDC_ISSUER} \
    VITE_OIDC_CLIENT_ID=${VITE_OIDC_CLIENT_ID} \
    VITE_OIDC_AUDIENCE=${VITE_OIDC_AUDIENCE} \
    VITE_OIDC_REDIRECT_URI=${VITE_OIDC_REDIRECT_URI} \
    VITE_OIDC_SCOPE=${VITE_OIDC_SCOPE} \
    VITE_SESSION_IDLE_TIMEOUT_MINUTES=${VITE_SESSION_IDLE_TIMEOUT_MINUTES}

RUN pnpm --filter @ostomy/core build \
 && pnpm --filter @ostomy/ui build \
 && pnpm --filter @ostomy/web build

# --- runtime ----------------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime

# The HEALTHCHECK at the bottom of this file addresses 127.0.0.1 and not
# `localhost`, which cost a debugging round to find and is worth writing down.
# busybox wget in this image resolves `localhost` to `::1` first; nginx's
# `listen 8080` binds IPv4 only. The result is a container that answers every
# request from the host correctly and reports UNHEALTHY forever, which Compose
# then refuses to treat as ready — a failure that looks like a broken server
# and is actually a resolver preference.
#
# Addressing 127.0.0.1 is the fix rather than adding `listen [::]:8080`,
# deliberately: an IPv6 listener fails nginx's startup outright on a host with
# IPv6 disabled, trading a confusing health status for a container that will
# not boot at all. (infra/docker/api.Dockerfile's healthcheck does use
# `localhost` and does not hit this — Node's fetch tries both families.)
#
# The SPA fallback below is load-bearing rather than tidiness. The app uses
# react-router, and the OIDC redirect comes back to a path with a `?code=`
# query — nginx's default would 404 any URL that is not a real file on disk,
# so a deep link or a completed sign-in would break while the home page
# worked. `=404` on the asset location keeps a genuinely missing bundle an
# error rather than silently serving index.html as JavaScript.
RUN printf '%s\n' \
  'server {' \
  '  listen 8080;' \
  '  root /usr/share/nginx/html;' \
  '  index index.html;' \
  '  location /assets/ { try_files $uri =404; }' \
  '  location / { try_files $uri $uri/ /index.html; }' \
  '}' > /etc/nginx/conf.d/default.conf

COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

# Non-root, which the placeholder explicitly told its replacement not to
# inherit by omission: "infra/docker/api.Dockerfile creates and switches to a
# non-root `app` user, and this image's real replacement should do the same".
#
# nginx:alpine ships an `nginx` user but its default config wants port 80 and
# writes its pid and caches under paths only root can create. Listening on
# 8080 above avoids the privileged port; these chowns cover the rest. The
# container port is 8080, so docker-compose.yml maps to 8080, not 80.
RUN touch /var/run/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget --quiet --spider http://127.0.0.1:8080/ || exit 1
