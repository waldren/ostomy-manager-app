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
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';

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
 *
 * Either side ending early ends the other. Without that, a consumer that
 * exits mid-transfer (ssh losing the network) leaves the producer blocked on
 * a full pipe, and the promise never settles (PR #177 review).
 */
export function pipe(
  producer: Command,
  consumer: Command,
): Promise<{ producer: ProcessResult; consumer: ProcessResult }> {
  return new Promise((resolve, reject) => {
    let failed = false;
    const children: ChildProcess[] = [];
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      for (const child of children) child.kill();
      reject(error);
    };
    const spawnOne = ({ command, args, cwd, env }: Command, stdin: 'ignore' | 'pipe') => {
      const child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        stdio: [stdin, 'pipe', 'pipe'],
        windowsHide: true,
      });
      children.push(child);
      child.on('error', (error: NodeJS.ErrnoException) =>
        fail(
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
    // EPIPE when the consumer has gone; its exit code reports the failure.
    to.stdin!.on('error', () => {});

    const results: { producer?: ProcessResult; consumer?: ProcessResult } = {};
    const collect = (child: ChildProcess, key: 'producer' | 'consumer', captureStdout: boolean) => {
      let stdout = '';
      let stderr = '';
      if (captureStdout)
        child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('close', (code, signal) => {
        results[key] = { code: exitCode(code, signal), stdout, stderr };
        if (key === 'consumer' && !results.producer) {
          // Nothing reads the producer's output any more: drain it, so it
          // can never block on a full pipe. Stop it only if the consumer
          // failed: after a consumer that succeeded, the producer has
          // normally finished and only its own exit is still to arrive.
          from.stdout!.unpipe();
          from.stdout!.resume();
          if (results.consumer!.code !== 0) from.kill();
        }
        if (results.producer && results.consumer && !failed) {
          resolve({ producer: results.producer, consumer: results.consumer });
        }
      });
    };
    collect(from, 'producer', false);
    collect(to, 'consumer', true);
  });
}

/** A child's exit as a shell reports it: its code, or 128 plus the signal that ended it. */
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal ? 128 + (constants.signals[signal] ?? 0) : 1;
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
