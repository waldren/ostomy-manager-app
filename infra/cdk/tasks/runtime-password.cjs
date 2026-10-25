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

// P4.S6 (#168): gives the runtime role its LOGIN and password, as the
// migration owner. Runs inside `db-migrate`, after `prisma migrate deploy`
// has created `ostomy_runtime` (NOLOGIN, no password: the migration never
// holds a secret). The staging equivalent of infra/docker-compose.yml's
// `db-roles` service. Safe to re-run; a re-run is how the password rotates.
'use strict';

const { connect, required, run } = require('./db-common.cjs');

run(async () => {
  const runtimeRole = required('DB_RUNTIME_ROLE');
  const owner = await connect({
    user: required('DB_OWNER_ROLE'),
    password: required('DB_OWNER_PASSWORD'),
    database: required('DB_NAME'),
  });
  try {
    await owner.query(
      `ALTER ROLE ${owner.escapeIdentifier(runtimeRole)} WITH LOGIN PASSWORD ${owner.escapeLiteral(
        required('DB_RUNTIME_PASSWORD'),
      )}`,
    );
    console.log(`set the password for ${runtimeRole}`);
  } finally {
    await owner.end();
  }
});
