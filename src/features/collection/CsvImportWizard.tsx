import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileUp, RefreshCw, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Callout } from '../../components/Callout';
import { Modal } from '../../components/Modal';
import { analyzeCsvImport, buildCsvTemplate, buildImportPlan, type CsvImportAnalysis, type CsvRowStatus } from '../../domain/csvImport';
import { parseCsv } from '../../domain/csv';
import type { CsvTable } from '../../domain/csv';
import { pluralize } from '../../domain/formatters';
import { useWorkspace } from '../../state/WorkspaceContext';

const MAX_FILE_BYTES = 1_000_000;
const MAX_PREVIEW_ROWS = 50;

const STATUS_PRESENTATION: Record<CsvRowStatus, { label: string; tone: 'positive' | 'info' | 'warning' | 'danger' }> = {
  new: { label: 'New', tone: 'positive' },
  update: { label: 'Safe update', tone: 'info' },
  conflict: { label: 'Conflict', tone: 'warning' },
  error: { label: 'Field error', tone: 'danger' },
};

interface RawFile {
  name: string;
  size: number;
}

export function CsvImportWizard({ onClose, onCompleted }: { onClose: () => void; onCompleted: (summary: string) => void }) {
  const { state, importArtifacts } = useWorkspace();
  const [rawFile, setRawFile] = useState<RawFile | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [allowUpdates, setAllowUpdates] = useState(false);
  const [skipConflicts, setSkipConflicts] = useState(false);
  const [committing, setCommitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const analysis: CsvImportAnalysis | null = useMemo(() => {
    if (!table) return null;
    return analyzeCsvImport(table, state.artifacts, allowUpdates);
  }, [table, state.artifacts, allowUpdates]);

  const acceptFile = async (file: File | undefined | null) => {
    if (!file) return;
    setParseError(null);
    if (file.size > MAX_FILE_BYTES) {
      setTable(null);
      setRawFile(null);
      setParseError(`“${file.name}” is ${Math.round(file.size / 1024)} KB; files must be smaller than 1 MB.`);
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      setRawFile({ name: file.name, size: file.size });
      setTable(parsed);
      setAllowUpdates(false);
      setSkipConflicts(false);
    } catch {
      setParseError('The file could not be read. Choose a UTF-8 encoded CSV file.');
    }
  };

  const resetFile = () => {
    setRawFile(null);
    setTable(null);
    setParseError(null);
    setAllowUpdates(false);
    setSkipConflicts(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const downloadTemplate = () => {
    const blob = new Blob([buildCsvTemplate()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'exhibit-flow-collection-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const plan = analysis ? buildImportPlan(analysis, state.artifacts, { skipConflicts: allowUpdates ? false : skipConflicts }) : null;
  const planReady = plan !== null;
  const writeCount = plan?.length ?? 0;
  const skippedCount = !allowUpdates && skipConflicts ? analysis?.counts.conflict ?? 0 : 0;

  const confirmImport = () => {
    if (!analysis || !planReady) return;
    setCommitting(true);
    const result = importArtifacts(analysis, { skipConflicts: !allowUpdates && skipConflicts });
    if (!result.ok || !result.value) {
      setCommitting(false);
      setParseError(result.message ?? 'The import could not be completed. Nothing was written.');
      return;
    }
    const { added, updated, skipped } = result.value;
    const parts = [`${pluralize(added, 'object')} added`];
    if (updated) parts.push(`${pluralize(updated, 'record')} updated`);
    if (skipped) parts.push(`${pluralize(skipped, 'existing record')} skipped`);
    onCompleted(`Import complete: ${parts.join(', ')}. The batch was written in a single transaction.`);
  };

  const hasHeaderProblem = (analysis?.fileErrors.length ?? 0) > 0;

  return (
    <Modal
      className="csv-modal"
      eyebrow="COLLECTION IMPORT"
      title="Import objects from CSV"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{analysis && !hasHeaderProblem ? 'Cancel' : 'Close'}</Button>
          {analysis && !hasHeaderProblem && (
            <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={resetFile}>Choose another file</Button>
          )}
          {analysis && !hasHeaderProblem && (
            <Button
              variant="primary"
              icon={<FileUp size={15} />}
              disabled={!planReady || committing || analysis.counts.total === 0 || writeCount === 0}
              onClick={confirmImport}
            >
              Import {writeCount} {writeCount === 1 ? 'object' : 'objects'}
            </Button>
          )}
        </>
      }
    >
      {!analysis && (
        <div className="csv-step">
          <p className="csv-intro">Upload a spreadsheet export. Headers are parsed first so you can review every row before anything is written to the workspace.</p>
          <label
            className="csv-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); void acceptFile(event.dataTransfer.files?.[0]); }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose a CSV file"
              onChange={(event) => void acceptFile(event.target.files?.[0])}
            />
            <FileSpreadsheet size={26} />
            <strong>Drag a CSV file here, or click to browse</strong>
            <small>UTF-8 encoded, comma separated, up to 1 MB</small>
          </label>
          {parseError && <Callout tone="danger" title="The file could not be loaded">{parseError}</Callout>}
          <div className="csv-template-row">
            <Button variant="ghost" icon={<Download size={15} />} onClick={downloadTemplate}>Download column template</Button>
            <span>Required: Accession ID, Title, Maker, Medium, Summary, Width, Height, Depth, Dwell minutes.</span>
          </div>
        </div>
      )}

      {analysis && (hasHeaderProblem || analysis.rows.length === 0) && (
        <div className="csv-step">
          <Callout tone="danger" title="This file cannot be imported yet">
            Fix the file structure and choose it again. The workspace has not been changed.
          </Callout>
          <ul className="csv-error-list">
            {analysis.fileErrors.map((message) => <li key={message}><XCircle size={14} /> {message}</li>)}
            {analysis.rows.length === 0 && analysis.fileErrors.length === 0 && (
              <li><XCircle size={14} /> No data rows were found below the header.</li>
            )}
          </ul>
          {rawFile && <p className="csv-filename">Selected file: {rawFile.name}</p>}
        </div>
      )}

      {analysis && !hasHeaderProblem && analysis.rows.length > 0 && (
        <div className="csv-review">
          {parseError && <Callout tone="danger" title="Import did not run">{parseError}</Callout>}
          <dl className="csv-counts" role="group" aria-label="Import row summary">
            <div><dt>New</dt><dd data-testid="csv-count-new">{analysis.counts.new}</dd></div>
            <div><dt>Safe updates</dt><dd data-testid="csv-count-update">{analysis.counts.update}</dd></div>
            <div><dt>Conflicts</dt><dd data-testid="csv-count-conflict">{analysis.counts.conflict}</dd></div>
            <div><dt>Field errors</dt><dd data-testid="csv-count-error">{analysis.counts.error}</dd></div>
            <div><dt>Blank rows skipped</dt><dd>{analysis.blankRows}</dd></div>
          </dl>

          {analysis.counts.error > 0 && (
            <Callout tone="danger" title={`${pluralize(analysis.counts.error, 'row')} ${analysis.counts.error === 1 ? 'has' : 'have'} field errors`}>
              Rows marked “Field error” block the entire batch. Fix them in the spreadsheet and re-upload, or cancel — nothing is written until every row is valid.
            </Callout>
          )}

          {analysis.counts.conflict > 0 && !allowUpdates && (
            <>
              <Callout tone="warning" title={`${pluralize(analysis.counts.conflict, 'accession ID')} already ${analysis.counts.conflict === 1 ? 'exists' : 'exist'} in the collection`}>
                Existing records are never overwritten without explicit permission. Allow updates below to overwrite them, or choose to skip them and import only the new rows.
              </Callout>
              <label className="csv-permission csv-permission-skip">
                <input
                  type="checkbox"
                  checked={skipConflicts}
                  onChange={(event) => setSkipConflicts(event.target.checked)}
                />
                <span>
                  <strong>Skip rows that match existing records</strong>
                  <small>Conflicting rows are left out of the batch and the existing objects stay unchanged. Only new, valid rows are written.</small>
                </span>
              </label>
            </>
          )}

          <label className="csv-permission">
            <input
              type="checkbox"
              checked={allowUpdates}
              onChange={(event) => { setAllowUpdates(event.target.checked); if (event.target.checked) setSkipConflicts(false); }}
            />
            <span>
              <strong>Allow updating existing records</strong>
              <small>When on, rows whose accession ID matches an existing object will overwrite that record in one atomic batch. Placements are preserved. When off, matching rows are treated as conflicts and either skipped above or block the import.</small>
            </span>
          </label>

          {analysis.ignoredColumns.length > 0 && (
            <p className="csv-ignored">Ignored columns with no matching field: <strong>{analysis.ignoredColumns.join(', ')}</strong>.</p>
          )}

          <div className="csv-table-wrap">
            <table className="csv-table">
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Accession ID</th>
                  <th scope="col">Title</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rows.slice(0, MAX_PREVIEW_ROWS).map((row) => {
                  const presentation = STATUS_PRESENTATION[row.status];
                  return (
                    <tr key={row.rowNumber} className={`csv-row-${row.status}`}>
                      <td className="csv-row-number">{row.rowNumber}</td>
                      <td className="csv-cell-id">{row.accessionId || '—'}</td>
                      <td className="csv-cell-title">
                        {row.title || <span className="csv-muted">No title</span>}
                        {row.issues.length > 0 && (
                          <ul className="csv-cell-errors">
                            {row.issues.map((issue) => (
                              <li key={`${issue.field}-${issue.message}`}>
                                <AlertTriangle size={12} /> {issue.message}
                              </li>
                            ))}
                          </ul>
                        )}
                        {row.status === 'conflict' && (
                          <small className="csv-conflict-note">Matches an existing collection record</small>
                        )}
                      </td>
                      <td><Badge tone={presentation.tone}>{presentation.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {analysis.rows.length > MAX_PREVIEW_ROWS && (
            <p className="csv-more">Showing the first {MAX_PREVIEW_ROWS} of {analysis.rows.length} rows; all rows are still validated and counted.</p>
          )}

          {planReady && writeCount > 0 && (
            <p className="csv-ready"><CheckCircle2 size={15} /> Ready to write <strong>{writeCount}</strong> {writeCount === 1 ? 'object' : 'objects'} in a single batch{skippedCount ? `, skipping ${skippedCount} conflicting ${skippedCount === 1 ? 'row' : 'rows'}` : ''}. Cancelling leaves the workspace exactly as it is.</p>
          )}
          {rawFile && <p className="csv-filename">Selected file: {rawFile.name}</p>}
        </div>
      )}
    </Modal>
  );
}
