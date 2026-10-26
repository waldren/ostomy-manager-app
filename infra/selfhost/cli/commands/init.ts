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
 * `init`: classify a host, harden it, configure it, and deploy its first
 * release (ADR-0022 items 1, 3 and 9).
 *
 * The order is the point. Every refusal happens before anything on the host
 * changes: the release is resolved and, for a real host, its signature and
 * readiness checklist checked, and the host checked fresh, all first. The
 * classification is then written before any other change, so a run that
 * fails halfway can be resumed only under the same classification.
 */
import { Refusal } from '../errors.ts';
import { classifyScript, configureScript, hardenScript, type Probe } from '../host-scripts.ts';
import { READINESS_PATH, requireAllSigned } from '../readiness.ts';
import { execOrRefuse } from '../remote.ts';
import { readAtCommit } from '../release.ts';
import { checkSettings, renderSettings, type HostSettings } from '../settings.ts';
import type { Context } from './context.ts';
import { deployRelease, probe, releaseFor, requireCompose, type ReleaseRecord } from './deploy.ts';

export type Classification = 'synthetic' | 'real';

/**
 * Whether `init` may proceed on a host in state `found`. A host is never
 * re-classified, and a real host must be one nothing has touched.
 */
export function checkInitAllowed(found: Probe, classification: Classification): void {
  if (found.deployed) {
    throw new Refusal(
      `this host is already initialised (${found.classification || 'unclassified'}) and has a release: use \`deploy\``,
    );
  }
  if (found.classification !== '' && found.classification !== classification) {
    throw new Refusal(
      `this host is classified ${found.classification}. A host's classification never changes, ` +
        'and a synthetic host is never promoted to real: provision a fresh one (ADR-0022 item 1).',
    );
  }
  if (
    classification === 'real' &&
    found.classification === '' &&
    (found.etc || found.volumes > 0)
  ) {
    throw new Refusal(
      'a real host must be freshly provisioned, but this one already has /etc/ostomy or the stack’s ' +
        'Docker volumes. No synthetic host’s data, keys or accounts carry over (ADR-0022 item 1).',
    );
  }
}

export async function initCommand(
  ctx: Context,
  options: {
    classification: Classification;
    ref: string;
    settings: HostSettings;
    allowedSigners: string | undefined;
  },
): Promise<ReleaseRecord> {
  const settings = checkSettings(options.settings);
  const found = await probe(ctx);
  checkInitAllowed(found, options.classification);

  const release = await releaseFor(
    ctx,
    options.ref,
    options.classification,
    options.allowedSigners,
  );
  if (options.classification === 'real') {
    // Read from the signed tag, never the working copy (ADR-0022 item 3).
    requireAllSigned(await readAtCommit(ctx.repo, release.commit, READINESS_PATH), release.name);
  }
  const generateSecrets = await readAtCommit(
    ctx.repo,
    release.commit,
    'infra/selfhost/bin/generate-secrets.sh',
  );

  ctx.log(`classifying ${ctx.remote.target} as ${options.classification}`);
  await execOrRefuse(
    ctx.remote,
    classifyScript(options.classification),
    'recording the classification',
  );
  ctx.log('hardening the host: Docker, firewall, unattended upgrades, SSH by key only');
  await execOrRefuse(ctx.remote, hardenScript(), 'hardening the host');
  ctx.log('writing the host settings and generating secrets on the host');
  await execOrRefuse(
    ctx.remote,
    configureScript(renderSettings(settings), generateSecrets),
    'configuring the host',
  );

  const hardened = await probe(ctx);
  requireCompose(hardened);
  return deployRelease(ctx, {
    release,
    found: hardened,
    settings,
    classification: options.classification,
  });
}
