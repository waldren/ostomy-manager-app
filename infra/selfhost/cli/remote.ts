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
 * The host, reached over SSH. Every command runs as root through `bash -c`.
 *
 * Commands go through this interface rather than `ssh` directly so the
 * command logic can be tested against a fake host that records scripts.
 */
import { Refusal, Unreachable } from './errors.ts';
import { pipe, run, shq, type Command, type ProcessResult } from './process.ts';

export interface Remote {
  /** The SSH destination, as the operator typed it (`user@host` or an alias). */
  readonly target: string;
  /** Runs `script` as root. */
  exec(script: string): Promise<ProcessResult>;
  /** Runs `script` as root, with `producer`'s stdout as its stdin. */
  execFrom(producer: Command, script: string): Promise<ProcessResult>;
}

/** Runs `script`, and refuses with its stderr if it fails. */
export async function execOrRefuse(remote: Remote, script: string, what: string): Promise<string> {
  const result = await remote.exec(script);
  if (result.code !== 0) {
    throw new Refusal(
      `${what} failed on ${remote.target} (exit ${result.code}):\n${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Every connection's options, set here so the operator's ssh_config cannot
 * loosen them (PR #177 compliance review). Command-line options win over
 * ssh_config.
 *
 * - `BatchMode`: never prompt. A password prompt would mean the host still
 *   takes passwords.
 * - `StrictHostKeyChecking=yes`: an unknown or changed host key stops the
 *   tool. A config saying `accept-new` would otherwise trust whatever answers
 *   first; the operator checks the fingerprint against the provider's console
 *   once, by hand (README).
 * - No agent, X11 or port forwarding, and no local command: a synthetic host
 *   is one the development host has had root on, and a forwarded agent
 *   would let it use every key the agent holds, the release-signing key
 *   included, for as long as the session lasts.
 * - `ConnectTimeout`: a dropped connection reports unreachable promptly
 *   instead of waiting out the operating system's TCP timeout.
 */
export const SSH_OPTIONS: readonly string[] = [
  'BatchMode=yes',
  'StrictHostKeyChecking=yes',
  'ForwardAgent=no',
  'ForwardX11=no',
  'ClearAllForwardings=yes',
  'PermitLocalCommand=no',
  // Never ride a shared connection the operator's own ssh opened, whose
  // host key was checked under whatever options that ssh had.
  'ControlMaster=no',
  'ControlPath=none',
  // A pty would interpret bytes in the `docker save` stream and corrupt it.
  'RequestTTY=no',
  'UpdateHostKeys=no',
  'ConnectTimeout=15',
  'ServerAliveInterval=15',
  'ServerAliveCountMax=4',
].flatMap((option) => ['-o', option]);

/**
 * The command the host's login shell receives. As root it runs the script
 * directly; otherwise through `sudo -n`, which fails rather than prompts.
 * `SSH_CONNECTION` is carried through sudo because the hardening step reads
 * the SSH port from it, so the firewall never closes the port in use.
 */
export function remoteCommand(script: string): string {
  const wrapper =
    'S="$1"; if [ "$(id -u)" -eq 0 ]; then exec bash -c "$S"; ' +
    'else exec sudo -n env SSH_CONNECTION="$SSH_CONNECTION" bash -c "$S"; fi';
  return `sh -c ${shq(wrapper)} ostomy-host ${shq(script)}`;
}

export function sshCommand(target: string, script: string): Command {
  return { command: 'ssh', args: [...SSH_OPTIONS, '--', target, remoteCommand(script)] };
}

export class SshRemote implements Remote {
  readonly target: string;

  constructor(target: string) {
    // An argument starting with `-` would be read by ssh as an option.
    if (!/^[A-Za-z0-9_.@:[\]-]+$/.test(target) || target.startsWith('-')) {
      throw new Refusal(`not an SSH destination: ${JSON.stringify(target)}`);
    }
    this.target = target;
  }

  private command(script: string): Command {
    return sshCommand(this.target, script);
  }

  async exec(script: string): Promise<ProcessResult> {
    return this.checked(await run(this.command(script)));
  }

  async execFrom(producer: Command, script: string): Promise<ProcessResult> {
    const { producer: from, consumer } = await pipe(producer, this.command(script));
    // The host's answer first: when ssh drops or the script refuses, the
    // producer's failure is a consequence (it lost its reader), and the
    // operator needs the cause.
    const answer = this.checked(consumer);
    if (answer.code !== 0) return answer;
    if (from.code !== 0) {
      throw new Refusal(
        `\`${producer.command}\` failed (exit ${from.code}):\n${from.stderr.trim()}`,
      );
    }
    return answer;
  }

  /** ssh exits 255 for its own failures: unreachable, refused, unknown key. */
  private checked(result: ProcessResult): ProcessResult {
    if (result.code === 255) {
      throw new Unreachable(
        `could not reach ${this.target} over SSH:\n${result.stderr.trim()}\n` +
          'The host key must already be in known_hosts, checked against the provider console, ' +
          'and the key must be in your agent or ssh config.',
      );
    }
    if (result.code !== 0 && /sudo: a (terminal|password) is required/.test(result.stderr)) {
      throw new Refusal(`${this.target}: this user needs passwordless sudo, or connect as root`);
    }
    return result;
  }
}
