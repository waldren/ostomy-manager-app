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
 * `deploy`: build a release here, ship it, run it, and check that what runs
 * is what was built.
 */
import { Refusal } from '../errors.ts';
import {
  BUILT,
  composeIsRecentEnough,
  installStackScript,
  loadImagesScript,
  MIN_COMPOSE_VERSION,
  parseProbe,
  platformFor,
  probeScript,
  readFileScript,
  recordReleaseScript,
  upScript,
  type BuiltService,
  type Probe,
} from '../host-scripts.ts';
import { releaseOverride, saveCommand, type ImageIds } from '../images.ts';
import { execOrRefuse } from '../remote.ts';
import {
  requireCheckoutIs,
  resolveRelease,
  stackArchive,
  withWorktree,
  type Release,
} from '../release.ts';
import { parseSettings, SETTINGS_PATH, type HostSettings } from '../settings.ts';
import type { Context } from './context.ts';

export interface ReleaseRecord {
  release: string;
  commit: string;
  signedTag: string | null;
  classification: string;
  images: ImageIds;
  deployedAt: string;
}

export async function probe(ctx: Context): Promise<Probe> {
  return parseProbe(await execOrRefuse(ctx.remote, probeScript(), 'probing the host'));
}

export function requireClassified(found: Probe): 'synthetic' | 'real' {
  if (found.classification === 'synthetic' || found.classification === 'real')
    return found.classification;
  if (found.classification === '')
    throw new Refusal('this host has not been initialised: run `init` first');
  throw new Refusal(
    `this host's classification is unreadable: ${JSON.stringify(found.classification)}`,
  );
}

export function requireCompose(found: Probe): void {
  if (!composeIsRecentEnough(found.compose)) {
    throw new Refusal(
      `the host's Docker Compose is ${found.compose || 'missing'}; this stack needs ${MIN_COMPOSE_VERSION.join('.')} or later`,
    );
  }
}

/** The release `ref` names, held to the host's classification. */
export async function releaseFor(
  ctx: Context,
  ref: string,
  classification: 'synthetic' | 'real',
  allowedSigners: string | undefined,
): Promise<Release> {
  const release = await resolveRelease(ctx.repo, ref, {
    requireSigned: classification === 'real',
    allowedSigners,
  });
  if (classification === 'real') await requireCheckoutIs(ctx.repo, release);
  return release;
}

/** Builds, ships, runs and records `release`. Shared by `init` and `deploy`. */
export async function deployRelease(
  ctx: Context,
  options: {
    release: Release;
    found: Probe;
    settings: HostSettings;
    classification: 'synthetic' | 'real';
  },
): Promise<ReleaseRecord> {
  const { release, found, settings } = options;
  const platform = platformFor(found.arch);

  ctx.log(`building ${release.name} (${release.commit.slice(0, 12)}) for ${platform}`);
  const images = await withWorktree(ctx.repo, release.commit, (worktree) =>
    ctx.buildImages({ worktree, settings, commit: release.commit, platform, name: release.name }),
  );

  ctx.log('shipping images to the host');
  await refuseOnFailure(
    ctx.remote.execFrom(saveCommand(release.name), loadImagesScript(images, release.name)),
    'loading images',
  );
  ctx.log('installing the stack files');
  await refuseOnFailure(
    ctx.remote.execFrom(
      stackArchive(ctx.repo, release.commit),
      installStackScript(release.name, releaseOverride(release.name)),
    ),
    'installing the stack',
  );

  ctx.log('starting the stack (this waits for every health check)');
  const running = parseRunning(
    await execOrRefuse(ctx.remote, upScript(release.name, release.commit), 'starting the stack'),
  );
  requireRunningIs(running, images);

  const record: ReleaseRecord = {
    release: release.name,
    commit: release.commit,
    signedTag: release.signedTag ?? null,
    classification: options.classification,
    images,
    deployedAt: ctx.now().toISOString(),
  };
  await execOrRefuse(
    ctx.remote,
    recordReleaseScript(`${JSON.stringify(record, null, 2)}\n`),
    'recording the release',
  );

  ctx.log(`checking https://${settings.domain}/api/v1/health/ready from here`);
  if (!(await ctx.waitForReady(settings.domain))) {
    throw new Refusal(
      `${release.name} is running, but https://${settings.domain}/api/v1/health/ready did not answer 200. ` +
        'Check that DNS for both names points at the host (Let’s Encrypt needs it), then `status` and `logs`.',
    );
  }
  return record;
}

async function refuseOnFailure(
  result: Promise<{ code: number; stderr: string }>,
  what: string,
): Promise<void> {
  const { code, stderr } = await result;
  if (code !== 0) throw new Refusal(`${what} failed (exit ${code}):\n${stderr.trim()}`);
}

export function parseRunning(stdout: string): Partial<ImageIds> {
  const running: Partial<ImageIds> = {};
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    const service = line.slice(0, at) as BuiltService;
    if (at > 0 && service in BUILT) running[service] = line.slice(at + 1).trim();
  }
  return running;
}

/** Refuses unless each built service's container runs exactly the image built. */
export function requireRunningIs(running: Partial<ImageIds>, images: ImageIds): void {
  const wrong = (Object.keys(BUILT) as BuiltService[]).filter(
    (service) => running[service] !== images[service],
  );
  if (wrong.length > 0) {
    throw new Refusal(
      'the host is not running the images just built:\n' +
        wrong
          .map(
            (service) =>
              `  ${service}: running ${running[service] || 'nothing'}, built ${images[service]}`,
          )
          .join('\n'),
    );
  }
}

export async function readSettings(ctx: Context): Promise<HostSettings> {
  return parseSettings(
    await execOrRefuse(ctx.remote, readFileScript(SETTINGS_PATH), 'reading the host settings'),
  );
}

export async function deployCommand(
  ctx: Context,
  options: { ref: string; allowedSigners: string | undefined },
): Promise<ReleaseRecord> {
  const found = await probe(ctx);
  const classification = requireClassified(found);
  requireCompose(found);
  const release = await releaseFor(ctx, options.ref, classification, options.allowedSigners);
  const settings = await readSettings(ctx);
  return deployRelease(ctx, { release, found, settings, classification });
}
