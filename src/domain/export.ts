import { WORKSPACE_SCHEMA_VERSION, type Snapshot, type WorkspaceFile, type WorkspaceState } from './models';
import { validateWorkspaceState } from './workspaceValidation';

export function snapshotFileName(date = new Date()): string {
  return `exhibit-flow-snapshot-${date.toISOString().slice(0, 10)}.json`;
}

export function workspaceFileName(date = new Date()): string {
  return `exhibit-flow-workspace-v${WORKSPACE_SCHEMA_VERSION}-${date.toISOString().slice(0, 10)}.json`;
}

export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function parseSnapshot(raw: string): Snapshot | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<Snapshot>;
    if (candidate.schemaVersion !== 1 || !candidate.project || !candidate.summary || !Array.isArray(candidate.zones)) return null;
    return value as Snapshot;
  } catch {
    return null;
  }
}

/**
 * Wraps a validated workspace in the transfer envelope. Export is refused if
 * the workspace fails the shared structural path, so every exported file can
 * be re-imported.
 */
export function serializeWorkspace(state: WorkspaceState, at = new Date().toISOString()): string | null {
  const report = validateWorkspaceState(state);
  if (report.fatal.length > 0) return null;
  const file: WorkspaceFile = {
    kind: 'exhibit-flow-workspace',
    fileVersion: 1,
    exportedAt: at,
    workspace: { ...state, version: WORKSPACE_SCHEMA_VERSION },
  };
  return JSON.stringify(file, null, 2);
}

export type WorkspaceParseResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/**
 * Parses an import candidate. Both the current envelope and bare workspace
 * objects (older exports / storage dumps) are accepted; readiness snapshots and
 * invalid JSON are refused.
 */
export function parseWorkspaceFile(raw: string): WorkspaceParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'The file is not valid JSON.' };
  }
  if (!value || typeof value !== 'object') {
    return { ok: false, message: 'The file does not contain a workspace object.' };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'exhibit-flow-workspace') {
    if (candidate.fileVersion !== 1) return { ok: false, message: 'This workspace file version is not supported.' };
    if (!candidate.workspace || typeof candidate.workspace !== 'object') {
      return { ok: false, message: 'The workspace file is missing its workspace payload.' };
    }
    return { ok: true, value };
  }
  if ('schemaVersion' in candidate && !('version' in candidate)) {
    return { ok: false, message: 'This is a read-only readiness snapshot, not a restorable workspace.' };
  }
  if (!('artifacts' in candidate) || !('zones' in candidate)) {
    return { ok: false, message: 'The file does not look like an ExhibitFlow workspace.' };
  }
  return { ok: true, value };
}

export function downloadTextFile(contents: string, fileName: string, mimeType = 'application/json'): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
