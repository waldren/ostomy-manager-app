# License Header for Source Files

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see the root `LICENSE` file for the full text.

Add this header (with the year updated as needed) to the top of new source files as they're created in `apps/` and `packages/`:

```
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
```

For TypeScript/JavaScript files, wrap it as a `/* ... */` block comment at the top of the file.

## What AGPL-3.0 means for this project
- Anyone can use, modify, and redistribute this code, including commercially.
- If someone modifies the code and runs it as a network-accessible service (not just redistributes it), they must make their modified source available to users of that service. This is the key difference from the plain GPL, and it's the reason AGPL was chosen: it prevents a hosted fork of this app from going closed-source.
- Any distributed modified version must also stay under AGPL-3.0-or-later.
