import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSeedWorkspace } from '../../../state/seed';
import { buildZoneChecklist } from '../../../domain/zoneChecklist';
import { buildChecklistCsvDownload, CHECKLIST_CSV_MIME_TYPE, downloadZoneChecklist } from './checklistExport';

const downloadSpy = vi.fn();
vi.mock('../../../domain/export', () => ({
  downloadTextFile: (...args: unknown[]) => downloadSpy(...args),
}));

afterEach(() => {
  downloadSpy.mockClear();
});

describe('buildChecklistCsvDownload', () => {
  it('assembles the CSV contents, dated slugged file name and CSV mime type', () => {
    const state = createSeedWorkspace();
    const zone = state.zones.find((candidate) => candidate.id === 'zone-common')!;
    const checklist = buildZoneChecklist(state, zone.id, new Date('2026-09-07T12:00:00Z'))!;
    const download = buildChecklistCsvDownload(checklist, zone, new Date('2026-09-07T12:00:00Z'));

    expect(download.fileName).toBe('exhibit-flow-zone-checklist-common-thread-2026-09-07.csv');
    expect(download.mimeType).toBe(CHECKLIST_CSV_MIME_TYPE);
    expect(download.contents).toContain('Order,Accession ID,Object,Dwell (min),Unresolved findings');
    expect(download.contents).toContain('Portable Letterpress');
  });
});

describe('downloadZoneChecklist', () => {
  it('hands the serialized CSV to the file download helper with the CSV mime type', () => {
    const state = createSeedWorkspace();
    const zone = state.zones.find((candidate) => candidate.id === 'zone-arrival')!;
    const checklist = buildZoneChecklist(state, zone.id, new Date('2026-09-07T09:00:00Z'))!;

    downloadZoneChecklist(checklist, zone, new Date('2026-09-07T09:00:00Z'));

    expect(downloadSpy).toHaveBeenCalledTimes(1);
    const [contents, fileName, mimeType] = downloadSpy.mock.calls[0];
    expect(fileName).toBe('exhibit-flow-zone-checklist-arrival-2026-09-07.csv');
    expect(mimeType).toBe('text/csv;charset=utf-8');
    expect(contents).toContain('Arrival / A Light Carried');
  });
});
