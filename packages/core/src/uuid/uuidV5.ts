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
 * UUIDv5 assembly (RFC 9562 §5.5), kept out of `src/sync` because it is byte
 * arithmetic, and that directory's guard refuses numeric literals so no
 * transport bound can hide there (`no-hardcoded-transport-bounds.spec.ts`).
 * Nothing here is configuration: the offsets and masks are the RFC's.
 *
 * Internal: reached through `@ostomy/core/sync`'s re-export, not a subpath.
 */

/**
 * The bytes a UUIDv5 hashes (RFC 9562 §5.5): the namespace UUID's 16 bytes,
 * then the name in UTF-8.
 */
export function uuidV5HashInput(namespace: string, name: string): Uint8Array {
  const hex = namespace.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new TypeError('The namespace must be a UUID.');
  const nameBytes = utf8(name);
  const input = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i += 1) input[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  return input;
}

/** A UUIDv5 from the SHA-1 of `uuidV5HashInput` (RFC 9562 §5.5). */
export function uuidV5FromSha1(sha1: Uint8Array): string {
  if (sha1.length < 16) throw new TypeError('A SHA-1 digest is 20 bytes.');
  const bytes = Array.from(sha1.slice(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC variant
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * UTF-8 bytes of a string, by hand rather than with `TextEncoder`.
 *
 * This package is compiled with neither the DOM nor Node's type definitions
 * (the web image's build proved it: `Cannot find name 'TextEncoder'`), and
 * pulling either in for one call would let the rest of the package use APIs
 * one of its three runtimes may lack. A lone surrogate is encoded as U+FFFD,
 * as `TextEncoder` does.
 */
export function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    let point = char.codePointAt(0) as number;
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point < 0x80) {
      bytes.push(point);
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}
