import { titleCase } from './formatters';
import type { Artifact, Snapshot } from './models';

export function snapshotFileName(date = new Date()): string {
  return `exhibit-flow-snapshot-${date.toISOString().slice(0, 10)}.json`;
}

export function collectionListFileName(date = new Date()): string {
  return `exhibit-flow-collection-${date.toISOString().slice(0, 10)}.csv`;
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

export function downloadTextFile(contents: string, fileName: string, mimeType = 'application/json'): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serializes the collection view exactly as presented: callers pass the sorted
 * (and optionally filtered) list and the CSV keeps that order row for row, so
 * exports and printouts match what the team reviewed on screen.
 */
export function serializeCollectionCsv(artifacts: Artifact[]): string {
  const lines: string[] = [
    ['Order', 'Accession ID', 'Title', 'Maker', 'Narrative role', 'Sensitivity', 'Dwell (min)', 'Last updated'].map(csvCell).join(','),
  ];
  artifacts.forEach((artifact, index) => {
    lines.push([
      index + 1,
      artifact.accessionId,
      artifact.title,
      artifact.maker,
      titleCase(artifact.narrativeRole),
      titleCase(artifact.sensitivity),
      artifact.dwellMinutes,
      artifact.updatedAt.slice(0, 10),
    ].map(csvCell).join(','));
  });
  return lines.join('\r\n');
}
