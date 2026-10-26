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
 * `init` and `deploy` against a fake host, a fake build and real git.
 *
 * The property that matters most is ordering: every refusal must happen
 * before anything on the host changes, so each refusal case asserts what was
 * sent as well as what was thrown.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { SELFHOST_ROOT } from '../src/compose-file.ts';
import type { Context } from './commands/context.ts';
import { deployCommand } from './commands/deploy.ts';
import { initCommand } from './commands/init.ts';
import { Refusal } from './errors.ts';
import type { ImageIds } from './images.ts';
import { READINESS_PATH } from './readiness.ts';
import { renderSettings, type HostSettings } from './settings.ts';
import {
  commit,
  FakeRemote,
  git,
  newRepo,
  signedTag,
  signingKey,
  type SigningKey,
} from './test-support.ts';

const REPO_ROOT = path.join(SELFHOST_ROOT, '../..');
const unsignedChecklist = readFileSync(path.join(REPO_ROOT, READINESS_PATH), 'utf8');
const signedChecklist = unsignedChecklist.replace(
  /^(\| RD-\d+ \|.*\| )([^|]*)( \|)$/gm,
  (_line, start: string, _old, end: string) => `${start}Pat Officer, 2026-11-01${end}`,
);
const generateSecrets = readFileSync(path.join(SELFHOST_ROOT, 'bin/generate-secrets.sh'), 'utf8');

const SETTINGS: HostSettings = {
  domain: 'diary.example.org',
  authDomain: 'auth.diary.example.org',
  acmeEmail: 'operator@example.org',
  adminAllowedIps: ['8.8.4.4'],
  sshAllowedIps: ['8.8.8.0/24'],
};
const IMAGES: ImageIds = {
  'db-setup': `sha256:${'1'.repeat(64)}`,
  api: `sha256:${'2'.repeat(64)}`,
  web: `sha256:${'3'.repeat(64)}`,
};

interface HostState {
  classification: string;
  deployed: boolean;
  etc: boolean;
  volumes: number;
  compose: string;
  running: ImageIds;
  os: string;
  /** The commit the release name being deployed was installed from, if ever. */
  installedCommit: string;
  /** The address the operator's SSH session arrives from. */
  sshClient: string;
  sshdInclude: boolean;
}

/** What each script sent was for, in order, by the step it performs. */
function steps(remote: FakeRemote): string[] {
  return remote.sent.map(({ script, producer }) => {
    if (producer?.args.includes('save')) return 'load';
    if (producer?.args.includes('archive')) return 'install';
    if (script.includes('echo "os=$ID"')) return 'probe';
    if (script.includes('/.release-commit')) return 'check release';
    if (script.includes('set -C;')) return 'classify';
    if (script.includes('ufw --force enable')) return 'harden';
    if (script.includes('generator=')) return 'configure';
    if (script.includes("cat '/etc/ostomy/selfhost.env'")) return 'read settings';
    if (script.includes(' up --detach')) return 'up';
    if (script.includes('/etc/ostomy/release.json')) return 'record';
    return 'other';
  });
}

function fakeHost(state: HostState): FakeRemote {
  return new FakeRemote()
    .on(/echo "os=\$ID"/, () => ({
      stdout:
        `os=${state.os}\ncodename=bookworm\narch=x86_64\nclassification=${state.classification}\n` +
        `deployed=${state.deployed ? 'yes' : 'no'}\netc=${state.etc ? 'yes' : 'no'}\n` +
        `compose=${state.compose}\nvolumes=${state.volumes}\n` +
        `ssh_client=${state.sshClient}\nssh_port=22\nsshd_include=${state.sshdInclude ? 'yes' : 'no'}\n`,
    }))
    .on(/set -C;/, (script) => {
      state.classification = /printf '%s\\n' '(\w+)'/.exec(script)![1]!;
      state.etc = true;
      return { stdout: 'created\n' };
    })
    .on(/ufw --force enable/, () => {
      state.compose = '2.29.1';
      return {};
    })
    .on(/cat '\/etc\/ostomy\/selfhost\.env'/, { stdout: renderSettings(SETTINGS) })
    .on(/\/\.release-commit' 2>\/dev\/null \|\| true/, () => ({
      stdout: state.installedCommit === '' ? '' : `${state.installedCommit}\n`,
    }))
    .on(/ up --detach/, () => ({
      stdout: Object.entries(state.running)
        .map(([service, id]) => `${service}=${id}`)
        .join('\n'),
    }));
}

