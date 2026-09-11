import type {
  Artifact,
  ImportBatch,
  LineageEdge,
  LineageNode,
  LineageOrigin,
  LineageState,
  ReviewIssue,
  SnapshotDependency,
  StaleReason,
  WorkspaceState,
  Zone,
} from './models';

export const EMPTY_LINEAGE: LineageState = { nodes: [], edges: [], batches: [] };

export const placementNodeId = (artifactId: string): string => `placement:${artifactId}`;
export const artifactNodeId = (artifactId: string): string => `artifact:${artifactId}`;
export const issueNodeId = (issueId: string): string => `issue:${issueId}`;
export const batchNodeId = (batchId: string): string => `batch:${batchId}`;
export const snapshotNodeId = (snapshotId: string): string => `snapshot:${snapshotId}`;

export function edgeId(upstream: string, downstream: string, reason: string): string {
  return `${upstream}->${downstream}:${reason}`;
}

/** Deterministic fingerprint of the planning-relevant content of an artifact. */
export function artifactSignature(artifact: Artifact): string {
  const payload = {
    accessionId: artifact.accessionId,
    title: artifact.title,
    maker: artifact.maker,
    yearLabel: artifact.yearLabel,
    medium: artifact.medium,
    origin: artifact.origin,
    summary: artifact.summary,
    dimensions: artifact.dimensions,
    dwellMinutes: artifact.dwellMinutes,
    narrativeRole: artifact.narrativeRole,
    sensitivity: artifact.sensitivity,
    accessibilityNeed: artifact.accessibilityNeed,
    isKeyObject: artifact.isKeyObject,
    tags: artifact.tags,
  };
  return stableHash(JSON.stringify(payload));
}

/** Small stable non-crypto hash (FNV-1a 32-bit) so fingerprints survive reloads. */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hashImportFile(fileName: string, contents: string): string {
  return stableHash(`${fileName} ${contents}`);
}

// ---------------------------------------------------------------------------
// Lookups & graph traversal
// ---------------------------------------------------------------------------

export function findNode(lineage: LineageState, id: string): LineageNode | undefined {
  return lineage.nodes.find((node) => node.id === id);
}

export function nodeMap(lineage: LineageState): Map<string, LineageNode> {
  return new Map(lineage.nodes.map((node) => [node.id, node]));
}

function downstreamAdjacency(edges: LineageEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.upstream) ?? [];
    list.push(edge.downstream);
    adjacency.set(edge.upstream, list);
  }
  return adjacency;
}

function upstreamAdjacency(edges: LineageEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.downstream) ?? [];
    list.push(edge.upstream);
    adjacency.set(edge.downstream, list);
  }
  return adjacency;
}

