# ExhibitFlow Studio - Project Specification

## Goal

ExhibitFlow Studio is an offline-first browser workspace for museum exhibition teams. It helps curators turn a set of exhibit objects into a coherent visitor journey, check practical placement constraints, and close review findings before a plan is marked ready.

The application is a pure frontend project. It does not require accounts, a server, or online services; data is stored in the browser and can be reset to a built-in sample plan.

## Users

- Curators define the story, object records, and interpretive emphasis.
- Exhibition designers arrange objects into sequenced zones and estimate dwell time.
- Accessibility reviewers flag placement or interpretation issues and verify resolutions.

## Core entities

- `Project`: the exhibition title, venue, visitor target, opening date, and readiness state.
- `Artifact`: an object or media element with a period, medium, dimensions, narrative role, sensitivity, accessibility needs, and estimated dwell time.
- `Zone`: a sequenced part of the visitor journey with a theme, capacity, color, and artifact placements.
- `Placement`: the assignment of an artifact to a zone and a position in that zone.
- `ReviewIssue`: a severity-ranked finding linked to a zone or artifact, with open, in-progress, or resolved state.
- `Snapshot`: a frozen readiness summary used for local export and comparison.
- `ChecklistHandoff`: a frozen, versioned zone-checklist export recording usage scope, receiving members, the readiness basis, and a content summary, so field teams can keep referencing a handed-off file while the plan evolves.

## Workflows

### 1. Curate the object set

The user opens the collection view, searches and filters existing objects, adds an object through a validated editor, and sees it enter the collection. Duplicate accession identifiers, missing titles, invalid dimensions, and invalid dwell times are rejected with field-level messages. The created object is persisted in local storage and becomes immediately available to the journey planner.

### 2. Build and validate the visitor journey

The user opens the journey view, assigns unplaced objects to zones, changes placement sequence, and moves objects between zones. The domain engine recalculates zone dwell time, density, narrative coverage, and accessibility constraints after every transition. A validation panel exposes blocking errors and warnings, and links findings back to affected zones.

### 3. Run a review to readiness

The user opens the review view, creates a finding linked to an object or zone, moves it from open to in progress to resolved, and requests a readiness check. The readiness engine combines unresolved blockers, unplaced required objects, and journey validation results. A ready plan can produce a downloadable JSON snapshot; a blocked plan explains exactly what remains.

Zone floor checklists can be frozen into versioned handoffs that capture the usage scope, receiving members, readiness basis, and a content digest at recording time. Later downloads are explicit: the current live state or a specific frozen handoff version. When placements, findings, or zone conditions change after a handoff, the recorded version stays byte-identical and re-downloadable, but the review view flags it as drifted from the current plan.

### 4. Compare planning scenarios

The user opens the insights view and adjusts the visitor pace and accessibility priority scenario controls. The projection engine recomputes expected visit length, pressure points, and coverage without mutating the saved plan. The user can apply a scenario as planning preferences or return to the baseline.

## State and rules

- Project state transitions are `draft -> review -> ready`; readiness can regress to `review` whenever a blocking change is introduced.
- Artifact accession identifiers are normalized and unique.
- Every artifact must have a positive dwell time and valid physical dimensions.
- A zone warns above 80% of its dwell capacity and blocks above 100%.
- High-sensitivity objects require a low-light zone.
- Objects marked as requiring seated interpretation must be placed in a zone with seating.
- Required narrative roles must be represented in the journey before readiness.
- Critical review issues block readiness until resolved.
- Scenario calculations are derived, cancellable UI state and never overwrite the saved plan unless explicitly applied.

## Modules and dependency direction

- `app`: application composition, routing, shell, providers, and page entry points.
- `domain`: entity types, validation, state transitions, journey analysis, readiness rules, and scenario projections.
- `state`: reducer, commands, persistence adapter, seed data, and selectors.
- `features`: collection, journey, review, and insights vertical slices using public state commands.
- `components`: reusable interface primitives, charts, navigation, feedback, and modal infrastructure.

Feature pages call state commands. State commands validate through the domain module before updating and persisting state. Derived selectors call pure domain analysis functions. Components do not mutate domain state directly.

## Public interfaces

- Browser routes: `/collection`, `/journey`, `/review`, and `/insights`.
- `WorkspaceProvider` exposes typed commands and derived state to pages.
- Local persistence key: `exhibit-flow.workspace.v1`.
- JSON snapshot download: `exhibit-flow-snapshot-<date>.json`.

## Validation plan

- TypeScript compilation and Vite production build.
- Vitest unit tests for artifact validation, journey constraint analysis, transitions, reducer commands, persistence fallback, and readiness.
- Playwright browser workflow checks for each of the four workflows using the public routes and visible controls.
- Generic project audit verifies source scale, manifest consistency, and every declared command.

## Intentionally omitted

- Multi-user collaboration and remote synchronization.
- Authentication, permissions, and server APIs.
- Floor-plan CAD drawing and image uploads.
- External collection-management-system integrations.
