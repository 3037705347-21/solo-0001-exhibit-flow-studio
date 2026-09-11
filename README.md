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
- `src/features/collection`: searchable object library, validated editor, and workspace merge/reconciliation workbook.
- `src/features/journey`: sequenced zone lanes, placement commands, and constraint feedback.
- `src/features/review`: finding lifecycle, readiness gate, and snapshot export.
- `src/features/insights`: non-mutating visitor scenario controls and derived metrics.
- `src/components`: shared shell, navigation, forms, badges, metrics, dialogs, and visual primitives.

## Inputs and outputs

- Object records accept accession ID, title, maker, period, medium, origin, dimensions, dwell time, narrative role, sensitivity, access need, tags, and key-object status.
- Review findings accept severity, owner, optional zone/object links, and decision context.
- A successful readiness check enables a JSON file named `exhibit-flow-snapshot-YYYY-MM-DD.json` containing the project, sequenced zones, objects, summary metrics, and unresolved non-blocking issues.

## Merging another workspace

**Merge workspace** in the collection view imports a JSON file or pasted JSON shaped as `{ artifacts: [...], findings: [...] }` (snapshot exports with `zones[].artifacts` are also accepted). Reconciliation is identity-based:

- Objects match on normalized accession ID; findings match on title plus their linked object accession / zone short label, so re-importing the same file never duplicates records.
- Each conflicting field is shown side by side — current record, incoming record, and the merged result — and can be kept from either side; whole-record *keep current*, *take incoming*, and *accept merged* choices are available.
- Findings referencing objects or zones missing from both sides are blocked as reference conflicts until explicitly imported without the link or skipped.
- The commit button stays disabled until every conflict is decided; `applyMergePlan` is atomic, preserves artifact IDs so placements and finding links stay intact, and sweeps reference integrity before persisting. A blocked merge changes nothing.
- Merging content-affecting changes returns a `ready` project to `review`, matching other plan edits.

## Design notes

State-changing feature actions call typed workspace commands. Commands validate at the boundary, dispatch reducer events, and persist the complete workspace. Derived analysis is pure and can be recalculated for scenario projections without changing the saved plan.
