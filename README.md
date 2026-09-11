# ExhibitFlow Studio

ExhibitFlow Studio is an offline-first React workspace for museum exhibition teams. Curators can shape an object collection, designers can build a visitor journey, reviewers can close findings, and the team can compare visitor scenarios before exporting a readiness snapshot.

## Run locally

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. The app uses the browser's local storage key `exhibit-flow.workspace.v1`; no network services or environment variables are required. Use **Reset sample plan** in the sidebar to restore the built-in exhibition.

### Working in several tabs

The workspace is versioned. Every autosave carries a monotonically increasing **revision**, and a tab can only commit a write when storage still holds the revision that write was based on (compare-and-swap). If another tab has already moved the workspace forward, the stale tab does **not** overwrite it: a dialog shows both sides of the change — your unsaved change and the change already saved in the other tab — grouped by object, placement, finding, or planning preferences.

- **Reload newer version** adopts the saved revision and discards the local attempt.
- **Redo my change** replays your intents on top of the newest revision. Placements keep the position they had in your tab; findings, object edits, and preferences are merged where they touch different records. When the two sides edit the same record, redo is gated behind an explicit “I have compared the changes” confirmation; illegal replays (missing records, duplicate accession IDs, dangling links) are reported instead of written.
- **Close** hides the dialog but keeps a persistent banner so the unresolved conflict is never silently forgotten.

Tabs with no in-flight edit transparently adopt newer revisions, so ordinary single-tab editing stays fully automatic. If a write cannot reach browser storage (quota, private mode, temporary failure), the change stays in the tab, the sidebar indicator switches to *Local save unavailable*, and the commit retries on focus/online/timer without ever replacing the last good document. A document that cannot be parsed is moved aside to `exhibit-flow.workspace-recovered.v1` instead of being deleted, and the sample plan opens for the session.

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

State-changing feature actions call typed workspace commands. Commands validate at the boundary, dispatch reducer events, and persist the complete workspace through a revision compare-and-swap in the local persistence adapter. Each stored document is an envelope (`format`, `formatVersion`, `revision`, `writtenAt`, `workspace`); a pre-envelope bare v1 document is wrapped transparently on first load. Derived analysis is pure and can be recalculated for scenario projections without changing the saved plan.
