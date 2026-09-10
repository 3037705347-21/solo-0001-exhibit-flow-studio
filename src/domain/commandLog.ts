import { titleCase } from './formatters';
import type { Artifact, PlanningPreferences, ReviewIssue, WorkspaceState, Zone } from './models';
import type { WorkspaceAction } from '../state/actions';

export type HistoryCategory = 'object' | 'journey' | 'finding' | 'preferences' | 'readiness' | 'workspace';

export interface HistoryEntry {
  id: string;
  category: HistoryCategory;
  action: WorkspaceAction['type'];
  summary: string;
  source: string;
  timestamp: string;
  actor: 'local-user' | 'system';
}

export interface HistoryContext {
  artifacts: Artifact[];
  zones: Zone[];
  issues: ReviewIssue[];
  preferences: PlanningPreferences;
}

/** Maximum number of entries kept; older entries roll off as new ones arrive. */
export const HISTORY_LIMIT = 100;

const ACTION_META: Record<WorkspaceAction['type'], { category: HistoryCategory; source: string }> = {
  'artifact/upsert': { category: 'object', source: 'Collection' },
  'artifact/remove': { category: 'object', source: 'Collection' },
  'placement/assign': { category: 'journey', source: 'Visitor journey' },
  'placement/remove': { category: 'journey', source: 'Visitor journey' },
  'placement/reorder': { category: 'journey', source: 'Visitor journey' },
  'issue/add': { category: 'finding', source: 'Review desk' },
  'issue/transition': { category: 'finding', source: 'Review desk' },
  'preferences/update': { category: 'preferences', source: 'Insights' },
  'project/readiness': { category: 'readiness', source: 'Review desk' },
  'workspace/reset': { category: 'workspace', source: 'Workspace' },
};

export function categoryForAction(action: WorkspaceAction['type']): HistoryCategory {
  return ACTION_META[action].category;
}

export function sourceForAction(action: WorkspaceAction['type']): string {
  return ACTION_META[action].source;
}

function namedArtifact(context: HistoryContext, artifactId: string): Artifact | undefined {
  return context.artifacts.find((artifact) => artifact.id === artifactId);
}

function artifactLabel(artifact: Artifact | undefined, fallbackId: string): string {
  if (!artifact) return fallbackId;
  return `“${artifact.title}” (${artifact.accessionId})`;
}

function zoneName(context: HistoryContext, zoneId: string): string {
  return context.zones.find((zone) => zone.id === zoneId)?.name ?? zoneId;
}

function preferencesLabel(preferences: PlanningPreferences): string {
  return `${titleCase(preferences.pace)} pace, group ${preferences.groupSize}, access priority ${preferences.accessibilityPriority}%`;
}

/**
 * Builds a human-readable summary for a command that has already been accepted.
 * The context is the workspace state *before* the command was applied, so prior
 * placements and records are still available for naming.
 */
export function describeAction(action: WorkspaceAction, context: HistoryContext): string {
  switch (action.type) {
    case 'artifact/upsert': {
      const existed = context.artifacts.some((artifact) => artifact.id === action.artifact.id);
      return `${existed ? 'Updated object' : 'Added object'} ${artifactLabel(action.artifact, action.artifact.id)}`;
    }
    case 'artifact/remove': {
      const artifact = namedArtifact(context, action.artifactId);
      return `Removed object ${artifactLabel(artifact, action.artifactId)}`;
    }
    case 'placement/assign': {
      const artifact = namedArtifact(context, action.artifactId);
      const targetName = zoneName(context, action.zoneId);
      const previousZone = context.zones.find((zone) => zone.artifactIds.includes(action.artifactId));
      if (!previousZone) return `Placed ${artifactLabel(artifact, action.artifactId)} in ${targetName}`;
      if (previousZone.id === action.zoneId) return `Repositioned ${artifactLabel(artifact, action.artifactId)} within ${targetName}`;
      return `Moved ${artifactLabel(artifact, action.artifactId)} from ${previousZone.name} to ${targetName}`;
    }
    case 'placement/remove': {
      const artifact = namedArtifact(context, action.artifactId);
      return `Removed ${artifactLabel(artifact, action.artifactId)} from the journey`;
    }
    case 'placement/reorder': {
      const artifact = namedArtifact(context, action.artifactId);
      const direction = action.direction === -1 ? 'earlier' : 'later';
      return `Moved ${artifactLabel(artifact, action.artifactId)} ${direction} in ${zoneName(context, action.zoneId)}`;
    }
    case 'issue/add':
      return `Created ${titleCase(action.issue.severity)} finding “${action.issue.title}”`;
    case 'issue/transition': {
      const issue = context.issues.find((candidate) => candidate.id === action.issueId);
      const name = issue ? `finding “${issue.title}”` : `finding ${action.issueId}`;
      switch (action.status) {
        case 'in-progress': return `Started work on ${name}`;
        case 'resolved': return `Resolved ${name}`;
        case 'open': return `Reopened ${name}`;
        default: return `Moved ${name} to ${titleCase(action.status)}`;
      }
    }
    case 'preferences/update':
      return `Applied visitor preferences: ${preferencesLabel(action.preferences)}`;
    case 'project/readiness':
      return action.ready
        ? 'Ran readiness check — plan marked ready'
        : 'Ran readiness check — blockers remain, plan returned to review';
    case 'workspace/reset':
      return 'Reset workspace to the sample plan';
  }
}

export function createHistoryEntry(
  action: WorkspaceAction,
  context: HistoryContext,
  id: string,
  at: Date = new Date(),
  actor: HistoryEntry['actor'] = 'local-user',
): HistoryEntry {
  return {
    id,
    category: categoryForAction(action.type),
    action: action.type,
    summary: describeAction(action, context),
    source: sourceForAction(action.type),
    timestamp: at.toISOString(),
    actor,
  };
}

/** Appends an entry in chronological order, keeping only the newest `limit` events. */
export function appendHistory(entries: HistoryEntry[], entry: HistoryEntry, limit: number = HISTORY_LIMIT): HistoryEntry[] {
  return [...entries, entry].slice(Math.max(0, entries.length + 1 - limit));
}

const CATEGORIES: readonly HistoryCategory[] = ['object', 'journey', 'finding', 'preferences', 'readiness', 'workspace'];
const ACTION_TYPES = new Set<string>(Object.keys(ACTION_META));

function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HistoryEntry>;
  return typeof candidate.id === 'string'
    && candidate.id.length > 0
    && typeof candidate.summary === 'string'
    && candidate.summary.length > 0
    && typeof candidate.source === 'string'
    && typeof candidate.timestamp === 'string'
    && !Number.isNaN(new Date(candidate.timestamp).getTime())
    && typeof candidate.action === 'string'
    && ACTION_TYPES.has(candidate.action)
    && CATEGORIES.includes(candidate.category as HistoryCategory);
}

/**
 * Salvages history from persisted JSON: malformed entries are dropped, unknown
 * actors fall back to the local user, and the list is capped to the limit.
 */
export function normalizeHistory(value: unknown, limit: number = HISTORY_LIMIT): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const sanitized = value.filter(isEntry).map((entry): HistoryEntry => ({
    ...entry,
    actor: entry.actor === 'system' ? 'system' : 'local-user',
  }));
  return sanitized.slice(Math.max(0, sanitized.length - limit));
}

export function historyContextFromState(state: WorkspaceState): HistoryContext {
  return {
    artifacts: state.artifacts,
    zones: state.zones,
    issues: state.issues,
    preferences: state.preferences,
  };
}
