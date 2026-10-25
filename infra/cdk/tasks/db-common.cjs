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

module.exports = { connect, required, run };