/** Transitive closure of everything that depends on `rootIds` (roots excluded). */
export function downstreamClosure(lineage: LineageState, rootIds: string[]): Set<string> {
  const adjacency = downstreamAdjacency(lineage.edges);
  const visited = new Set<string>();
  const queue = [...rootIds];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

/** Transitive closure of everything a node depends on, including the node itself. */
export function upstreamClosure(lineage: LineageState, rootId: string): Set<string> {
  const adjacency = upstreamAdjacency(lineage.edges);
  const visited = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

export function directUpstreams(lineage: LineageState, nodeId: string): LineageEdge[] {
  return lineage.edges.filter((edge) => edge.downstream === nodeId);
}

export function directDownstreams(lineage: LineageState, nodeId: string): LineageEdge[] {
  return lineage.edges.filter((edge) => edge.upstream === nodeId);
}

// ---------------------------------------------------------------------------
// Immutable graph mutation helpers
// ---------------------------------------------------------------------------

function withNode(lineage: LineageState, node: LineageNode): LineageState {
  const exists = lineage.nodes.some((candidate) => candidate.id === node.id);
  const nodes = exists
    ? lineage.nodes.map((candidate) => (candidate.id === node.id ? node : candidate))
    : [...lineage.nodes, node];
  return { ...lineage, nodes };
}

function withEdge(lineage: LineageState, edge: LineageEdge): LineageState {
  if (lineage.edges.some((candidate) => candidate.id === edge.id)) return lineage;
  return { ...lineage, edges: [...lineage.edges, edge] };
}

// ---------------------------------------------------------------------------
// Construction / reconciliation (migration, seed, backup restore)
// ---------------------------------------------------------------------------

/**
 * Rebuild structural provenance from the workspace contents without duplicating
 * any relationship. Safe to run against existing workspaces, migrations, and
 * restored backups: every node and edge uses a deterministic id, so a second
 * pass over the same data changes nothing.
 */
export function reconcileLineage(
  lineage: LineageState,
  artifacts: Artifact[],
  zones: Zone[],
  issues: ReviewIssue[],
  origin: LineageOrigin,
): LineageState {
  let next: LineageState = { nodes: lineage.nodes, edges: lineage.edges, batches: lineage.batches };
  const zoneByArtifact = new Map<string, Zone>();
  for (const zone of zones) {
    for (const artifactId of zone.artifactIds) zoneByArtifact.set(artifactId, zone);
  }
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));

  for (const artifact of artifacts) {
    const id = artifactNodeId(artifact.id);
    const signature = artifactSignature(artifact);
    const existing = findNode(next, id);
    if (!existing) {
      next = withNode(next, {
        id,
        type: 'artifact',
        label: artifact.title,
        origin,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        signature,
        tombstoned: false,
      });
    } else {
      const revived = existing.tombstoned
        ? { ...existing, tombstoned: false, tombstonedAt: undefined }
        : existing;
      next = existing.signature && !existing.tombstoned
        ? next
        : withNode(next, { ...revived, signature, label: artifact.title });
    }
  }

  for (const artifact of artifacts) {
    const zone = zoneByArtifact.get(artifact.id);
    if (!zone) continue;
    next = withPlacementNode(next, artifact, zone, origin);
    next = withEdge(next, {
      id: edgeId(artifactNodeId(artifact.id), placementNodeId(artifact.id), 'assigned'),
      upstream: artifactNodeId(artifact.id),
      downstream: placementNodeId(artifact.id),
      reason: 'assigned',
      createdAt: artifact.updatedAt,
    });
  }

  for (const issue of issues) {
    const id = issueNodeId(issue.id);
    const existing = findNode(next, id);
    if (!existing) {
      next = withNode(next, {
        id,
        type: 'issue',
        label: issue.title,
        origin,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        tombstoned: false,
      });
    } else if (existing.tombstoned) {
      // Issue reappeared (e.g. a backup restored it): revive without inventing provenance.
      next = withNode(next, { ...existing, label: issue.title, tombstoned: false, tombstonedAt: undefined });
    }
    if (issue.artifactId) {
      next = withEdge(next, {
        id: edgeId(artifactNodeId(issue.artifactId), id, 'linked'),
        upstream: artifactNodeId(issue.artifactId),
        downstream: id,
        reason: 'linked',
        createdAt: issue.createdAt,
      });
      const placementId = placementNodeId(issue.artifactId);
      if (issue.zoneId && findNode(next, placementId)) {
        next = withEdge(next, {
          id: edgeId(placementId, id, 'linked'),
          upstream: placementId,
          downstream: id,
          reason: 'linked',
          createdAt: issue.createdAt,
        });
      }
    } else if (issue.zoneId) {
      // Zone-wide findings are provenanced through the zone's current placements.
      for (const placedId of zoneById.get(issue.zoneId)?.artifactIds ?? []) {
        const placementId = placementNodeId(placedId);
        if (findNode(next, placementId)) {
          next = withEdge(next, {
            id: edgeId(placementId, id, 'linked'),
            upstream: placementId,
            downstream: id,
            reason: 'linked',
            createdAt: issue.createdAt,
          });
        }
      }
    }
  }

  // Drop dangling edges (both endpoints must exist).
  const ids = new Set(next.nodes.map((node) => node.id));
  next = { ...next, edges: next.edges.filter((edge) => ids.has(edge.upstream) && ids.has(edge.downstream)) };
  return next;
}

