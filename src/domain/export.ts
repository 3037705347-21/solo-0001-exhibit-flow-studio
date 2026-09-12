import { isRuleProfile } from './ruleProfiles';
import type { Snapshot } from './models';

export function snapshotFileName(date = new Date()): string {
  return `exhibit-flow-snapshot-${date.toISOString().slice(0, 10)}.json`;
}

export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export type SnapshotParseStatus = 'valid' | 'legacy-v1' | 'invalid';

export interface SnapshotParseResult {
  status: SnapshotParseStatus;
  snapshot: Snapshot | null;
  /** Structural reason for rejection, surfaced by the UI instead of silent fallback. */
  reason: string;
}

/**
 * Parse a published package. Current packages are schemaVersion 2 and must
 * embed the exact rule archive version the readiness result used — a package
 * without it is rejected, never reinterpreted against today's defaults.
 * Legacy v1 packages (predating archives) are labelled explicitly so the UI
 * can show them as historical artifacts without treating them as current.
 */
export function parseSnapshotResult(raw: string): SnapshotParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'invalid', snapshot: null, reason: 'The file is not valid JSON.' };
  }
  if (!value || typeof value !== 'object') {
    return { status: 'invalid', snapshot: null, reason: 'The file does not contain a snapshot package.' };
  }
  const candidate = value as { schemaVersion?: number } & Partial<Snapshot>;
  const schemaVersion = (candidate as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === 1) {
    return {
      status: 'legacy-v1',
      snapshot: null,
      reason: 'This package predates versioned rule archives (schema v1); it can only be shown as a historical record.',
    };
  }
  if (candidate.schemaVersion !== 2) {
    return { status: 'invalid', snapshot: null, reason: `Unknown snapshot schema version: ${String(schemaVersion)}.` };
  }
  if (!candidate.project || !candidate.summary || !Array.isArray(candidate.zones)) {
    return { status: 'invalid', snapshot: null, reason: 'The package is missing project, summary, or zone data.' };
  }
  if (!candidate.ruleArchive || typeof candidate.ruleArchive.profileId !== 'string' || typeof candidate.ruleArchive.version !== 'number') {
    return { status: 'invalid', snapshot: null, reason: 'The package does not record which rule archive version it was calculated against.' };
  }
  if (!candidate.ruleProfile || !isRuleProfile(candidate.ruleProfile)) {
    return { status: 'invalid', snapshot: null, reason: 'The package does not embed a readable rule archive; refusing to apply unknown rules.' };
  }
  if (candidate.ruleProfile.profileId !== candidate.ruleArchive.profileId || candidate.ruleProfile.version !== candidate.ruleArchive.version) {
    return {
      status: 'invalid',
      snapshot: null,
      reason: `Rule archive reference ${candidate.ruleArchive.profileId}#${candidate.ruleArchive.version} does not match the embedded profile ${candidate.ruleProfile.profileId}#${candidate.ruleProfile.version}.`,
    };
  }
  return { status: 'valid', snapshot: value as Snapshot, reason: '' };
}

export function parseSnapshot(raw: string): Snapshot | null {
  return parseSnapshotResult(raw).snapshot;
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
