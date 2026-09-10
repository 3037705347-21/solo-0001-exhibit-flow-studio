import { downloadTextFile } from '../../../domain/export';
import type { Zone } from '../../../domain/models';
import { serializeZoneChecklistCsv, zoneChecklistFileName, type ZoneChecklist } from '../../../domain/zoneChecklist';

export const CHECKLIST_CSV_MIME_TYPE = 'text/csv;charset=utf-8';

export interface ChecklistCsvDownload {
  fileName: string;
  contents: string;
  mimeType: typeof CHECKLIST_CSV_MIME_TYPE;
}

/** Pure assembly of the CSV download for one zone's checklist. */
export function buildChecklistCsvDownload(
  checklist: ZoneChecklist,
  zone: Zone,
  date = new Date(),
): ChecklistCsvDownload {
  return {
    fileName: zoneChecklistFileName(zone, date),
    contents: serializeZoneChecklistCsv(checklist),
    mimeType: CHECKLIST_CSV_MIME_TYPE,
  };
}

/** Triggers the single-zone checklist CSV download in the floor-team format. */
export function downloadZoneChecklist(checklist: ZoneChecklist, zone: Zone, date = new Date()): void {
  const { fileName, contents, mimeType } = buildChecklistCsvDownload(checklist, zone, date);
  downloadTextFile(contents, fileName, mimeType);
}