function withPlacementNode(
  lineage: LineageState,
  artifact: Artifact,
  zone: Zone,
  origin: LineageOrigin,
): LineageState {
  const nodeId = placementNodeId(artifact.id);
  const timestamp = artifact.updatedAt;
  const existing = findNode(lineage, nodeId);
  if (!existing) {
    return withNode(lineage, {
      id: nodeId,
      type: 'placement',
      label: `Placement in ${zone.name}`,
      contextLabel: zone.name,
      origin,
      createdAt: timestamp,
      updatedAt: timestamp,
      tombstoned: false,
    });
  }
  if (existing.tombstoned) {
    // Structural data shows the placement exists again: revive it.
    return withNode(lineage, {
      ...existing,
      label: `Placement in ${zone.name}`,
      contextLabel: zone.name,
      tombstoned: false,
      tombstonedAt: undefined,
      staleReason: undefined,
      staleSince: undefined,
      updatedAt: timestamp,
    });
  }
  // Live placement: refresh labels but PRESERVE staleness (a restore must not
  // wipe a legitimate "source changed — re-review" flag).
  return withNode(lineage, {
    ...existing,
    label: `Placement in ${zone.name}`,
    contextLabel: zone.name,
    updatedAt: timestamp,
  });
}

// ---------------------------------------------------------------------------
// Live mutations
// ---------------------------------------------------------------------------

export function noteArtifactUpserted(
  lineage: LineageState,
  artifact: Artifact,
  origin: LineageOrigin,
  batch?: ImportBatch,
  at = new Date(),
): { lineage: LineageState; signatureChanged: boolean } {
  const id = artifactNodeId(artifact.id);
  const timestamp = at.toISOString();
  const signature = artifactSignature(artifact);
  const existing = findNode(lineage, id);
  const signatureChanged = Boolean(
    existing && !existing.tombstoned && existing.signature !== undefined && existing.signature !== signature,
  );

  let next = withNode(lineage, {
    id,
    type: 'artifact',
    label: artifact.title,
    origin: existing?.origin ?? origin,
    batchId: !existing && batch ? batch.id : existing?.batchId,
    batchFileName: !existing && batch ? batch.fileName : existing?.batchFileName,
    createdAt: existing?.createdAt ?? artifact.createdAt,
    updatedAt: timestamp,
    signature,
    tombstoned: false,
    tombstonedAt: undefined,
  });

  // The "generated by import batch" relationship is only created once, when the
  // record is first created by that batch. A later merge keeps its origin.
  if (batch && !existing) {
    const batchNode: LineageNode = {
      id: batchNodeId(batch.id),
      type: 'batch',
      label: `Import ${batch.fileName}`,
      origin: 'import',
      batchFileName: batch.fileName,
      createdAt: batch.importedAt,
      updatedAt: batch.importedAt,
      tombstoned: false,
    };
    next = withNode(next, batchNode);
    next = withEdge(next, {
      id: edgeId(batchNode.id, id, 'generated'),
      upstream: batchNode.id,
      downstream: id,
      reason: 'generated',
      createdAt: batch.importedAt,
    });
  }

  if (signatureChanged) {
    next = markDownstreamStale(next, [id], 'source-modified', at);
  }
  return { lineage: next, signatureChanged };
}

/** Re-baseline an artifact signature after a reviewer confirms the downstream impact. */
export function rebaselineArtifact(lineage: LineageState, artifact: Artifact): LineageState {
  const id = artifactNodeId(artifact.id);
  const node = findNode(lineage, id);
  if (!node) return lineage;
  return withNode(lineage, { ...node, signature: artifactSignature(artifact) });
}

/** Tombstone the artifact and mark every transitive downstream record for re-review. */
export function noteArtifactRemoved(lineage: LineageState, artifactId: string, at = new Date()): LineageState {
  const id = artifactNodeId(artifactId);
  const node = findNode(lineage, id);
  if (!node) return lineage;
  let next = withNode(lineage, {
    ...node,
    tombstoned: true,
    tombstonedAt: at.toISOString(),
    staleReason: 'source-deleted',
    staleSince: at.toISOString(),
  });
  next = markDownstreamStale(next, [id], 'source-deleted', at);
  return next;
}

