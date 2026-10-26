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

/** `status` and `logs`: read-only. */
import { Refusal } from '../errors.ts';
import {
  BUILT,
  logsScript,
  psScript,
  readFileScript,
  RELEASE_RECORD_PATH,
  runningImagesScript,
  type BuiltService,
  type Service,
} from '../host-scripts.ts';
import { execOrRefuse } from '../remote.ts';
import type { Context } from './context.ts';
import {
  parseRunning,
  probe,
  readSettings,
  requireClassified,
  type ReleaseRecord,
} from './deploy.ts';

export async function readRecord(ctx: Context): Promise<ReleaseRecord> {
  const result = await ctx.remote.exec(readFileScript(RELEASE_RECORD_PATH));
  if (result.code !== 0) throw new Refusal('no release has been deployed to this host');
  return JSON.parse(result.stdout) as ReleaseRecord;
}

/** Prints the host's state, and returns whether everything is as recorded and ready. */
export async function statusCommand(ctx: Context): Promise<boolean> {
  const found = await probe(ctx);
  const classification = requireClassified(found);
  const record = await readRecord(ctx);
  const settings = await readSettings(ctx);
  ctx.log(`host            ${ctx.remote.target}`);
  ctx.log(`classification  ${classification}`);
  ctx.log(
    `release         ${record.release} (${record.commit.slice(0, 12)}), ${record.signedTag ? 'signed tag' : 'unsigned'}`,
  );
  ctx.log(`deployed        ${record.deployedAt}`);
  ctx.log(`docker compose  ${found.compose}`);

  const running = parseRunning(
    await execOrRefuse(
      ctx.remote,
      runningImagesScript(record.release, record.commit),
      'reading the running images',
    ),
  );
  let healthy = true;
  for (const service of Object.keys(BUILT) as BuiltService[]) {
    const same = running[service] === record.images[service];
    healthy &&= same;
    ctx.log(
      `image ${service.padEnd(9)} ${same ? 'as deployed' : `CHANGED: running ${running[service] || 'nothing'}`}`,
    );
  }
  ctx.log('');
  ctx.log(
    await execOrRefuse(ctx.remote, psScript(record.release, record.commit), 'listing containers'),
  );

  const ready = await ctx.waitForReady(settings.domain, 1);
  healthy &&= ready;
  ctx.log(
    `readiness       https://${settings.domain}/api/v1/health/ready ${ready ? '200' : 'NOT READY'}`,
  );
  return healthy;
}

export async function logsCommand(ctx: Context, service: Service, tail: number): Promise<void> {
  const record = await readRecord(ctx);
  ctx.log(
    await execOrRefuse(
      ctx.remote,
      logsScript(record.release, record.commit, service, tail),
      'reading logs',
    ),
  );
}
