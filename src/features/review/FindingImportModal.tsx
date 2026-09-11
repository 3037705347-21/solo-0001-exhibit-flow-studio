import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileUp, Send, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { downloadTextFile } from '../../domain/export';
import {
  buildFindingImportPlan,
  findingImportTemplateCsv,
  FINDING_IMPORT_TEMPLATE_NAME,
  type FindingImportPlan,
  type FindingImportRow,
} from '../../domain/findingImport';
import type { IssueSeverity, WorkspaceState } from '../../domain/models';
import { useWorkspace } from '../../state/WorkspaceContext';

const STATUS_LABELS: Record<FindingImportRow['status'], string> = {
  create: 'Create',
  ignore: 'Ignore',
  error: 'Fail',
};

function severityLabel(severity: IssueSeverity | null): string {
  if (severity === 'critical') return 'Critical';
  if (severity === 'warning') return 'Warning';
  if (severity === 'note') return 'Note';
  return '—';
}

function RowLinks({ row }: { row: FindingImportRow }) {
  const links: string[] = [];
  if (row.zoneName) links.push(row.zoneName);
  else if (row.rawZoneName) links.push(`“${row.rawZoneName}”`);
  if (row.accessionId) links.push(row.accessionId);
  else if (row.rawAccessionId) links.push(`“${row.rawAccessionId}”`);
  return <span className="import-row-links">{links.length ? links.join(' · ') : 'No links'}</span>;
}

export function FindingImportModal({ state, onClose }: { state: WorkspaceState; onClose: () => void }) {
  const { importFindings } = useWorkspace();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [plan, setPlan] = useState<FindingImportPlan | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<{ created: number; ignored: number; failed: number } | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setCommitted(null);
    try {
      const text = await file.text();
      const nextPlan = buildFindingImportPlan(text, state);
      setPlan(nextPlan);
      setFileError(nextPlan.ok ? null : nextPlan.errors.join(' '));
    } catch {
      setPlan(null);
      setFileError('The file could not be read. Choose a UTF-8 encoded CSV export.');
    }
  };

  const resetPicker = () => {
    if (fileInputRef.current) fileInputRef.current.value = '';
    setFileName(null);
    setPlan(null);
    setFileError(null);
  };

  const downloadTemplate = () => {
    downloadTextFile(findingImportTemplateCsv(), FINDING_IMPORT_TEMPLATE_NAME, 'text/csv;charset=utf-8');
  };

  const confirmImport = () => {
    if (!plan) return;
    const drafts = plan.rows
      .filter((row) => row.status === 'create' && row.severity)
      .map((row) => ({
        title: row.title,
        description: row.description,
        severity: row.severity as IssueSeverity,
        owner: row.owner,
        zoneId: row.zoneId,
        artifactId: row.artifactId,
      }));
    const result = importFindings(drafts);
    if (!result.ok) {
      setFileError(result.message ?? 'The import could not be completed.');
      return;
    }
    setCommitted({ created: result.value?.createdCount ?? 0, ignored: plan.ignoreCount, failed: plan.failCount });
  };

  const done = committed !== null;

  return <Modal
    className="wide"
    eyebrow="BULK FINDINGS"
    title="Import findings from CSV"
    onClose={onClose}
    footer={<div className="import-footer">
      <Button variant="ghost" onClick={downloadTemplate} icon={<Download size={15} />}>Download template</Button>
      <span className="import-footer-spacer" />
      <Button variant="ghost" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
      {!done && plan?.ok && plan.createCount > 0 && <Button
        variant="primary"
        icon={<Send size={15} />}
        onClick={confirmImport}
        data-testid="import-confirm"
      >Import {plan.createCount} finding{plan.createCount === 1 ? '' : 's'}</Button>}
    </div>}
  >
    <div className="import-flow">
      <p className="import-intro">
        Select a CSV with columns <code>Title</code>, <code>Description</code>, <code>Severity</code>,
        <code>Owner</code>, <code>Zone Name</code>, and <code>Accession ID</code>. Zone names and accession IDs
        are matched against this plan; unmatched rows are reported before anything is saved.
      </p>

      {!done && <>
        <div className="import-picker">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="import-file-input"
            data-testid="import-file-input"
            onChange={(event) => { void handleFile(event.target.files?.[0]); }}
          />
          <Button variant="secondary" icon={<FileUp size={15} />} onClick={() => fileInputRef.current?.click()}>
            Choose CSV file
          </Button>
          <span className="import-file-name" data-testid="import-file-name">{fileName ?? 'No file selected yet.'}</span>
          {fileName && <button className="import-clear" onClick={resetPicker}>Clear</button>}
        </div>

        {fileError && <div className="import-file-error" data-testid="import-file-error"><AlertTriangle size={15} /><span>{fileError}</span></div>}

        {plan?.ok && <ImportPreview plan={plan} />}
      </>}

      {done && <div className="import-done" data-testid="import-done">
        <CheckCircle2 size={26} />
        <div>
          <strong>Import complete</strong>
          <p>
            {committed.created} finding{committed.created === 1 ? '' : 's'} created as open,
            {' '}{committed.ignored} duplicate row{committed.ignored === 1 ? '' : 's'} ignored,
            {' '}{committed.failed} row{committed.failed === 1 ? '' : 's'} failed.
          </p>
        </div>
      </div>}
    </div>
  </Modal>;
}

