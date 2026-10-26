/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The API, migration and web images, built here in the operator environment
 * from a clean worktree of the release and shipped to the host over SSH
 * (ADR-0022 item 3). No registry is involved, so no third party sits between
 * the build and the host.
 *
 * compose.yml stays the one definition of how each image is built: this runs
 * `docker compose build` against the release's own copy of it, then retags.
 * On the host, a generated override drops every `build:` and pins each
 * service to the image built here, and `deploy` refuses unless the running
 * containers are exactly those images.
 */
import path from 'node:path';

import { Refusal } from './errors.ts';
import { BUILT, type BuiltService } from './host-scripts.ts';
import { run, type Command } from './process.ts';
import { checkReleaseName } from './release.ts';
import type { HostSettings } from './settings.ts';

export type ImageIds = Record<BuiltService, string>;

const SERVICES = Object.keys(BUILT) as BuiltService[];

/** compose.yml's own tag for each built image. */
const BUILD_TAG = 'selfhost';

export function releaseTag(service: BuiltService, name: string): string {
  return `${BUILT[service]}:${checkReleaseName(name)}`;
}

/**
 * The environment compose.yml needs to interpolate. The secrets directory is
 * only named, never read, by a build: no secret exists in this environment.
 */
export function buildEnvironment(
  settings: HostSettings,
  commit: string,
  platform: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BUILD_COMMIT: commit,
    OSTOMY_DOMAIN: settings.domain,
    OSTOMY_AUTH_DOMAIN: settings.authDomain,
    OSTOMY_ACME_EMAIL: settings.acmeEmail,
    OSTOMY_ADMIN_ALLOWED_IPS: settings.adminAllowedIps.join(' '),
    OSTOMY_SECRETS_DIR: '/nonexistent/no-secrets-in-a-build',
    DOCKER_DEFAULT_PLATFORM: platform,
  };
}

async function docker(
  args: readonly string[],
  options: { inherit?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const result = await run(
    { command: 'docker', args, ...(options.env ? { env: options.env } : {}) },
    { inherit: options.inherit ?? false },
  );
  if (result.code !== 0) {
    throw new Refusal(
      `docker ${args.slice(0, 3).join(' ')} failed (exit ${result.code})\n${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** Builds the three images from `worktree` and returns their IDs. */
export async function buildImages(options: {
  worktree: string;
  settings: HostSettings;
  commit: string;
  platform: string;
  name: string;
}): Promise<ImageIds> {
  const composeFile = path.join(options.worktree, 'infra/selfhost/compose.yml');
  await docker(['compose', '-f', composeFile, 'build', '--pull', ...SERVICES], {
    inherit: true,
    env: buildEnvironment(options.settings, options.commit, options.platform),
  });
  const ids = {} as ImageIds;
  const wantArch = options.platform.split('/')[1];
  for (const service of SERVICES) {
    const built = `${BUILT[service]}:${BUILD_TAG}`;
    await docker(['tag', built, releaseTag(service, options.name)]);
    const [id, arch] = (
      await docker(['image', 'inspect', '--format', '{{.Id}} {{.Architecture}}', built])
    ).split(' ');
    if (arch !== wantArch) {
      throw new Refusal(`${built} was built for ${arch}, but the host is ${wantArch}`);
    }
    ids[service] = id!;
  }
  return ids;
}

/** `docker save` of the release's three tags, for `docker load` on the host. */
export function saveCommand(name: string): Command {
  return {
    command: 'docker',
    args: ['save', ...SERVICES.map((service) => releaseTag(service, name))],
  };
}

/**
 * The Compose override a release runs with: no service builds, and each
 * built service is pinned to its release tag, which `deploy` has already
 * checked resolves to the image built here.
 */
export function releaseOverride(name: string): string {
  const lines = [
    '# Written by ostomy-host deploy. Nothing on this host builds an image.',
    'services:',
  ];
  for (const service of SERVICES) {
    lines.push(
      `  ${service}:`,
      '    build: !reset null',
      `    image: ${releaseTag(service, name)}`,
      '    pull_policy: never',
    );
  }
  return `${lines.join('\n')}\n`;
}
