import { AlertTriangle, ArrowRight, CheckCircle2, Download, FileInput, FileQuestion, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { downloadTextFile, workspaceFileName } from '../domain/export';
import type { MigrationChange, MigrationPlan, ConfirmResolution } from '../state/migrations';
import { useWorkspace } from '../state/WorkspaceContext';
import { Badge } from './Badge';
import { Button } from './Button';
import { Modal } from './Modal';

type Phase = 'select' | 'review' | 'error' | 'restored';

const OUTCOME_META: Record<MigrationChange['outcome'], { label: string; tone: 'positive' | 'neutral' | 'danger' | 'warning'; detail: string }> = {
  added: { label: 'Will be added', tone: 'positive', detail: 'Missing fields or records are filled with safe defaults.' },
  kept: { label: 'Kept unchanged', tone: 'neutral', detail: 'Validated with no changes.' },
  invalidated: { label: 'Invalidated', tone: 'danger', detail: 'Cannot be read safely and will not be restored.' },
  confirm: { label: 'Needs your decision', tone: 'warning', detail: 'A reference points at a record missing from the file.' },
};

export function WorkspaceTransferModal({ onClose }: { onClose: () => void }) {
  const { state, exportWorkspace, previewImport, restoreFromPlan, undoLastRestore, acceptLastRestore } = useWorkspace();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ConfirmResolution>>({});
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

  const planValue = plan;

  const counts = useMemo(() => {
    const next = { added: 0, kept: 0, invalidated: 0, confirm: 0 };
    for (const change of planValue?.changes ?? []) next[change.outcome] += 1;
    return next;
  }, [planValue]);

  const openFile = () => fileInputRef.current?.click();

  const handleFile = async (file: File) => {
    setFileName(file.name);
    try {
      const contents = await file.text();
      const result = previewImport(contents);
      if (!result.ok || !result.value) {
        setError(result.message ?? 'This file could not be read.');
        setPhase('error');
        return;
      }
      setPlan(result.value);
      setResolutions({});
      setPhase('review');
    } catch {
      setError('The file could not be read from disk.');
      setPhase('error');
    }
  };

  const choose = (confirmationId: string, resolution: ConfirmResolution) => {
    setResolutions((current) => ({ ...current, [confirmationId]: resolution }));
  };

  const allDecided = planValue ? planValue.confirmations.every((confirmation) => Boolean(resolutions[confirmation.id])) : false;

  const runRestore = () => {
    if (!planValue) return;
    const result = restoreFromPlan(planValue, resolutions);
    if (!result.ok) {
      setError(result.message ?? 'The restore failed; your current workspace is unchanged.');
      setPhase('error');
      return;
    }
    setRestoreMessage(`The workspace "${planValue.candidate?.project.title}" was restored. Review it, then keep it or undo to return to the previous workspace.`);
    setPhase('restored');
  };

  const downloadCurrent = () => {
    const result = exportWorkspace();
    if (!result.ok || !result.value) {
      setError(result.message ?? 'Export failed.');
      setPhase('error');
      return;
    }
    downloadTextFile(result.value, workspaceFileName());
  };

  const undo = () => {
    const result = undoLastRestore();
    if (!result.ok) {
      setError(result.message ?? 'Undo failed.');
      setPhase('error');
      return;
    }
    onClose();
  };

  return <Modal
    eyebrow="WORKSPACE TRANSFER"
    title="Import, migrate & restore"
    onClose={onClose}
    footer={phase === 'review'
      ? <><Button variant="ghost" onClick={onClose}>Cancel (current workspace stays)</Button>
        <Button variant="primary" icon={<ShieldCheck size={16} />} disabled={!allDecided} onClick={runRestore}>Restore workspace</Button></>
      : phase === 'restored'
        ? <><Button variant="ghost" icon={<RotateCcw size={16} />} onClick={undo}>Undo restore</Button><Button variant="primary" onClick={() => { const accepted = acceptLastRestore(); if (accepted.ok) onClose(); else { setError(accepted.message ?? 'Could not finalize.'); setPhase('error'); } }}>Keep restored workspace</Button></>
        : <Button variant="ghost" onClick={onClose}>Close</Button>}
  >
    <input
      ref={fileInputRef}
      type="file"
      accept="application/json,.json"
      hidden
      data-testid="workspace-file-input"
      onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleFile(file); event.target.value = ''; }}
    />

    {phase === 'select' && <div className="transfer-select">
      <p className="transfer-intro">Choose a workspace file exported from ExhibitFlow. Its original version is detected automatically; each migration step is reviewed before anything is written. Your current workspace stays intact until you confirm the restore, and the restore can be undone.</p>
      <div className="transfer-actions">
        <button className="transfer-choice" onClick={openFile} data-testid="choose-workspace-file">
          <FileInput size={22} />
          <strong>Import & migrate a file</strong>
          <small>Legacy exports, current exports, and storage dumps are supported.</small>
        </button>
        <button className="transfer-choice" onClick={downloadCurrent} data-testid="export-current-workspace">
          <Download size={22} />
          <strong>Export current workspace</strong>
          <small>Downloads <code>{workspaceFileName()}</code>, which can be re-imported.</small>
        </button>
      </div>
      <div className="transfer-current">Current workspace: <strong>{state.project.title}</strong> · schema version {state.version}</div>
    </div>}

    {phase === 'review' && planValue && <div className="transfer-review">
      <div className="transfer-source">
        <div><div className="eyebrow">SOURCE FILE</div><strong>{fileName || 'Pasted workspace'}</strong></div>
        <div className="transfer-version-flow">
          <Badge tone="info">v{planValue.sourceVersion === 0 ? '0 (legacy)' : planValue.sourceVersion}</Badge>
          <ArrowRight size={14} />
          <Badge tone="positive">v{planValue.targetVersion}</Badge>
        </div>
      </div>

      <div className="transfer-counts">
        <span className="transfer-count positive"><CheckCircle2 size={14} /> {counts.added} added</span>
        <span className="transfer-count neutral"><ShieldCheck size={14} /> {counts.kept} kept</span>
        <span className="transfer-count danger"><XCircle size={14} /> {counts.invalidated} invalidated</span>
        <span className="transfer-count warning"><AlertTriangle size={14} /> {counts.confirm} need confirmation</span>
      </div>

      {planValue.confirmations.length > 0 && <section className="transfer-confirm">
        <div className="eyebrow">RECORDS NEEDING A DECISION</div>
        <p className="transfer-section-copy">Broken references are never guessed. For each record, either drop just the broken link (the record itself is kept) or exclude the whole record from the restore.</p>
        <div className="transfer-confirm-list">
          {planValue.confirmations.map((confirmation) => {
            const decision = resolutions[confirmation.id];
            return <div className="transfer-confirm-row" key={confirmation.id} data-testid={`confirmation-${confirmation.id}`}>
              <FileQuestion size={17} />
              <div className="transfer-confirm-copy">
                <strong>{confirmation.recordLabel}</strong>
                <small>{confirmation.detail}</small>
              </div>
              <div className="transfer-confirm-buttons" role="group" aria-label={`Decision for ${confirmation.recordLabel}`}>
                <button className={decision === 'keep-with-dropped-link' ? 'selected' : ''} onClick={() => choose(confirmation.id, 'keep-with-dropped-link')}>Drop broken link, keep record</button>
                <button className={decision === 'drop-record' ? 'selected danger' : 'danger'} onClick={() => choose(confirmation.id, 'drop-record')}>Exclude record</button>
              </div>
            </div>;
          })}
        </div>
      </section>}

      <section className="transfer-steps">
        <div className="eyebrow">MIGRATION STEPS (IN ORDER)</div>
        {planValue.steps.map((step) => <details className="transfer-step" key={step.stageId} open={step.stageId === 'integrity-check'}>
          <summary>
            <div><strong>{step.title}</strong><small>v{step.fromVersion} → v{step.toVersion} · {step.changes.length} record{step.changes.length === 1 ? '' : 's'}</small></div>
          </summary>
          <p className="transfer-step-description">{step.description}</p>
          <ChangeList changes={step.changes} />
        </details>)}
      </section>

      {!allDecided && planValue.confirmations.length > 0 && <div className="transfer-waiting"><AlertTriangle size={15} /><span>Decide on every flagged record to enable the restore.</span></div>}
    </div>}

    {phase === 'error' && <div className="transfer-error">
      <XCircle size={26} />
      <div><strong>This file cannot be restored</strong><p>{error}</p></div>
      <Button variant="secondary" onClick={() => { setPhase('select'); setError(null); }}>Choose another file</Button>
    </div>}

    {phase === 'restored' && <div className="transfer-restored">
      <CheckCircle2 size={28} />
      <div><strong>Workspace restored</strong><p>{restoreMessage}</p></div>
    </div>}
  </Modal>;
}

function ChangeList({ changes }: { changes: MigrationChange[] }) {
  if (changes.length === 0) return <div className="transfer-no-changes">No record changes in this step.</div>;
  const grouped: Record<MigrationChange['outcome'], MigrationChange[]> = { added: [], kept: [], invalidated: [], confirm: [] };
  for (const change of changes) grouped[change.outcome].push(change);
  return <div className="transfer-groups">
    {(Object.keys(grouped) as Array<MigrationChange['outcome']>).map((outcome) => {
      const list = grouped[outcome];
      if (list.length === 0) return null;
      const meta = OUTCOME_META[outcome];
      return <div className={`transfer-group transfer-group-${outcome}`} key={outcome}>
        <div className="transfer-group-head"><Badge tone={meta.tone}>{meta.label} · {list.length}</Badge></div>
        <ul>
          {list.map((change, index) => <li key={`${change.recordId ?? change.label}-${index}`}>
            <strong>{change.label}</strong>
            <small>{change.detail}</small>
          </li>)}
        </ul>
      </div>;
    })}
  </div>;
}
