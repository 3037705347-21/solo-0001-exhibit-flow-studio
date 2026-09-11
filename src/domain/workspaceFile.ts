import type { WorkspaceState, WorkspaceVersion } from './models';
import { CURRENT_WORKSPACE_VERSION } from './models';

/**
 * A workspace file is a versioned envelope around the full editable state.
 * Unlike a readiness snapshot, it can be re-imported and restored.
 */
export interface WorkspaceFile {
  kind: typeof WORKSPACE_FILE_KIND;
  fileVersion: WorkspaceVersion;
  exportedAt: string;
  source: 'manual-export';
  workspace: WorkspaceState;
}

export const WORKSPACE_FILE_KIND = 'exhibit-flow.workspace-file';

export function workspaceFileName(date = new Date()): string {
  return `exhibit-flow-workspace-${date.toISOString().slice(0, 10)}.json`;
}

export function serializeWorkspaceFile(state: WorkspaceState, at: Date = new Date()): string {
  const file: WorkspaceFile = {
    kind: WORKSPACE_FILE_KIND,
    fileVersion: CURRENT_WORKSPACE_VERSION,
    exportedAt: at.toISOString(),
    source: 'manual-export',
    workspace: { ...state, restoredFrom: undefined },
  };
  return JSON.stringify(file, null, 2);
}

export type ParseWorkspaceFileResult =
  | { ok: true; value: WorkspaceFile }
  | { ok: false; reason: string };

/** Strict parse used by the export round-trip checks. */
export function parseWorkspaceFile(raw: string): ParseWorkspaceFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'The file is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'The file does not contain a workspace object.' };
  const candidate = parsed as Partial<WorkspaceFile>;
  if (candidate.kind !== WORKSPACE_FILE_KIND) return { ok: false, reason: 'The file is not an ExhibitFlow workspace export.' };
  if (candidate.fileVersion !== CURRENT_WORKSPACE_VERSION) {
    return { ok: false, reason: `Workspace file version ${String(candidate.fileVersion)} is not supported by this build.` };
  }
  if (!candidate.workspace || typeof candidate.workspace !== 'object') {
    return { ok: false, reason: 'The workspace file is missing its "workspace" section.' };
  }
  return { ok: true, value: candidate as WorkspaceFile };
}