export function notePlacementAssigned(
  lineage: LineageState,
  artifact: Artifact,
  zone: Zone,
  at = new Date(),
): LineageState {
  const timestamp = at.toISOString();
  const nodeId = placementNodeId(artifact.id);
  const artifactId = artifactNodeId(artifact.id);
  const existing = findNode(lineage, nodeId);
  let next = lineage;

  if (existing && !existing.tombstoned && existing.contextLabel && existing.contextLabel !== zone.name) {
    // Moving between zones retires the previous placement record, but it stays
    // in the graph so its origin and export history remain traceable.
    next = withNode(next, {
      ...existing,
      tombstoned: true,
      tombstonedAt: timestamp,
      staleReason: 'source-removed',
      staleSince: timestamp,
    });
  }

  const retired = findNode(next, nodeId);
  next = withNode(next, {
    id: nodeId,
    type: 'placement',
    label: `Placement in ${zone.name}`,
    contextLabel: zone.name,
    origin: retired && !retired.tombstoned ? retired.origin : 'direct',
    createdAt: retired && !retired.tombstoned ? retired.createdAt : timestamp,
    updatedAt: timestamp,
    tombstoned: false,
    tombstonedAt: undefined,
    staleReason: undefined,
    staleSince: undefined,
  });

  next = withEdge(next, {
    id: edgeId(artifactId, nodeId, 'assigned'),
    upstream: artifactId,
    downstream: nodeId,
    reason: 'assigned',
    createdAt: timestamp,
  });
  return next;
}

export function notePlacementRemoved(lineage: LineageState, artifactId: string, at = new Date()): LineageState {
  const nodeId = placementNodeId(artifactId);
  const node = findNode(lineage, nodeId);
  if (!node) return lineage;
  const timestamp = at.toISOString();
  // Retire the placement's own export relationships: a removed placement no
  // longer feeds published packages (the artifact node keeps its edges, so
  // package impact is still traced through the object).
  const edges = lineage.edges.filter(
    (edge) => !(edge.upstream === nodeId && edge.reason === 'exported'),
  );
  let next = withNode({ ...lineage, edges }, {
    ...node,
    tombstoned: true,
    tombstonedAt: timestamp,
    staleReason: 'source-removed',
    staleSince: timestamp,
  });
  next = markDownstreamStale(next, [nodeId], 'source-removed', at);
  return next;
}

export function noteIssueAdded(lineage: LineageState, issue: ReviewIssue, at = new Date()): LineageState {
  const id = issueNodeId(issue.id);
  const timestamp = at.toISOString();
  let next = withNode(lineage, {
    id,
    type: 'issue',
    label: issue.title,
    origin: 'direct',
    createdAt: timestamp,
    updatedAt: timestamp,
    tombstoned: false,
  });
  if (issue.artifactId) {
    next = withEdge(next, {
      id: edgeId(artifactNodeId(issue.artifactId), id, 'linked'),
      upstream: artifactNodeId(issue.artifactId),
      downstream: id,
      reason: 'linked',
      createdAt: timestamp,
    });
  }
  return next;
}

/** Link a finding to the placement in its zone; structural links are resolved live. */
export function noteIssueZoneLinked(lineage: LineageState, issue: ReviewIssue, zone?: Zone): LineageState {
  if (!issue.zoneId || !zone) return lineage;
  const id = issueNodeId(issue.id);
  let next = lineage;
  for (const placedId of zone.artifactIds) {
    const placementId = placementNodeId(placedId);
    if (findNode(next, placementId)) {
      next = withEdge(next, {
        id: edgeId(placementId, id, 'linked'),
        upstream: placementId,
        downstream: id,
        reason: 'linked',
        createdAt: issue.createdAt,
      });
    }
  }
  return next;
}

