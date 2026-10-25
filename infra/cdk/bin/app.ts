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
 * The CDK app for the P4.S6 spike (#168). `pnpm --filter @ostomy/infra-cdk
 * cdk deploy` builds both images from infra/docker/api.Dockerfile's `-aws`
 * targets and deploys `OstomyStagingSpike` to the account and region the AWS
 * CLI is configured for. Run it only as docs/deployment-staging-spike.md says.
 *
 * The images are stamped with the checkout's commit (`git rev-parse HEAD`),
 * or with `-c buildCommit=<sha>`. A synth with neither fails: the API refuses
 * to start with an empty BUILD_COMMIT. A checkout with uncommitted changes is
 * refused too, unless the commit is given explicitly: HEAD would name code
 * that is not what the images contain, and #76 is what that costs.
 *
 * `-c apiDesiredCount=1` scales the API up. It defaults to 0, which the first
 * deploy must use (SpikeStackProps.apiDesiredCount says why).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { App } from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';

import { SpikeStack } from '../src/spike-stack';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const app = new App();
function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}
function headCommit(): string {
  const head = git('rev-parse', 'HEAD') ?? '';
  if (head !== '' && git('status', '--porcelain') !== '') {
    throw new Error(
      'The checkout has uncommitted changes, so HEAD does not name what the images would contain. Commit them, or pass -c buildCommit=<sha> deliberately.',
    );
  }
  return head;
}
const fromContext: unknown = app.node.tryGetContext('buildCommit');
const commit =
  typeof fromContext === 'string' && fromContext.trim() !== '' ? fromContext.trim() : headCommit();
if (commit === '') {
  throw new Error(
    'No commit to stamp the images with: run from a git checkout, or pass -c buildCommit=<sha>.',
  );
}

// The build context is the repo root, as for Compose. On top of
// .dockerignore, everything the API image never copies is left out, or each
// synth would stage the mobile app and the specs into cdk.out.
const image = (target: 'runtime-aws' | 'migrate-aws') =>
  ecs.ContainerImage.fromAsset(repoRoot, {
    file: 'infra/docker/api.Dockerfile',
    target,
    platform: Platform.LINUX_AMD64,
    buildArgs: { BUILD_COMMIT: commit },
    exclude: [
      '.claude',
      '**/cdk.out',
      'apps/mobile',
      'apps/web',
      'packages/ui',
      'design-specs',
      'docs',
      'scripts',
    ],
  });

const desired: unknown = app.node.tryGetContext('apiDesiredCount');
const apiDesiredCount = desired === undefined ? 0 : Number(desired);
if (!Number.isInteger(apiDesiredCount) || apiDesiredCount < 0 || apiDesiredCount > 1) {
  throw new Error('apiDesiredCount must be 0 or 1.');
}

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

new SpikeStack(app, 'OstomyStagingSpike', {
  description: 'ostomy P4.S6 staging/Cognito spike (#168). Synthetic data only; destroy after use.',
  ...(account !== undefined && region !== undefined ? { env: { account, region } } : {}),
  apiImage: image('runtime-aws'),
  migrateImage: image('migrate-aws'),
  buildCommit: commit,
  apiDesiredCount,
});
