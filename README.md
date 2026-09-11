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
- `src/features/review`: finding lifecycle, readiness gate, and snapshot export.
- `src/features/insights`: non-mutating visitor scenario controls and derived metrics.
- `src/components`: shared shell, navigation, forms, badges, metrics, dialogs, and visual primitives.

## Inputs and outputs

- Object records accept accession ID, title, maker, period, medium, origin, dimensions, dwell time, narrative role, sensitivity, access need, tags, and key-object status.
- Review findings accept severity, owner, optional zone/object links, and decision context.
- A successful readiness check enables a JSON file named `exhibit-flow-snapshot-YYYY-MM-DD.json` containing the project, sequenced zones, objects, summary metrics, and unresolved non-blocking issues.
- **Export workspace** downloads `exhibit-flow-workspace-v2-YYYY-MM-DD.json`, a versioned envelope of the whole workspace. **Import & restore** detects the source version, shows ordered migration steps and every added / kept / invalidated / needs-confirmation record, then performs a transactional restore that can be undone. Readiness snapshots are intentionally not restorable.

## Versioned migration and recovery

Every workspace-shaped input — imported files, automatic startup loads, and the built-in sample plan — passes through `normalizeWorkspaceShape` in `src/domain/workspaceValidation.ts`. Import planning (`planWorkspaceMigration` in `src/state/migrations.ts`) is pure: it detects the source version (`0` for pre-versioned exports, `1`, or the current `2`), produces one report per ordered migration step, and never writes. Records referencing missing artifacts or zones are surfaced as per-record confirmations; nothing is guessed.

The actual write runs through `commitRestore` in `src/state/restore.ts`: the existing workspace is copied to `exhibit-flow.workspace.restore-backup.v1` before the main key is replaced, and a failed write rolls straight back. A backup left behind by a closed tab or crash triggers automatic rollback on the next startup (`recoverInterruptedRestore`), so an interrupted restore can never strand the team on a half-written workspace.

## Design notes

State-changing feature actions call typed workspace commands. Commands validate at the boundary, dispatch reducer events, and persist the complete workspace. Derived analysis is pure and can be recalculated for scenario projections without changing the saved plan.
