# ExhibitFlow Studio

ExhibitFlow Studio is an offline-first React workspace for museum exhibition teams. Curators can shape an object collection, designers can build a visitor journey, reviewers can close findings, and the team can compare visitor scenarios before exporting a readiness snapshot.

## Run locally

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. The app uses the browser's local storage key `exhibit-flow.workspace.v1`; no network services or environment variables are required. Use **Reset sample plan** in the sidebar to restore the built-in exhibition.

## Validation commands

```bash
npm run lint          # ESLint (typescript-eslint + react-hooks) over the whole repo
npm run lint:fix      # ESLint with autofix
npm run format        # Prettier write
npm run format:check  # Prettier check (no writes)
npm run typecheck     # tsc project references, no emit
npm run check:fast    # lint + typecheck + unit tests, no browser needed
npm run build         # TypeScript and Vite production build
npm run test          # Vitest unit tests
npm run test:e2e      # Playwright browser workflows
npm run check         # check:fast + build + e2e (full gate, use in CI)
```

## Commit gate

A Husky pre-commit hook runs on every `git commit`:

1. `lint-staged` auto-fixes ESLint and Prettier issues in the staged files and re-stages them. Formatting is enforced incrementally here: the existing codebase was not reformatted wholesale, so files adopt the Prettier style the first time you touch them.
2. `npm run check:fast` must pass — lint, type check, and unit tests. Playwright is intentionally not part of the commit gate; it runs in `npm run check` / CI.

If the hook fails, the commit is rejected and the failing command's output (ESLint errors, Prettier file list, `tsc` errors, or the Vitest failure summary) is printed directly in the terminal. Fix the problem — or run `npm run lint:fix && npm run format` — and commit again. For a genuine emergency you can bypass the hook once with `git commit --no-verify`; the full gate still runs in CI, so the bypass only defers the failure.

## Setup for new contributors

```bash
npm install                  # installs dependencies and enables the Git hook via the prepare script
npx playwright install       # only needed for npm run test:e2e / npm run check
```

On Linux, browser system libraries are also required: `npx playwright install --with-deps chromium` (needs sudo), or use the official Playwright container image in CI. In rootless containers, download the Debian packages (`apt-get download libnspr4 libnss3 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libasound2 libatk1.0-0 libatspi2.0-0 libdbus-1-3 libgbm1 libxi6 libdrm2 libwayland-server0`), extract them with `dpkg-deb -x` into a local prefix, and point `LD_LIBRARY_PATH` at it — this workspace keeps such a prefix in `.syslibs/` (gitignored).

Node.js 20.19+ (22+ recommended). `jsdom` is pinned to 29.x because 30.x requires Node 22.

## Directory structure

- `src/domain`: entities, validation boundaries, journey analysis, state transitions, readiness, and scenario projection.
- `src/state`: reducer commands, selectors, seed data, and local persistence.
- `src/features/collection`: searchable object library and validated editor.
- `src/features/journey`: sequenced zone lanes, placement commands, and constraint feedback.
- `src/features/review`: finding lifecycle, readiness gate, and snapshot export.
- `src/features/insights`: non-mutating visitor scenario controls and derived metrics.
- `src/components`: shared shell, navigation, forms, badges, metrics, dialogs, and visual primitives.

## Inputs and outputs

- Object records accept accession ID, title, maker, period, medium, origin, dimensions, dwell time, narrative role, sensitivity, access need, tags, and key-object status.
- Review findings accept severity, owner, optional zone/object links, and decision context.
- A successful readiness check enables a JSON file named `exhibit-flow-snapshot-YYYY-MM-DD.json` containing the project, sequenced zones, objects, summary metrics, and unresolved non-blocking issues.

## Design notes

State-changing feature actions call typed workspace commands. Commands validate at the boundary, dispatch reducer events, and persist the complete workspace. Derived analysis is pure and can be recalculated for scenario projections without changing the saved plan.