function ImportPreview({ plan }: { plan: FindingImportPlan }) {
  const hasNothing = plan.createCount === 0 && plan.ignoreCount === 0 && plan.failCount === 0;
  return <div className="import-preview" data-testid="import-preview">
    <div className="import-summary" role="group" aria-label="Import summary">
      <div className="import-summary-cell import-create" data-testid="import-count-create">
        <strong>{plan.createCount}</strong><span>new</span>
      </div>
      <div className="import-summary-cell import-ignore" data-testid="import-count-ignore">
        <strong>{plan.ignoreCount}</strong><span>ignored</span>
      </div>
      <div className="import-summary-cell import-fail" data-testid="import-count-fail">
        <strong>{plan.failCount}</strong><span>failed</span>
      </div>
    </div>

    {hasNothing && <p className="import-empty">The CSV only contained a header row. Add finding rows and choose the file again.</p>}
    {plan.createCount === 0 && !hasNothing && <p className="import-note-line"><AlertTriangle size={14} /> No rows can be created. Fix the failed rows below and reselect the file to continue.</p>}

    {!hasNothing && <div className="import-table-wrap">
      <table className="import-table">
        <thead>
          <tr><th scope="col">Line</th><th scope="col">Result</th><th scope="col">Title / problem</th><th scope="col">Severity</th><th scope="col">Owner</th><th scope="col">Zone &amp; object</th></tr>
        </thead>
        <tbody>
          {plan.rows.map((row) => (
            <tr key={row.lineNumber} className={`import-row import-row-${row.status}`} data-testid={`import-row-${row.lineNumber}`}>
              <td className="import-line">{row.lineNumber}</td>
              <td>
                <Badge tone={row.status === 'create' ? 'positive' : row.status === 'ignore' ? 'info' : 'danger'}>
                  {STATUS_LABELS[row.status]}
                </Badge>
              </td>
              <td>
                <div className="import-title">{row.title || <em>Untitled</em>}</div>
                {row.status === 'ignore' && <div className="import-detail" data-testid={`import-duplicate-${row.lineNumber}`}>{row.duplicateReason}</div>}
                {row.status === 'error' && <ul className="import-errors" data-testid={`import-errors-${row.lineNumber}`}>
                  {row.errors.map((error) => <li key={error}><XCircle size={12} />{error}</li>)}
                </ul>}
              </td>
              <td>{severityLabel(row.severity)}</td>
              <td>{row.owner || '—'}</td>
              <td><RowLinks row={row} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>}

    <p className="import-policy" data-testid="import-policy">
      <FileSpreadsheet size={14} />
      New findings start <strong>open</strong> with the owner named in the CSV. Identical titles with identical
      zone and object links are ignored; failed rows are never created, and confirming either creates every new
      row or none at all.
    </p>
  </div>;
}
