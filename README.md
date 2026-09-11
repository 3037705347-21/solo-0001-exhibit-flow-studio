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
npm run build       # TypeScript and Vite production build
npm run test        # Vitest unit tests
npm run test:e2e    # Playwright browser workflows
npm run check       # all checks in sequence
```

## Directory structure

- `src/domain`: entities, validation boundaries, journey analysis, state transitions, readiness, and scenario projection.
- `src/state`: reducer commands, selectors, seed data, and local persistence.
- `src/features/collection`: searchable object library, validated editor, and CSV import wizard.
- `src/features/journey`: sequenced zone lanes, placement commands, and constraint feedback.
- `src/features/review`: finding lifecycle, readiness gate, and snapshot export.
- `src/features/insights`: non-mutating visitor scenario controls and derived metrics.
- `src/components`: shared shell, navigation, forms, badges, metrics, dialogs, and visual primitives.

## Inputs and outputs

- Object records accept accession ID, title, maker, period, medium, origin, dimensions, dwell time, narrative role, sensitivity, access need, tags, and key-object status.
- **Collection CSV import** (`Import CSV` on the collection page) parses headers before touching the workspace and shows a row-by-row preview classified as *new*, *safe update*, *conflict with an existing accession ID*, or *field error*. Commas, double quotes (including escaped `""`), embedded newlines, blank lines, ragged rows, repeated accession IDs, and illegal numbers/enums are handled by an RFC-4180 parser. Existing objects are never overwritten unless the reviewer explicitly allows updates; conflicts can alternatively be skipped. Confirmation writes the whole batch in a single reducer commit and persistence write — any error or cancellation leaves the workspace, journey unplaced queue, and stored state exactly as they were.
- Review findings accept severity, owner, optional zone/object links, and decision context.
- A successful readiness check enables a JSON file named `exhibit-flow-snapshot-YYYY-MM-DD.json` containing the project, sequenced zones, objects, summary metrics, and unresolved non-blocking issues.

## Design notes

State-changing feature actions call typed workspace commands. Commands validate at the boundary, dispatch reducer events, and persist the complete workspace. Derived analysis is pure and can be recalculated for scenario projections without changing the saved plan.