describe('init and deploy', () => {
  let operator: SigningKey;
  let repo: string;
  let release: string;
  let state: HostState;
  let remote: FakeRemote;
  let built: { commit: string; name: string }[];
  let ready: boolean;
  let ctx: Context;

  beforeEach(() => {
    operator = signingKey('operator');
    ({ repo, first: release } = newRepo({
      [READINESS_PATH]: unsignedChecklist,
      'infra/selfhost/bin/generate-secrets.sh': generateSecrets,
      'infra/selfhost/compose.yml': 'name: ostomy\n',
    }));
    signedTag(repo, 'v1.0.0', operator.privateKey);
    state = {
      classification: '',
      deployed: false,
      etc: false,
      volumes: 0,
      compose: '',
      running: { ...IMAGES },
      os: 'debian',
      installedCommit: '',
      sshClient: '8.8.8.8',
      sshdInclude: true,
    };
    remote = fakeHost(state);
    built = [];
    ready = true;
    ctx = {
      repo,
      remote,
      log: () => {},
      buildImages: async ({ commit, name }) => {
        built.push({ commit, name });
        return { ...IMAGES };
      },
      waitForReady: async () => ready,
      now: () => new Date('2026-11-02T10:00:00Z'),
    };
  });

  const init = (classification: 'synthetic' | 'real', ref: string, allowedSigners?: string) =>
    initCommand(ctx, { classification, ref, settings: SETTINGS, allowedSigners });

  describe('a synthetic host', () => {
    it('is classified first, then hardened, configured, and given its first release', async () => {
      const record = await init('synthetic', 'main');
      expect(steps(remote)).toEqual([
        'probe',
        'classify',
        'harden',
        'configure',
        'probe',
        'check release',
        'load',
        'install',
        'up',
        'record',
      ]);
      expect(built).toEqual([{ commit: release, name: `commit-${release.slice(0, 12)}` }]);
      expect(record).toMatchObject({
        classification: 'synthetic',
        commit: release,
        signedTag: null,
        images: IMAGES,
      });
    });

    it('ships the release’s own stack files and its own secrets generator, never the working copy', async () => {
      await init('synthetic', 'main');
      const install = remote.sent.find((sent) => sent.producer?.args.includes('archive'))!;
      expect(install.producer!.args).toContain(release);
      const configure = remote.sent.find((sent) => sent.script.includes('generator='))!.script;
      expect(configure).toContain(Buffer.from(generateSecrets).toString('base64'));
      expect(configure).toContain(Buffer.from(renderSettings(SETTINGS)).toString('base64'));
    });
  });

  describe('a real host', () => {
    it('refuses while any readiness item is unsigned in the release, before changing anything', async () => {
      git(repo, 'checkout', '--quiet', '--detach', 'v1.0.0');
      await expect(init('real', 'v1.0.0', operator.allowedSigners)).rejects.toThrow(
        /24 of 24 items unsigned/,
      );
      expect(steps(remote)).toEqual(['probe']);
    });

    it('reads the checklist from the signed tag, so a sign-off typed into the working copy does not count', async () => {
      git(repo, 'checkout', '--quiet', '--detach', 'v1.0.0');
      writeFileSync(path.join(repo, READINESS_PATH), signedChecklist);
      // The checkout is now dirty, which is refused on its own; restore it to
      // show the tag's unsigned copy is what refuses.
      await expect(init('real', 'v1.0.0', operator.allowedSigners)).rejects.toThrow(
        /local changes/,
      );
      git(repo, 'checkout', '--quiet', '--', READINESS_PATH);
      await expect(init('real', 'v1.0.0', operator.allowedSigners)).rejects.toThrow(/unsigned/);
      expect(steps(remote).filter((step) => step !== 'probe')).toEqual([]);
    });

    describe('with every item signed in the release', () => {
      beforeEach(() => {
        git(repo, 'checkout', '--quiet', 'main');
        writeFileSync(path.join(repo, READINESS_PATH), signedChecklist);
        git(repo, 'commit', '--quiet', '--all', '-m', 'sign off');
        signedTag(repo, 'v1.1.0', operator.privateKey);
        git(repo, 'checkout', '--quiet', '--detach', 'v1.1.0');
      });

      it('initialises, recording the signed tag', async () => {
        const record = await init('real', 'v1.1.0', operator.allowedSigners);
        expect(record).toMatchObject({
          classification: 'real',
          release: 'v1.1.0',
          signedTag: 'v1.1.0',
        });
        expect(steps(remote)[1]).toBe('classify');
      });

      it('refuses a ref that is not a signed tag', async () => {
        await expect(init('real', 'main', operator.allowedSigners)).rejects.toThrow(Refusal);
        expect(steps(remote)).toEqual(['probe']);
      });

      it('refuses without the operator environment’s allowed signers', async () => {
        await expect(init('real', 'v1.1.0', undefined)).rejects.toThrow(/--allowed-signers/);
        expect(steps(remote)).toEqual(['probe']);
      });

      it('refuses a tag signed by any other key', async () => {
        const stranger = signingKey('stranger');
        await expect(init('real', 'v1.1.0', stranger.allowedSigners)).rejects.toThrow(
          /does not verify/,
        );
        expect(steps(remote)).toEqual(['probe']);
      });

      it('refuses when this tool is not running from the release’s own checkout', async () => {
        git(repo, 'checkout', '--quiet', 'main');
        commit(repo, { 'after.txt': 'pushed after the release was signed\n' });
        await expect(init('real', 'v1.1.0', operator.allowedSigners)).rejects.toThrow(
          /clean checkout of v1\.1\.0/,
        );
        expect(steps(remote)).toEqual(['probe']);
      });

      it.each([
        ['has /etc/ostomy', { etc: true }],
        ['has the stack’s volumes', { volumes: 3 }],
      ])('refuses a host that %s: real hosts are freshly provisioned', async (_name, change) => {
        Object.assign(state, change);
        await expect(init('real', 'v1.1.0', operator.allowedSigners)).rejects.toThrow(
          /freshly provisioned/,
        );
        expect(steps(remote)).toEqual(['probe']);
      });
    });
  });

  describe('classification never changes', () => {
    it('refuses to initialise a synthetic host as real', async () => {
      state.classification = 'synthetic';
      state.etc = true;
      await expect(init('real', 'v1.0.0', operator.allowedSigners)).rejects.toThrow(
        /never promoted to real/,
      );
      expect(steps(remote)).toEqual(['probe']);
    });

    it('refuses to re-initialise a host that has a release', async () => {
      state.classification = 'synthetic';
      state.deployed = true;
      await expect(init('synthetic', 'main')).rejects.toThrow(/use `deploy`/);
      expect(steps(remote)).toEqual(['probe']);
    });

    // The firewall admits SSH from --ssh-from only. An operator outside it
    // would lose the host, so this is refused before the host is touched.
    it.each([
      [
        'an operator address --ssh-from leaves out',
        { sshClient: '9.9.9.9' },
        /9\.9\.9\.9.*lock you out/,
      ],
      ['an unsupported OS', { os: 'alpine' }, /Debian or Ubuntu only/],
      ['an sshd that would not read the hardening', { sshdInclude: false }, /sshd_config\.d/],
    ] as const)('refuses %s before classifying anything', async (_name, change, message) => {
      Object.assign(state, change);
      await expect(init('synthetic', 'main')).rejects.toThrow(message);
      expect(steps(remote)).toEqual(['probe']);
    });

    it('opens SSH to the --ssh-from addresses alone', async () => {
      await init('synthetic', 'main');
      const harden = remote.sent.find(({ script }) => script.includes('ufw --force enable'))!;
      expect(harden.script.match(/^ufw allow .*$/gm)).toEqual([
        `ufw allow proto tcp from '8.8.8.0/24' to any port "$ssh_port"`,
        'ufw allow 80/tcp',
        'ufw allow 443/tcp',
      ]);
    });

    it('resumes an interrupted init under the same classification', async () => {
      state.classification = 'synthetic';
      state.etc = true;
      await expect(init('synthetic', 'main')).resolves.toMatchObject({
        classification: 'synthetic',
      });
    });
  });

  describe('deploy', () => {
    beforeEach(() => {
      state.classification = 'synthetic';
      state.etc = true;
      state.deployed = true;
      state.compose = '2.29.1';
    });

    it('builds, ships, runs and records the release', async () => {
      await deployCommand(ctx, { ref: 'main', allowedSigners: undefined });
      expect(steps(remote)).toEqual([
        'probe',
        'read settings',
        'check release',
        'load',
        'install',
        'up',
        'record',
      ]);
    });

    // Loading would retag the images the running stack was started from.
    it('refuses a release name installed from another commit, before building or shipping', async () => {
      state.installedCommit = 'd'.repeat(40);
      await expect(deployCommand(ctx, { ref: 'main', allowedSigners: undefined })).rejects.toThrow(
        /already installed on this host from commit dddddddddddd/,
      );
      expect(steps(remote)).toEqual(['probe', 'read settings', 'check release']);
      expect(built).toEqual([]);
    });

    it('redeploys a release name installed from the same commit', async () => {
      state.installedCommit = release;
      await expect(
        deployCommand(ctx, { ref: 'main', allowedSigners: undefined }),
      ).resolves.toMatchObject({ commit: release });
    });

    it('refuses a host that was never initialised', async () => {
      state.classification = '';
      await expect(deployCommand(ctx, { ref: 'main', allowedSigners: undefined })).rejects.toThrow(
        /run `init` first/,
      );
    });

    it('refuses a Compose too old for the release override', async () => {
      state.compose = '2.20.2';
      await expect(deployCommand(ctx, { ref: 'main', allowedSigners: undefined })).rejects.toThrow(
        /2\.24\.4 or later/,
      );
      expect(steps(remote)).toEqual(['probe']);
    });

    it('refuses, and records nothing, when what runs is not what was built', async () => {
      state.running = { ...IMAGES, api: `sha256:${'9'.repeat(64)}` };
      await expect(deployCommand(ctx, { ref: 'main', allowedSigners: undefined })).rejects.toThrow(
        /not running the images just built[\s\S]*api: running sha256:9/,
      );
      expect(steps(remote)).not.toContain('record');
    });

    it('records the release, then refuses, when the readiness endpoint never answers', async () => {
      ready = false;
      await expect(deployCommand(ctx, { ref: 'main', allowedSigners: undefined })).rejects.toThrow(
        /did not answer 200/,
      );
      expect(steps(remote).at(-1)).toBe('record');
    });

    it('takes only a signed tag on a real host', async () => {
      state.classification = 'real';
      await expect(
        deployCommand(ctx, { ref: 'main', allowedSigners: operator.allowedSigners }),
      ).rejects.toThrow(Refusal);
      expect(steps(remote)).toEqual(['probe']);
    });
  });
});
