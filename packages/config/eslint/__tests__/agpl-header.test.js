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

import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import plugin from '../plugin.js';

RuleTester.describe = describe;
RuleTester.it = it;

const rule = plugin.rules['agpl-header'];

// Written out rather than imported from the rule. The licence header is not an
// implementation detail — if someone changes its wording, this test should
// fail rather than silently agree with them.
const HEADER = `/*
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

`;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('agpl-header', rule, {
  valid: [
    { name: 'header at top', code: `${HEADER}export const a = 1;`, options: [{ year: 2026 }] },
    { name: 'empty file', code: '', options: [{ year: 2026 }] },
    { name: 'whitespace-only file', code: '\n  \n', options: [{ year: 2026 }] },
    {
      name: 'shebang then header',
      code: `#!/usr/bin/env node\n${HEADER}export const a = 1;`,
      options: [{ year: 2026 }],
    },
  ],

  invalid: [
    {
      name: 'no header at all',
      code: 'export const a = 1;',
      options: [{ year: 2026 }],
      errors: [{ messageId: 'missing' }],
      output: `${HEADER}export const a = 1;`,
    },
    {
      // Regression: indexOf('\n') returns -1 here. Treating that as offset 0
      // inserted the header ABOVE the shebang, producing
      // "'#!' can only be used at the start of a file" — the autofixer
      // corrupting a file it was asked to repair.
      name: 'shebang with no trailing newline',
      code: '#!/usr/bin/env node',
      options: [{ year: 2026 }],
      errors: [{ messageId: 'missing' }],
      output: `#!/usr/bin/env node\n${HEADER}`,
    },
    {
      name: 'shebang with newline, no header',
      code: '#!/usr/bin/env node\nexport const a = 1;',
      options: [{ year: 2026 }],
      errors: [{ messageId: 'missing' }],
      output: `#!/usr/bin/env node\n${HEADER}export const a = 1;`,
    },
    {
      // A leading doc comment that is not the licence must not satisfy the rule.
      name: 'leading JSDoc without the licence',
      code: '/** Does a thing. */\nexport const a = 1;',
      options: [{ year: 2026 }],
      errors: [{ messageId: 'missing' }],
      output: `${HEADER}/** Does a thing. */\nexport const a = 1;`,
    },
    {
      // Regression: getAllComments().some() ignored position, so a file merely
      // quoting the licence lower down passed. meta.docs says "at the top".
      name: 'licence text present but not at the top',
      code: `export const a = 1;\n\n/*\nGNU Affero General Public License\n*/`,
      options: [{ year: 2026 }],
      errors: [{ messageId: 'missing' }],
      output: `${HEADER}export const a = 1;\n\n/*\nGNU Affero General Public License\n*/`,
    },
  ],
});
