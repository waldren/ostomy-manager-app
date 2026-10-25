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

// P4.S6 (#168): creates the migration owner and its database, as the RDS
// master user. Run once per stack, before `db-migrate`; safe to re-run.
//
// The owner is the role ADR-0011 (Amendment 1) describes: LOGIN, CREATEROLE,
// CREATEDB, not a superuser, and not the master user. The master user only
// creates it. The DATABASE is then created by the owner itself, connected as
// the owner: on PostgreSQL 16+ a CREATEROLE role may not create a database
// OWNED BY a role it cannot SET ROLE to, and granting the master that
// membership is a privilege nobody needs.
'use strict';

const { connect, required, run } = require('./db-common.cjs');

run(async () => {
  const masterUser = required('DB_MASTER_USER');
  const ownerRole = required('DB_OWNER_ROLE');
  const ownerPassword = required('DB_OWNER_PASSWORD');
  const databaseName = required('DB_NAME');

  const master = await connect({
    user: masterUser,
    password: required('DB_MASTER_PASSWORD'),
    database: 'postgres',
  });
  try {
    const role = master.escapeIdentifier(ownerRole);
    const password = master.escapeLiteral(ownerPassword);
    const { rowCount } = await master.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      ownerRole,
    ]);
    // A re-run resets the password and the attributes, so the role always
    // matches what the secret and ADR-0011 say it is.
    const verb = rowCount === 0 ? 'CREATE' : 'ALTER';
    await master.query(`${verb} ROLE ${role} WITH LOGIN CREATEROLE CREATEDB PASSWORD ${password}`);
    console.log(`${verb === 'CREATE' ? 'created' : 'updated'} role ${ownerRole}`);
  } finally {
    await master.end();
  }

  const owner = await connect({ user: ownerRole, password: ownerPassword, database: 'postgres' });
  try {
    const { rowCount } = await owner.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (rowCount === 0) {
      await owner.query(`CREATE DATABASE ${owner.escapeIdentifier(databaseName)}`);
      console.log(`created database ${databaseName}`);
    } else {
      console.log(`database ${databaseName} already exists`);
    }
  } finally {
    await owner.end();
  }
});
