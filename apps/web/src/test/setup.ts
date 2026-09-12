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

import '@testing-library/jest-dom/vitest';

// Every component under test renders through react-i18next; initialize the
// real catalog once here rather than mocking useTranslation in every spec,
// so a spec asserting on visible text is asserting on the actual copy a
// patient or clinician would see.
import '../i18n/index.js';
