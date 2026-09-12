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
- `src/features/collection`: searchable object library and validated editor.
- `src/features/journey`: sequenced zone lanes, placement commands, and constraint feedback.
- `src/features/review`: finding lifecycle, readiness gate, versioned rule archive, and snapshot export.
- `src/features/insights`: non-mutating visitor scenario controls and derived metrics.
- `src/components`: shared shell, navigation, forms, badges, metrics, dialogs, and visual primitives.

## Versioned review rule archive

Capacity warning/block lines, density lines, low-light and seating enforcement, narrative-role requirements, key-object gating, critical-finding gating, and score penalties live in an immutable **rule profile** (`src/domain/ruleProfiles.ts`). Each workspace stores a growing archive of profile versions, and each project is **bound** to one exact version:

- Changing a rule always appends a new immutable version (`rules/publish`); an existing version can never be edited. Publishing does **not** rebind the project.
- Before switching to an existing version (or publishing a draft), the rules page dry-runs the current plan against the candidate and shows the exact impact (new/cleared blockers, warnings, score change). The switch is a separate explicit action; a ready plan regresses to review.
- Old projects keep their bound version until explicitly upgraded, so later rule changes never reinterpret historical results.
- Every readiness run is recorded in `readinessRuns` pinned to the `profileId#version` used. Published snapshots are schema v2: they embed both the `ruleArchive` reference and the full readable `ruleProfile`, and the readiness result must match the profile used to build the package. The zone checklist CSV also names the archive version.
- On load, the binding is resolved explicitly. A missing binding, an unknown version, or a corrupt profile does **not** fall back to default thresholds: calculation surfaces show a blocking banner and readiness/snapshot commands refuse to run until the project is rebound to a version stored locally. v1 workspaces are migrated by pinning them to standard rules v1 (the historical hard-coded thresholds).

## Inputs and outputs

- Object records accept accession ID, title, maker, period, medium, origin, dimensions, dwell time, narrative role, sensitivity, access need, tags, and key-object status.
- Review findings accept severity, owner, optional zone/object links, and decision context.
- A successful readiness check enables a JSON file named `exhibit-flow-snapshot-YYYY-MM-DD.json` containing the project, sequenced zones, objects, summary metrics, and unresolved non-blocking issues.

## Design notes

State-changing feature actions call typed workspace commands. Commands validate at the boundary, dispatch reducer events, and persist the complete workspace. Derived analysis is pure and can be recalculated for scenario projections without changing the saved plan.
