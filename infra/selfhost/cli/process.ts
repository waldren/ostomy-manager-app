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
 * Local processes, always spawned with an argument array and never through a
 * shell, so no value the operator types is ever parsed as shell syntax on
 * this machine. What runs on the host is a different matter: see `shq`.
 */
import { spawn } from 'node:child_process';

import { Unreachable } from './errors.ts';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Command {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs a command to completion. A missing executable is `Unreachable`. */
export function run(
  { command, args, cwd, env }: Command,
  options: { input?: string; inherit?: boolean } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: [
        options.input === undefined ? 'ignore' : 'pipe',
        options.inherit ? 'inherit' : 'pipe',
        options.inherit ? 'inherit' : 'pipe',
      ],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new Unreachable(`\`${command}\` is not installed or not on PATH`)
          : error,
      ),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/**
 * Runs `producer`, feeding its stdout into `consumer`'s stdin, as
 * `producer | consumer` would without a shell. Both must succeed.
 */
export function pipe(
  producer: Command,
  consumer: Command,
): Promise<{ producer: ProcessResult; consumer: ProcessResult }> {
  return new Promise((resolve, reject) => {
    const spawnOne = ({ command, args, cwd, env }: Command, stdin: 'ignore' | 'pipe') => {
      const child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        stdio: [stdin, 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.on('error', (error: NodeJS.ErrnoException) =>
        reject(
          error.code === 'ENOENT'
            ? new Unreachable(`\`${command}\` is not installed or not on PATH`)
            : error,
        ),
      );
      return child;
    };
    const from = spawnOne(producer, 'ignore');
    const to = spawnOne(consumer, 'pipe');
    from.stdout!.pipe(to.stdin!);
    // The consumer exiting early must not leave the producer blocked on a
    // full pipe, nor raise EPIPE as an unhandled error.
    to.stdin!.on('error', () => {});

    const results: { producer?: ProcessResult; consumer?: ProcessResult } = {};
    const collect = (
      child: ReturnType<typeof spawnOne>,
      key: 'producer' | 'consumer',
      captureStdout: boolean,
    ) => {
      let stdout = '';
      let stderr = '';
      if (captureStdout)
        child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('close', (code) => {
        results[key] = { code: code ?? 1, stdout, stderr };
        if (results.producer && results.consumer) {
          resolve({ producer: results.producer, consumer: results.consumer });
        }
      });
    };
    collect(from, 'producer', false);
    collect(to, 'consumer', true);
  });
}

/**
 * Quotes `value` as one word for a POSIX shell, the host's.
 *
 * Every value this tool interpolates into a script that runs on the host goes
 * through here, even ones already validated to a safe alphabet: the script
 * runs as root, and validation is the second line rather than the only one.
 */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
