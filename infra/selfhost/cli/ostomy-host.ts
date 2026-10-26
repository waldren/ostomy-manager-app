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
 * ostomy-host: initialise, deploy and inspect a self-hosted host (ADR-0022,
 * D.S1 slice 3). Runs as TypeScript under Node 24, with no build step:
 *
 *   pnpm host <command> ...      (from the repository root)
 *
 * See infra/selfhost/README.md, "Operating a host", before using it.
 */
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initCommand } from './commands/init.ts';
import { deployCommand } from './commands/deploy.ts';
import { logsCommand, statusCommand } from './commands/status.ts';
import { waitForReady, type Context } from './commands/context.ts';
import { EXIT, Refusal, Unreachable } from './errors.ts';
import { SERVICES, type Service } from './host-scripts.ts';
import { buildImages } from './images.ts';
import { repoRoot } from './release.ts';
import { SshRemote } from './remote.ts';

const USAGE = `ostomy-host <command> --host <ssh destination> [options]

  init    --classification synthetic|real --release <ref>
          --domain <name> --auth-domain <name> --acme-email <address>
          --admin-ip <address or range> [--admin-ip ...]
          [--allowed-signers <file>]
      Classify, harden and configure a fresh host, then deploy <ref>.
      A real host needs a tag signed in the operator environment, checked
      against --allowed-signers, with every readiness item signed in it.

  deploy  --release <ref> [--allowed-signers <file>]
      Build <ref> here, ship it, run it, and check what runs is what was built.

  status
      Classification, release, images, containers and readiness.

  logs    <service> [--tail <lines>]
      One service's log. Services: ${SERVICES.join(', ')}.

--allowed-signers defaults to $OSTOMY_ALLOWED_SIGNERS.
Exit: 0 done, 1 refused, 2 unreachable, 3 unexpected failure.`;

function required(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '')
    throw new Refusal(`--${name} is required\n\n${USAGE}`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      classification: { type: 'string' },
      release: { type: 'string' },
      domain: { type: 'string' },
      'auth-domain': { type: 'string' },
      'acme-email': { type: 'string' },
      'admin-ip': { type: 'string', multiple: true },
      'allowed-signers': { type: 'string' },
      tail: { type: 'string', default: '200' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return values.help ? EXIT.ok : EXIT.refused;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const ctx: Context = {
    repo: await repoRoot(here),
    remote: new SshRemote(required(values, 'host')),
    log: (line) => console.log(line),
    buildImages,
    waitForReady: (domain, attempts) =>
      waitForReady(domain, attempts === undefined ? {} : { attempts }),
    now: () => new Date(),
  };
  const allowedSigners = values['allowed-signers'] ?? process.env.OSTOMY_ALLOWED_SIGNERS;

  switch (command) {
    case 'init': {
      const classification = required(values, 'classification');
      if (classification !== 'synthetic' && classification !== 'real') {
        throw new Refusal('--classification must be synthetic or real');
      }
      const record = await initCommand(ctx, {
        classification,
        ref: required(values, 'release'),
        settings: {
          domain: required(values, 'domain'),
          authDomain: required(values, 'auth-domain'),
          acmeEmail: required(values, 'acme-email'),
          adminAllowedIps: values['admin-ip'] ?? [],
        },
        allowedSigners,
      });
      ctx.log(`initialised ${ctx.remote.target} as ${classification}, running ${record.release}`);
      if (classification === 'real') {
        ctx.log(
          'No patient account may be created until `verify` passes against this host (ADR-0022 item 4).',
        );
      }
      return EXIT.ok;
    }
    case 'deploy': {
      const record = await deployCommand(ctx, { ref: required(values, 'release'), allowedSigners });
      ctx.log(`${ctx.remote.target} is running ${record.release}`);
      return EXIT.ok;
    }
    case 'status':
      return (await statusCommand(ctx)) ? EXIT.ok : EXIT.refused;
    case 'logs': {
      const service = rest[0];
      if (service === undefined || !(SERVICES as readonly string[]).includes(service)) {
        throw new Refusal(`logs needs one of: ${SERVICES.join(', ')}`);
      }
      const tail = Number(values.tail);
      if (!Number.isInteger(tail) || tail < 1 || tail > 10_000)
        throw new Refusal('--tail must be 1 to 10000');
      await logsCommand(ctx, service as Service, tail);
      return EXIT.ok;
    }
    default:
      throw new Refusal(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof Refusal) {
      console.error(`refused: ${error.message}`);
      process.exit(EXIT.refused);
    }
    if (error instanceof Unreachable) {
      console.error(`unreachable: ${error.message}`);
      process.exit(EXIT.unreachable);
    }
    if (
      error instanceof TypeError &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      console.error(`refused: ${error.message}\n\n${USAGE}`);
      process.exit(EXIT.refused);
    }
    console.error(error);
    process.exit(EXIT.unexpected);
  },
);