export function noteIssueTransitioned(lineage: LineageState, issue: ReviewIssue, at = new Date()): LineageState {
  const id = issueNodeId(issue.id);
  const node = findNode(lineage, id);
  if (!node || node.tombstoned) return lineage;
  return withNode(lineage, { ...node, label: issue.title, updatedAt: at.toISOString() });
}

export function noteIssueRemoved(lineage: LineageState, issueId: string, at = new Date()): LineageState {
  const id = issueNodeId(issueId);
  const node = findNode(lineage, id);
  if (!node) return lineage;
  return withNode(lineage, {
    ...node,
    tombstoned: true,
    tombstonedAt: at.toISOString(),
    staleReason: 'source-deleted',
    staleSince: at.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Staleness propagation
// ---------------------------------------------------------------------------

const STALE_RANK: Record<StaleReason, number> = {
  'source-deleted': 3,
  'source-removed': 2,
  'source-modified': 1,
  'upstream-stale': 0,
};

function strongerReason(current: StaleReason | undefined, candidate: StaleReason): StaleReason {
  if (!current || STALE_RANK[candidate] > STALE_RANK[current]) return candidate;
  return current;
}

/**
 * Walk the dependency graph downstream from the roots. Placements whose
 * source object was deleted are tombstoned (their history is retained).
 * Findings and published packages are never hidden — they are flagged for
 * re-review instead of continuing to display as fully valid.
 */
export function markDownstreamStale(
  lineage: LineageState,
  rootIds: string[],
  reason: StaleReason,
  at = new Date(),
): LineageState {
  const closure = downstreamClosure(lineage, rootIds);
  if (closure.size === 0) return lineage;
  const timestamp = at.toISOString();
  const nodes = lineage.nodes.map((node) => {
    if (!closure.has(node.id)) return node;
    const alreadyGone = node.staleReason === 'source-deleted' || node.staleReason === 'source-removed';
    const effectiveReason = alreadyGone
      ? node.staleReason as StaleReason
      : strongerReason(node.staleReason, reason);
    // Only orphaned placements disappear structurally; the finding record itself
    // stays on the review desk so a human can re-link or close it.
    const shouldTombstone = reason === 'source-deleted' && node.type === 'placement' && !node.tombstoned;
    return {
      ...node,
      staleReason: effectiveReason,
      staleSince: node.staleSince ?? timestamp,
      tombstoned: node.tombstoned || shouldTombstone,
      tombstonedAt: node.tombstonedAt ?? (shouldTombstone ? timestamp : undefined),
    };
  });
  return { ...lineage, nodes };
}

/** A reviewer has re-confirmed a record; the stale flag clears on that record. */
export function acknowledgeStaleness(lineage: LineageState, nodeId: string, at = new Date()): LineageState {
  const node = findNode(lineage, nodeId);
  if (!node) return lineage;
  return withNode(lineage, {
    ...node,
    staleReason: undefined,
    staleSince: undefined,
    updatedAt: at.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Published packages (snapshots)
// ---------------------------------------------------------------------------

export function recordSnapshot(
  lineage: LineageState,
  snapshotId: string,
  label: string,
  state: WorkspaceState,
  at = new Date(),
): LineageState {
  const timestamp = at.toISOString();
  const id = snapshotNodeId(snapshotId);
  let next = withNode(lineage, {
    id,
    type: 'snapshot',
    label,
    origin: 'direct',
    createdAt: timestamp,
    updatedAt: timestamp,
    tombstoned: false,
  });

  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const zone of state.zones) {
    for (const artifactId of zone.artifactIds) {
      const artifact = artifactById.get(artifactId);
      if (!artifact) continue;
      const artifactNode = artifactNodeId(artifactId);
      next = withEdge(next, {
        id: edgeId(artifactNode, id, 'exported'),
        upstream: artifactNode,
        downstream: id,
        reason: 'exported',
        createdAt: timestamp,
      });
      const placement = placementNodeId(artifactId);
      if (findNode(next, placement)) {
        next = withEdge(next, {
          id: edgeId(placement, id, 'exported'),
          upstream: placement,
          downstream: id,
          reason: 'exported',
          createdAt: timestamp,
        });
      }
    }
  }
  for (const issue of state.issues) {
    if (issue.status === 'resolved') continue;
    const upstream = issueNodeId(issue.id);
    if (findNode(next, upstream)) {
      next = withEdge(next, {
        id: edgeId(upstream, id, 'exported'),
        upstream,
        downstream: id,
        reason: 'exported',
        createdAt: timestamp,
      });
    }
  }
  return next;
}

export interface SnapshotDependencyCheck {
  snapshotNodeId: string;
  dependencies: SnapshotDependency[];
  needsReview: SnapshotDependency[];
  deletedSources: SnapshotDependency[];
  blockers: string[];
  cautions: string[];
}

export function checkSnapshotDependencies(state: WorkspaceState, nodeId: string): SnapshotDependencyCheck {
  return evaluateDependencyCheck(state.lineage, nodeId);
}

/**
 * Dependency closure for a package about to be published. Equivalent to
 * checkSnapshotDependencies run on the lineage produced by recordSnapshot,
 * without requiring the snapshot node to be persisted first.
 */
export function previewSnapshotDependencies(state: WorkspaceState, nodeId: string): SnapshotDependencyCheck {
  const projected = recordSnapshot(state.lineage, nodeId.replace(/^snapshot:/, ''), 'Prospective package', state);
  return evaluateDependencyCheck(projected, nodeId);
}

function evaluateDependencyCheck(lineage: LineageState, nodeId: string): SnapshotDependencyCheck {
  const closure = upstreamClosure(lineage, nodeId);
  const lookup = nodeMap(lineage);
  const upstreams = upstreamAdjacency(lineage.edges);

  const dependencies: SnapshotDependency[] = [];
  for (const id of closure) {
    if (id === nodeId) continue;
    const node = lookup.get(id);
    if (!node || node.type === 'batch') continue;
    const needsReview = Boolean(node.staleReason) || node.tombstoned;
    dependencies.push({
      nodeId: id,
      type: node.type,
      label: node.label,
      origin: node.origin,
      status: needsReview ? 'needs-review' : 'valid',
      staleReason: node.staleReason,
      batchFileName: node.batchFileName,
      dependsOn: (upstreams.get(id) ?? []).filter((upstream) => lookup.get(upstream)?.type !== 'batch'),
    });
  }

  const needsReview = dependencies.filter((dependency) => dependency.status === 'needs-review');
  const deletedSources = needsReview.filter(
    (dependency) => dependency.staleReason === 'source-deleted' || dependency.staleReason === 'source-removed',
  );

  const blockers = deletedSources.length
    ? [`${deletedSources.length} exported ${deletedSources.length === 1 ? 'record references a source' : 'records reference sources'} that no longer exist. Re-export after resolving them.`]
    : [];
  const cautions = needsReview.length
    ? [`${needsReview.length} exported ${needsReview.length === 1 ? 'record has' : 'records have'} changed since this package was published and need re-review.`]
    : [];

  return { snapshotNodeId: nodeId, dependencies, needsReview, deletedSources, blockers, cautions };
}

// ---------------------------------------------------------------------------
// Delete-impact view used by confirmation dialogs
// ---------------------------------------------------------------------------

export interface DeleteImpact {
  placements: LineageNode[];
  findings: LineageNode[];
  snapshots: LineageNode[];
  total: number;
}

export function artifactDeleteImpact(lineage: LineageState, artifactId: string): DeleteImpact {
  const closure = downstreamClosure(lineage, [artifactNodeId(artifactId)]);
  const impacted = lineage.nodes.filter(
    (node) => closure.has(node.id) && (node.type === 'placement' || node.type === 'issue' || node.type === 'snapshot'),
  );
  const placements = impacted.filter((node) => node.type === 'placement' && !node.tombstoned);
  const findings = impacted.filter((node) => node.type === 'issue' && !node.tombstoned);
  const snapshots = impacted.filter((node) => node.type === 'snapshot');
  return { placements, findings, snapshots, total: placements.length + findings.length + snapshots.length };
}
