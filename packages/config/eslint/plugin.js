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
 * Local ESLint plugin for project-specific rules.
 *
 * These are rules no off-the-shelf plugin gives us, and each exists because
 * CLAUDE.md or an ADR requires something that must fail the build rather than
 * rely on anyone remembering it.
 */

const LICENSE_MARKER = 'GNU Affero General Public License';

const HEADER_BODY = (year) => `Copyright (C) ${year} Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.`;

/**
 * Require the AGPL-3.0-or-later header on source files.
 *
 * Source: docs/license-header.md. Matches on the license phrase rather than
 * the exact text, so bumping the copyright year does not fail every file.
 */
const agplHeader = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require the AGPL-3.0-or-later license header at the top of source files in apps/ and packages/',
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: { year: { type: ['string', 'number'] } },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        'Missing AGPL-3.0-or-later license header. See docs/license-header.md. Run `pnpm lint:fix` to insert it.',
    },
  },
  create(context) {
    const year = context.options[0]?.year ?? new Date().getFullYear();
    return {
      Program(node) {
        const source = context.sourceCode ?? context.getSourceCode();
        const text = source.getText();

        // An empty file has nothing to license.
        if (text.trim() === '') return;

        const hasHeader = source
          .getAllComments()
          .some((c) => c.type === 'Block' && c.value.includes(LICENSE_MARKER));

        if (hasHeader) return;

        context.report({
          node,
          messageId: 'missing',
          fix(fixer) {
            const header = `/*\n${HEADER_BODY(year)}\n*/\n\n`;
            // Preserve a shebang or "use strict"-style prologue if present.
            const shebang = text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) : '';
            return shebang
              ? fixer.replaceTextRange([0, shebang.length], `${shebang}${header}`)
              : fixer.insertTextBeforeRange([0, 0], header);
          },
        });
      },
    };
  },
};

export default {
  meta: { name: '@ostomy/eslint-plugin', version: '0.0.1' },
  rules: {
    'agpl-header': agplHeader,
  },
};
