# ExhibitFlow Studio

ExhibitFlow Studio is an offline-first React workspace for museum exhibition teams. Curators can shape an object collection, designers can build a visitor journey, reviewers can close findings, and the team can compare visitor scenarios before exporting a readiness snapshot.

## Run locally

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. The app uses the browser's local storage key `exhibit-flow.workspace.v1`; no network services or environment variables are required. Use **Reset sample plan** in the sidebar to restore the built-in exhibition.

## Backup, versioned migration, and recovery

**Backup & restore** in the sidebar (gear button) is the single entry point for workspace files:

1. **Detect** — the importer identifies the original version (versioned workspace file, legacy `version: 1` state, or pre-sequence unversioned exports) and rejects readiness snapshots, which are reports rather than editable plans.
2. **Migrate in order** — each step (e.g. `v0 → v1` assigns zone sequence and converts dwell seconds to minutes; `v1 → v2` adds plan codes and the target visit length) is listed before any write.
3. **Review** — every record is shown as **Added**, **Kept**, **Invalidated**, or **Needs confirmation**. Salvageable records are kept by default; toggle any flagged row to drop it. Dangling references and duplicate placements are always removed, never invented.
4. **Recover once** — the reviewed state passes the same structural validation used by the sample plan, then replaces storage in one validated write. The previous workspace is captured and can be rolled back from the sidebar (**Undo last recovery**); if validation or the write itself fails, the original workspace and storage stay usable.
5. **Re-export** — the current version downloads as `exhibit-flow-workspace-YYYY-MM-DD.json`, an envelope that re-enters the same import path. Old-version files keep loading silently on startup; the read path has no regression.

Current schema version: **2**. New in v2: `project.planCode`, `preferences.targetVisitMinutes` (editable on the Insights page), and recovery provenance (`restoredFrom`).


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
- `src/features/review`: finding lifecycle, readiness gate, and snapshot export.
- `src/features/insights`: non-mutating visitor scenario controls and derived metrics.
- `src/components`: shared shell, navigation, forms, badges, metrics, dialogs, and visual primitives.

## Inputs and outputs

- Object records accept accession ID, title, maker, period, medium, origin, dimensions, dwell time, narrative role, sensitivity, access need, tags, and key-object status.
- Review findings accept severity, owner, optional zone/object links, and decision context.
- A successful readiness check enables a JSON file named `exhibit-flow-snapshot-YYYY-MM-DD.json` containing the project, sequenced zones, objects, summary metrics, and unresolved non-blocking issues.

## Design notes

State-changing feature actions call typed workspace commands. Commands validate at the boundary, dispatch reducer events, and persist the complete workspace. Derived analysis is pure and can be recalculated for scenario projections without changing the saved plan.
