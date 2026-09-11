import {
  artifactNodeId,
  directDownstreams,
  directUpstreams,
  findNode,
  issueNodeId,
  placementNodeId,
  upstreamClosure,
} from './lineage';
import type { LineageNode, LineageState, SnapshotDependency, StaleReason, WorkspaceState } from './models';

export type LineageHealth = 'valid' | 'needs-review' | 'deleted';

export interface LineageViewItem {
  node: LineageNode;
  health: LineageHealth;
  detail: string;
}

export interface RecordLineage {
  node?: LineageNode;
  health: LineageHealth;
  /** Immediate origins, skipping import-batch nodes (those are listed separately). */
  sources: LineageViewItem[];
  /** Transitive origins (full provenance closure). */
  sourceClosure: LineageViewItem[];
  /** Records that directly depend on this one. */
  dependents: LineageViewItem[];
  importBatch?: LineageNode;
  staleReason?: StaleReason;
}

function healthOf(node: LineageNode | undefined): LineageHealth {
  if (!node) return 'valid';
  if (node.tombstoned || node.staleReason === 'source-deleted' || node.staleReason === 'source-removed') return 'deleted';
  if (node.staleReason) return 'needs-review';
  return 'valid';
}

function detailFor(node: LineageNode): string {
  switch (node.type) {
    case 'artifact': return node.origin === 'import' ? `Imported${node.batchFileName ? ` from ${node.batchFileName}` : ''}` : node.origin === 'seed' ? 'Sample plan' : 'Directly created';
    case 'placement': return node.contextLabel ? `Placement in ${node.contextLabel}` : 'Placement';
    case 'issue': return 'Review finding';
    case 'snapshot': return 'Published package';
    case 'batch': return node.batchFileName ? `Import file ${node.batchFileName}` : 'Import batch';
  }
}

function toItem(lineage: LineageState, id: string): LineageViewItem | null {
  const node = findNode(lineage, id);
  if (!node) return null;
  return { node, health: healthOf(node), detail: detailFor(node) };
}

function buildView(state: WorkspaceState, nodeId: string): RecordLineage {
  const lineage = state.lineage;
  const node = findNode(lineage, nodeId);
  const sources = directUpstreams(lineage, nodeId)
    .map((edge) => toItem(lineage, edge.upstream))
    .filter((item): item is LineageViewItem => Boolean(item))
    .filter((item) => item.node.type !== 'batch');

  const closureIds = upstreamClosure(lineage, nodeId);
  const sourceClosure = [...closureIds]
    .filter((id) => id !== nodeId)
    .map((id) => toItem(lineage, id))
    .filter((item): item is LineageViewItem => Boolean(item))
    .filter((item) => item.node.type !== 'batch');

  const dependents = directDownstreams(lineage, nodeId)
    .map((edge) => toItem(lineage, edge.downstream))
    .filter((item): item is LineageViewItem => Boolean(item))
    .filter((item) => item.node.type !== 'batch');

  const batchEdge = directUpstreams(lineage, nodeId).find((edge) => edge.upstream.startsWith('batch:'));
  const importBatch = batchEdge ? findNode(lineage, batchEdge.upstream) : undefined;

  return {
    node,
    health: healthOf(node),
    sources,
    sourceClosure,
    dependents,
    importBatch,
    staleReason: node?.staleReason,
  };
}

export function artifactLineage(state: WorkspaceState, artifactId: string): RecordLineage {
  return buildView(state, artifactNodeId(artifactId));
}

export function placementLineage(state: WorkspaceState, artifactId: string): RecordLineage {
  return buildView(state, placementNodeId(artifactId));
}

export function issueLineage(state: WorkspaceState, issueId: string): RecordLineage {
  return buildView(state, issueNodeId(issueId));
}

export function staleReasonLabel(reason: StaleReason | undefined): string {
  switch (reason) {
    case 'source-modified': return 'Upstream record changed — re-review needed';
    case 'source-deleted': return 'Source record was deleted';
    case 'source-removed': return 'Source was removed from the plan';
    case 'upstream-stale': return 'An upstream record needs re-review';
    default: return '';
  }
}

export type { SnapshotDependency };
