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
 * ADR-0022 item 3, against real git and real SSH signatures: a real host
 * runs only a tag signed by a key the operator environment lists, and only
 * from a checkout of that tag.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { Refusal } from './errors.ts';
import { readAtCommit, requireCheckoutIs, resolveRelease, verifySignedTag } from './release.ts';
import { commit, git, newRepo, signedTag, signingKey, type SigningKey } from './test-support.ts';

describe('signed release tags', () => {
  let repo: string;
  let operator: SigningKey;
  let stranger: SigningKey;
  let released: string;

  beforeAll(() => {
    operator = signingKey('operator');
    stranger = signingKey('stranger');
    ({ repo, first: released } = newRepo({ 'README.md': 'v1\n' }));
    signedTag(repo, 'v1.0.0', operator.privateKey);
    signedTag(repo, 'v1.0.0-stranger', stranger.privateKey);
    git(repo, 'tag', '-a', 'v1.0.0-unsigned', '-m', 'not signed');
    git(repo, 'tag', 'v1.0.0-light');
  });

  it('accepts a tag signed by a listed key, and returns its commit', async () => {
    await expect(verifySignedTag(repo, 'v1.0.0', operator.allowedSigners)).resolves.toBe(released);
  });

  it.each([
    ['v1.0.0-stranger', /does not verify/],
    ['v1.0.0-unsigned', /not signed with an SSH key/],
    ['v1.0.0-light', /lightweight tag/],
    ['v9.9.9', /no tag v9\.9\.9/],
    ['--upload-pack=x', /not a release tag name/],
  ])('refuses %s', async (tag, message) => {
    await expect(verifySignedTag(repo, tag, operator.allowedSigners)).rejects.toThrow(message);
  });

  // git picks the signature format from the last block in the object. A
  // message quoting an SSH block, followed by an OpenPGP one, must not pass as
  // SSH-signed and then be verified against this machine's gpg keyring.
  it('refuses a tag whose last signature block is not SSH, whatever its message quotes', async () => {
    const object = [
      `object ${released}`,
      'type commit',
      'tag v1.0.0-pgp',
      'tagger Test Operator <operator@example.test> 1700000000 +0000',
      '',
      'release',
      '-----BEGIN SSH SIGNATURE-----',
      '-----END SSH SIGNATURE-----',
      '-----BEGIN PGP SIGNATURE-----',
      '',
      'AAAA',
      '-----END PGP SIGNATURE-----',
      '',
    ].join('\n');
    const id = execFileSync('git', ['-C', repo, 'mktag'], {
      input: object,
      encoding: 'utf8',
    }).trim();
    git(repo, 'update-ref', 'refs/tags/v1.0.0-pgp', id);
    await expect(verifySignedTag(repo, 'v1.0.0-pgp', operator.allowedSigners)).rejects.toThrow(
      /not signed with an SSH key alone/,
    );
  });

  it('refuses a ref renamed to point at another release’s signed tag object', async () => {
    const object = git(repo, 'rev-parse', 'refs/tags/v1.0.0');
    git(repo, 'update-ref', 'refs/tags/v2.0.0', object);
    await expect(verifySignedTag(repo, 'v2.0.0', operator.allowedSigners)).rejects.toThrow(
      /calls itself v1\.0\.0/,
    );
  });

  it('refuses an allowed-signers file inside the repository, which the development host can write', async () => {
    const inside = path.join(repo, 'allowed_signers');
    copyFileSync(operator.allowedSigners, inside);
    await expect(verifySignedTag(repo, 'v1.0.0', inside)).rejects.toThrow(/inside the repository/);
  });

  it('refuses an allowed-signers file that does not exist', async () => {
    await expect(verifySignedTag(repo, 'v1.0.0', path.join(repo, '..', 'missing'))).rejects.toThrow(
      /does not exist/,
    );
  });

  describe('resolveRelease', () => {
    it('for a real host, takes only a signed tag and needs the allowed signers', async () => {
      await expect(
        resolveRelease(repo, 'main', {
          requireSigned: true,
          allowedSigners: operator.allowedSigners,
        }),
      ).rejects.toThrow(Refusal);
      await expect(
        resolveRelease(repo, 'v1.0.0', { requireSigned: true, allowedSigners: undefined }),
      ).rejects.toThrow(/--allowed-signers/);
      await expect(
        resolveRelease(repo, 'v1.0.0', {
          requireSigned: true,
          allowedSigners: operator.allowedSigners,
        }),
      ).resolves.toEqual({ name: 'v1.0.0', commit: released, signedTag: 'v1.0.0' });
    });

    it('for a synthetic host, takes any commit, named for it, and records it unsigned', async () => {
      await expect(
        resolveRelease(repo, 'main', { requireSigned: false, allowedSigners: undefined }),
      ).resolves.toEqual({
        name: `commit-${released.slice(0, 12)}`,
        commit: released,
      });
    });

    it('for a synthetic host, still verifies an annotated tag when given the signers', async () => {
      await expect(
        resolveRelease(repo, 'v1.0.0-stranger', {
          requireSigned: false,
          allowedSigners: operator.allowedSigners,
        }),
      ).rejects.toThrow(/does not verify/);
    });
  });

  it('reads a file as committed at the release, never the working copy', async () => {
    writeFileSync(path.join(repo, 'README.md'), 'edited after the release\n');
    await expect(readAtCommit(repo, released, 'README.md')).resolves.toBe('v1\n');
    git(repo, 'checkout', '--quiet', '--', 'README.md');
  });

  it('requires a real host’s tool to run from a clean checkout of the release itself', async () => {
    const release = { name: 'v1.0.0', commit: released, signedTag: 'v1.0.0' };
    await expect(requireCheckoutIs(repo, release)).resolves.toBeUndefined();

    writeFileSync(path.join(repo, 'README.md'), 'a local change\n');
    await expect(requireCheckoutIs(repo, release)).rejects.toThrow(/with local changes/);
    git(repo, 'checkout', '--quiet', '--', 'README.md');

    commit(repo, { 'later.txt': 'after the release\n' });
    await expect(requireCheckoutIs(repo, release)).rejects.toThrow(/clean checkout of v1\.0\.0/);
  });
});
