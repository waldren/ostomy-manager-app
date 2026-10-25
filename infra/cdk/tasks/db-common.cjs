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

// P4.S6 (#168): shared by the two one-off database tasks. CommonJS because
// it runs inside the API's `migrate-aws` image (infra/docker/api.Dockerfile),
// whose /app is apps/api's CommonJS package, and resolves `pg` from there.
'use strict';

const { createHash, createHmac, pbkdf2Sync, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Client } = require('pg');

/** A required environment variable, or a thrown error naming it. Never echoes a value. */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * TLS for every connection, verified against the RDS CA bundle baked into the
 * image (`DB_SSL_CA_FILE`). Turning it off takes `DB_TLS=off`, said in so many
 * words, which only the local integration test does: a missing CA file must
 * fail, not quietly connect in the clear.
 */
function tlsOptions() {
  if (process.env.DB_TLS === 'off') return false;
  return { ca: readFileSync(required('DB_SSL_CA_FILE'), 'utf8'), rejectUnauthorized: true };
}

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form PostgreSQL stores
 * (RFC 5802, RFC 7677), as a SQL literal for `PASSWORD ...`. PostgreSQL
 * stores a pre-hashed verifier as given, so the cleartext never reaches the
 * server, and so never reaches its log: a failing `ALTER ROLE` is logged with
 * its statement text by default (`log_min_error_statement=error`).
 *
 * Printable ASCII only, which SASLprep leaves unchanged; anything else would
 * need SASLprep here to match what a client sends at login, so it is refused
 * rather than stored as a verifier no login could satisfy.
 */
function scramVerifierLiteral(client, password) {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new Error('the password must be printable ASCII with no spaces');
  }
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (buffer) => buffer.toString('base64');
  return client.escapeLiteral(
    `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`,
  );
}

async function connect({ user, password, database }) {
  const client = new Client({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? '5432'),
    user,
    password,
    database,
    ssl: tlsOptions(),
  });
  await client.connect();
  return client;
}

/** Runs `main`, and exits non-zero with only the error's message, never a connection string. */
function run(main) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}

module.exports = { connect, required, run, scramVerifierLiteral };
