# ExhibitFlow Studio

ExhibitFlow Studio is an offline-first React workspace for museum exhibition teams. Curators can shape an object collection, designers can build a visitor journey, conservators can pin light/rest rotation schedules, reviewers can close findings, and the team can compare visitor scenarios before exporting a readiness snapshot.

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
- `src/features/collection`: searchable object library and validated editor.
- `src/features/journey`: sequenced zone lanes, placement commands, and constraint feedback.
- `src/features/rotation`: display/rest rotation plans, version-pinned batches, drift review, and schedule export.
- `src/features/review`: finding lifecycle, readiness gate, and snapshot export.
- `src/features/insights`: non-mutating visitor scenario controls and derived metrics.
- `src/components`: shared shell, navigation, forms, badges, metrics, dialogs, and visual primitives.

## Inputs and outputs

- Object records accept accession ID, title, maker, period, medium, origin, dimensions, dwell time, narrative role, sensitivity, access need, tags, and key-object status.
- Review findings accept severity, owner, optional zone/object links, and decision context.
- A successful readiness check enables a JSON file named `exhibit-flow-snapshot-YYYY-MM-DD.json` containing the project, sequenced zones, objects, summary metrics, unresolved non-blocking issues, and saved rotation plans.
- The rotation page exports `exhibit-flow-rotation-YYYY-MM-DD.json` (batches with pinned object/zone versions, effective status, and review reasons) and a CSV schedule named `exhibit-flow-rotation-schedule-YYYY-MM-DD.csv`. Workspaces saved before rotation shipped migrate safely and start with an empty plan list.

## Design notes

State-changing feature actions call typed workspace commands. Commands validate at the boundary, dispatch reducer events, and persist the complete workspace. Derived analysis is pure and can be recalculated for scenario projections without changing the saved plan.
