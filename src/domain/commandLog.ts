import type { WorkspaceAction } from '../state/actions';

export interface CommandLogEntry {
  id: string;
  action: WorkspaceAction['type'];
  summary: string;
  timestamp: string;
  actor: 'local-user' | 'system';
}

export function describeAction(action: WorkspaceAction): string {
  switch (action.type) {
    case 'artifact/upsert': return `Saved object ${action.artifact.accessionId}`;
    case 'artifact/remove': return `Removed object ${action.artifactId}`;
    case 'artifacts/import': return `Imported ${action.payload.creates.length} object${action.payload.creates.length === 1 ? '' : 's'} from ${action.payload.batch.fileName}`;
    case 'placement/assign': return `Placed object in zone ${action.zoneId}`;
    case 'placement/remove': return `Removed object from journey`;
    case 'placement/reorder': return `Changed object sequence`;
    case 'issue/add': return `Created finding ${action.issue.title}`;
    case 'issue/transition': return `Moved finding to ${action.status}`;
    case 'lineage/acknowledge': return `Confirmed record after upstream re-review`;
    case 'snapshot/recorded': return `Published package ${action.label}`;
    case 'preferences/update': return `Updated visitor profile`;
    case 'project/readiness': return action.ready ? 'Marked project ready' : 'Returned project to review';
    case 'workspace/reset': return 'Reset workspace to sample plan';
    case 'workspace/restore': return 'Restored workspace from backup';
    case 'lineage/reconcile': return 'Reconciled provenance relationships';
  }
}

export function makeLogEntry(action: WorkspaceAction, id: string, at = new Date(), actor: CommandLogEntry['actor'] = 'local-user'): CommandLogEntry {
  return { id, action: action.type, summary: describeAction(action), timestamp: at.toISOString(), actor };
}

export function compactLog(entries: CommandLogEntry[], limit = 50): CommandLogEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => { const key = `${entry.action}:${entry.summary}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(-limit);
}
