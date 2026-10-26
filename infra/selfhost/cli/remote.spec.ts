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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Refusal } from './errors.ts';
import { sshCommand, SshRemote, SSH_OPTIONS } from './remote.ts';

describe('the SSH connection', () => {
  /**
   * `ssh -G` prints the settings a connection would use, after every config
   * file. The config here loosens everything the tool depends on, as an
   * operator's own ~/.ssh/config might; the tool's options must still win.
   */
  it('keeps host-key checking strict and forwards nothing, whatever ssh_config says', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ostomy-ssh-'));
    const config = path.join(dir, 'config');
    writeFileSync(
      config,
      [
        'Host *',
        '  StrictHostKeyChecking accept-new',
        '  ForwardAgent yes',
        '  ForwardX11 yes',
        '  PermitLocalCommand yes',
        '  LocalCommand echo leaked',
        '  LocalForward 9000 127.0.0.1:9000',
        '  BatchMode no',
        '',
      ].join('\n'),
    );
    const { args } = sshCommand('operator@host.example.test', 'true');
    const options = args.slice(0, args.indexOf('--'));
    const effective = execFileSync('ssh', ['-F', config, '-G', ...options, 'host.example.test'], {
      encoding: 'utf8',
    })
      .toLowerCase()
      .split(/\r?\n/);
    for (const line of [
      'batchmode yes',
      'stricthostkeychecking true',
      'forwardagent no',
      'forwardx11 no',
      'permitlocalcommand no',
      'clearallforwardings yes',
      'connecttimeout 15',
    ]) {
      expect(effective).toContain(line);
    }
  });

  it('puts every option before the destination, and refuses a destination that reads as an option', () => {
    const { args } = sshCommand('operator@host.example.test', 'true');
    expect(args.slice(0, SSH_OPTIONS.length)).toEqual(SSH_OPTIONS);
    expect(args[SSH_OPTIONS.length]).toBe('--');
    expect(() => new SshRemote('-oProxyCommand=evil')).toThrow(Refusal);
  });
});
