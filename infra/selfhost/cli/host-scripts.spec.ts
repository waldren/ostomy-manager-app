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
 * The scripts that run as root on the host, run here through a real bash:
 * each must parse, and the ones whose behaviour can be shown without a host
 * (writing files, the classification lock, the SSH wrapper's quoting) are run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classifyScript,
  composeIsRecentEnough,
  configureScript,
  hardenScript,
  installStackScript,
  loadImagesScript,
  logsScript,
  parseProbe,
  platformFor,
  probeScript,
  psScript,
  recordReleaseScript,
  runningImagesScript,
  upScript,
  writeFile,
  type Service,
} from './host-scripts.ts';
import { releaseOverride } from './images.ts';
import { shq } from './process.ts';
import { remoteCommand } from './remote.ts';

/** Git's bash on Windows (never WSL's `bash.exe`, which System32 puts first); `bash` elsewhere. */
function findBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const candidate = path.resolve(execPath, '../../../bin/bash.exe');
  if (!existsSync(candidate)) throw new Error(`no Git bash at ${candidate}`);
  return candidate;
}
const BASH = findBash();

function bash(script: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(BASH, ['-c', script], { encoding: 'utf8', ...options });
}

/** A path as Git's bash on Windows sees it; unchanged elsewhere. */
function posix(file: string): string {
  if (process.platform !== 'win32') return file;
  return file
    .replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

const COMMIT = 'c'.repeat(40);
const IDS = {
  'db-setup': `sha256:${'1'.repeat(64)}`,
  api: `sha256:${'2'.repeat(64)}`,
  web: `sha256:${'3'.repeat(64)}`,
};

describe('every generated script parses', () => {
  it.each([
    ['probe', probeScript()],
    ['harden', hardenScript(['8.8.8.8', '2001:4860::/32'])],
    ['classify', classifyScript('real')],
    ['configure', configureScript('OSTOMY_DOMAIN=x\n', '#!/usr/bin/env bash\necho "it\'s $1"\n')],
    ['install', installStackScript('v1.0.0', releaseOverride('v1.0.0'))],
    ['load', loadImagesScript(IDS, 'v1.0.0')],
    ['up', upScript('v1.0.0', COMMIT)],
    ['running images', runningImagesScript('v1.0.0', COMMIT)],
    ['ps', psScript('v1.0.0', COMMIT)],
    ['logs', logsScript('v1.0.0', COMMIT, 'api', 50)],
    ['record', recordReleaseScript('{"a": "it\'s"}\n')],
  ])('%s', (_name, script) => {
    const result = spawnSync(BASH, ['-n'], { input: script, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('writeFile', () => {
  it('writes any content byte for byte, with the mode asked for', () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ostomy-write-')));
    const target = path.join(dir, 'out.txt');
    const content = 'EOF\n\'quoted\' "double" $(whoami) `id` \\ \né \t end';
    const result = bash(writeFile(posix(target), content, '0640'));
    expect(result.stderr).toBe('');
    expect(readFileSync(target, 'utf8')).toBe(content);
  });
});

describe('the classification lock', () => {
  const inTemp = (classification: 'synthetic' | 'real', dir: string) =>
    bash(classifyScript(classification).replaceAll('/etc/ostomy', posix(dir)));

  it('writes once, keeps the same answer on a resumed run, and refuses a different one', () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ostomy-class-')));
    expect(inTemp('synthetic', dir).stdout.trim()).toBe('created');
    expect(inTemp('synthetic', dir).stdout.trim()).toBe('kept');
    const changed = inTemp('real', dir);
    expect(changed.status).toBe(70);
    expect(changed.stderr).toContain('already classified synthetic');
    expect(readFileSync(path.join(dir, 'classification'), 'utf8')).toBe('synthetic\n');
  });
});

describe('the SSH wrapper', () => {
  // `sudo` here is a stand-in that drops its flags and runs the rest, so the
  // wrapper's non-root path runs locally exactly as written.
  const fakeBin = realpathSync(mkdtempSync(path.join(tmpdir(), 'ostomy-bin-')));
  writeFileSync(
    path.join(fakeBin, 'sudo'),
    '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n',
  );
  chmodSync(path.join(fakeBin, 'sudo'), 0o755);

  it('runs the script verbatim, however it is quoted', () => {
    const script = `printf '%s|' "it's" 'a "quote"' '$HOME' "$(echo sub)"; echo; echo "\${SSH_CONNECTION:-none}"`;
    const result = bash(remoteCommand(script), {
      env: {
        ...process.env,
        PATH: `${posix(fakeBin)}:/usr/bin:/bin`,
        SSH_CONNECTION: '203.0.113.1 5555 198.51.100.2 2222',
      },
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`it's|a "quote"|$HOME|sub|\n203.0.113.1 5555 198.51.100.2 2222\n`);
  });
});

describe('shq', () => {
  it.each(['plain', "it's", "'", "''", '$(rm -rf /)', 'a\nb', ''])(
    'quotes %j as one word',
    (value) => {
      expect(bash(`printf '%s' ${shq(value)}`).stdout).toBe(value);
    },
  );
});

describe('the hardening script', () => {
  const script = hardenScript(['8.8.8.8', '2001:4860::/32']);

  // ADR-0022 items 4 and 7: the internet sees 80 and 443, and nothing else.
  it('opens SSH to the operator’s addresses alone, and 80 and 443 to everyone, from a reset firewall', () => {
    expect(script.match(/^ufw (allow|limit) .*$/gm)).toEqual([
      `ufw allow proto tcp from '8.8.8.8' to any port "$ssh_port"`,
      `ufw allow proto tcp from '2001:4860::/32' to any port "$ssh_port"`,
      'ufw allow 80/tcp',
      'ufw allow 443/tcp',
    ]);
    const order = ['ufw --force reset', 'ufw default deny incoming', 'ufw --force enable'];
    expect(order.map((line) => script.indexOf(line))).toEqual(
      [...order.map((line) => script.indexOf(line))].sort((a, b) => a - b),
    );
    expect(script.indexOf('ufw --force reset')).toBeGreaterThan(-1);
  });

  it.each([[[]], [["8.8.8.8'; reboot; '"]], [['8.8.8.8 1.1.1.1']]])(
    'refuses SSH addresses %j',
    (sshFrom) => {
      expect(() => hardenScript(sshFrom)).toThrow();
    },
  );

  it('checks Docker’s apt key against the published fingerprint, and that it is the only key', () => {
    expect(script).toContain("'9DC858229FC7DD38854AE2D88D81803C0EBFCD88'");
    expect(script).toContain('[ "$keys" != 1 ]');
  });

  it('waits for apt rather than failing on cloud-init’s lock', () => {
    expect(script).toContain('DPkg::Lock::Timeout=600');
    expect(script).not.toMatch(/^apt-get /m);
  });

  /**
   * The sshd steps run here against a stand-in `sshd` and `systemctl`: a
   * drop-in sshd rejects must be put back, or the next restart leaves the
   * host unreachable, and a reload that fails must fail the step, since
   * `sshd -T` reports what a new sshd would load, not what is running.
   */
  describe('the sshd step, run', () => {
    const sshdStep = script.slice(script.indexOf('install -d -m 0755 /etc/ssh/sshd_config.d'));

    function runStep(options: { sshdTest: number; reload: number; previous?: string }) {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ostomy-sshd-')));
      const bin = path.join(root, 'bin');
      const etc = path.join(root, 'etc');
      const dropIn = path.join(etc, 'sshd_config.d/00-ostomy-hardening.conf');
      mkdirSync(bin);
      mkdirSync(path.dirname(dropIn), { recursive: true });
      if (options.previous !== undefined) writeFileSync(dropIn, options.previous);
      const tool = (name: string, body: string) => {
        writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(path.join(bin, name), 0o755);
      };
      const enforced = [
        'passwordauthentication no',
        'kbdinteractiveauthentication no',
        'permitrootlogin without-password',
        'authenticationmethods publickey',
        'x11forwarding no',
        'allowagentforwarding no',
        'allowtcpforwarding local',
        'allowstreamlocalforwarding no',
        'permittunnel no',
      ].join('\\n');
      tool('sshd', `if [ "$1" = -t ]; then exit ${options.sshdTest}; fi\nprintf '${enforced}\\n'`);
      tool('systemctl', `exit ${options.reload}`);
      const result = bash(`set -euo pipefail\n${sshdStep.replaceAll('/etc/ssh', posix(etc))}`, {
        env: { ...process.env, PATH: `${posix(bin)}:/usr/bin:/bin` },
      });
      return { result, dropIn };
    }

    it('installs the drop-in when sshd accepts it and reloads', () => {
      const { result, dropIn } = runStep({ sshdTest: 0, reload: 0 });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(readFileSync(dropIn, 'utf8')).toContain('PasswordAuthentication no');
    });

    it('removes a new drop-in sshd rejects', () => {
      const { result, dropIn } = runStep({ sshdTest: 1, reload: 0 });
      expect(result.status).toBe(69);
      expect(existsSync(dropIn)).toBe(false);
    });

    it('puts back the previous drop-in when sshd rejects the new one', () => {
      const { result, dropIn } = runStep({ sshdTest: 1, reload: 0, previous: '# earlier\n' });
      expect(result.status).toBe(69);
      expect(readFileSync(dropIn, 'utf8')).toBe('# earlier\n');
    });

    it('fails when sshd cannot be reloaded', () => {
      const { result } = runStep({ sshdTest: 0, reload: 1 });
      expect(result.status).toBe(69);
      expect(result.stderr).toContain('not in force');
    });
  });

  it('turns off every non-key SSH login, and checks what sshd will actually enforce', () => {
    const encoded =
      /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d >"\$tmp"\nchmod '0644' "\$tmp"\nmv -f "\$tmp" '\/etc\/ssh\/sshd_config\.d\/00-ostomy-hardening\.conf'/.exec(
        script,
      );
    const sshd = Buffer.from(encoded![1]!, 'base64').toString('utf8');
    for (const line of [
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'AuthenticationMethods publickey',
      'AllowTcpForwarding local',
    ]) {
      expect(sshd).toContain(`\n${line}\n`);
    }
    expect(script).toContain("'passwordauthentication no'");
    expect(script).toContain('sshd -t');
  });
});

describe('bringing a release up', () => {
  // caddy, both PostgreSQL and Keycloak exist on a fresh host only if Compose
  // pulls them; `--pull never` failed every first init (PR #177 review).
  it('pulls the digest-pinned images a fresh host lacks, and builds nothing', () => {
    const up = upScript('v1.0.0', COMMIT);
    expect(up).toContain(' up --detach --no-build --pull missing ');
    expect(up).not.toContain('--pull never');
  });

  it('interpolates only image IDs of the expected shape into the load check', () => {
    expect(() => loadImagesScript({ ...IDS, api: 'sha256:abc"; reboot; "' }, 'v1.0.0')).toThrow(
      /not an image ID/,
    );
  });
});

describe('logs', () => {
  it('refuses a service the stack does not have, or an unbounded tail', () => {
    expect(() => logsScript('v1.0.0', COMMIT, 'api; rm -rf /' as Service, 10)).toThrow();
    expect(() => logsScript('v1.0.0', COMMIT, 'api', 0)).toThrow();
    expect(() => logsScript('v1.0.0', COMMIT, 'api', 100_000)).toThrow();
  });
});

describe('release names reach the host only from a safe alphabet', () => {
  it.each(["v1'; rm -rf /", '../etc', '-x', ''])('refuses %j', (name) => {
    expect(() => upScript(name, COMMIT)).toThrow();
  });
});

describe('parseProbe and the version gates', () => {
  it('reads a probe', () => {
    expect(
      parseProbe(
        'os=debian\ncodename=bookworm\narch=x86_64\nclassification=real\ndeployed=no\netc=yes\ncompose=v2.29.1\nvolumes=0\n' +
          'ssh_client=2001:4860::1\nssh_port=2222\nsshd_include=yes\n',
      ),
    ).toEqual({
      sshClient: '2001:4860::1',
      sshPort: '2222',
      sshdInclude: true,
      os: 'debian',
      codename: 'bookworm',
      arch: 'x86_64',
      classification: 'real',
      deployed: false,
      etc: true,
      compose: '2.29.1',
      volumes: 0,
    });
  });

  it.each([
    ['2.24.4', true],
    ['2.29.1', true],
    ['3.0.0', true],
    ['2.24.3', false],
    ['2.20.2', false],
    ['1.29.2', false],
    ['', false],
  ])('Compose %s is recent enough: %s', (version, ok) => {
    expect(composeIsRecentEnough(version)).toBe(ok);
  });

  it.each([
    ['x86_64', 'linux/amd64'],
    ['aarch64', 'linux/arm64'],
  ])('%s builds for %s', (arch, platform) => {
    expect(platformFor(arch)).toBe(platform);
  });
});
