import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileDown,
  FileUp,
  History,
  Info,
  Plus,
  RotateCcw,
  ShieldCheck,
  Undo2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Badge } from './Badge';
import { Button } from './Button';
import { Modal } from './Modal';
import type { MigrationEntry, MigrationPlan, ReviewDecisions } from '../state/migrations';
import { useWorkspace } from '../state/WorkspaceContext';
import { downloadTextFile } from '../domain/export';
import { workspaceFileName } from '../domain/workspaceFile';
import { formatDate } from '../domain/formatters';

type Stage = 'select' | 'review' | 'done';

const VERDICT_META: Record<MigrationEntry['verdict'], { label: string; tone: 'positive' | 'info' | 'danger' | 'warning'; icon: typeof Info }> = {
  added: { label: 'Added', tone: 'info', icon: Plus },
  kept: { label: 'Kept', tone: 'positive', icon: CheckCircle2 },
  invalid: { label: 'Invalidated', tone: 'danger', icon: XCircle },
  review: { label: 'Needs confirmation', tone: 'warning', icon: AlertTriangle },
};

const VERDICT_ORDER: MigrationEntry['verdict'][] = ['invalid', 'review', 'added', 'kept'];
const RECORD_ORDER: MigrationEntry['recordType'][] = ['project', 'preferences', 'artifact', 'zone', 'issue', 'reference'];
const TYPE_LABELS: Record<MigrationEntry['recordType'], string> = {
  project: 'Project',
  preferences: 'Preferences',
  artifact: 'Object',
  zone: 'Zone',
  issue: 'Finding',
  reference: 'Reference',
};

function entryDecision(entry: MigrationEntry, decisions: ReviewDecisions): 'keep' | 'drop' {
  return decisions[entry.id] ?? entry.decision;
}

export function BackupCenter({ onClose }: { open: boolean; onClose: () => void }) {
  const { exportWorkspaceFile, previewWorkspaceImport, commitRecovery, lastRecovery, undoLastRecovery } = useWorkspace();
  const [stage, setStage] = useState<Stage>('select');
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [decisions, setDecisions] = useState<ReviewDecisions>({});
  const [sourceFileName, setSourceFileName] = useState<string | undefined>();
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStage('select');
    setPlan(null);
    setDecisions({});
    setSourceFileName(undefined);
    setParseError(null);
    setBusy(false);
  };

  const close = () => { reset(); onClose(); };

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  };

  const exportFile = () => {
    const result = exportWorkspaceFile();
    if (!result.ok || !result.value) {
      notify(result.message ?? 'Export failed.');
      return;
    }
    downloadTextFile(result.value, workspaceFileName());
    notify('Re-importable workspace file downloaded.');
  };

  const handleFile = async (file: File) => {
    setParseError(null);
    setBusy(true);
    const result = await previewWorkspaceImport(file);
    setBusy(false);
    if (!result.ok) {
      setParseError(result.reason);
      setPlan(null);
      return;
    }
    setPlan(result.plan);
    setSourceFileName(file.name);
    setStage('review');
  };

  const groupedEntries = useMemo(() => {
    if (!plan) return [];
    return [...plan.report.entries].sort((left, right) => {
      const verdictDelta = VERDICT_ORDER.indexOf(left.verdict) - VERDICT_ORDER.indexOf(right.verdict);
      if (verdictDelta !== 0) return verdictDelta;
      const typeDelta = RECORD_ORDER.indexOf(left.recordType) - RECORD_ORDER.indexOf(right.recordType);
      if (typeDelta !== 0) return typeDelta;
      return left.label.localeCompare(right.label);
    });
  }, [plan]);

  const liveCounters = useMemo(() => {
    const counters = { dropped: 0, confirmed: 0 };
    if (!plan) return counters;
    for (const entry of plan.report.entries) {
      if (!entry.adjustable) continue;
      const chosen = entryDecision(entry, decisions);
      if (chosen !== entry.decision) counters.confirmed += 1;
      if (chosen === 'drop') counters.dropped += 1;
    }
    return counters;
  }, [plan, decisions]);

  const toggleEntry = (entry: MigrationEntry) => {
    if (!entry.adjustable) return;
    setDecisions((current) => {
      const currentDecision = current[entry.id] ?? entry.decision;
      return { ...current, [entry.id]: currentDecision === 'keep' ? 'drop' : 'keep' };
    });
  };

  const runRecovery = () => {
    if (!plan) return;
    setBusy(true);
    const result = commitRecovery(plan, decisions, sourceFileName);
    setBusy(false);
    if (!result.ok) {
      notify(result.message ?? 'Recovery failed; the current workspace is unchanged.');
      return;
    }
    setStage('done');
  };

  const undo = () => {
    const result = undoLastRecovery();
    if (result.ok) {
      notify('Recovery rolled back; the previous workspace is active again.');
      reset();
    } else {
      notify(result.message ?? 'Undo failed.');
    }
  };

  return <Modal
    eyebrow="BACKUP & RECOVERY"
    title="Migrate and restore a workspace"
    onClose={close}
    footer={<>
      <Button variant="ghost" onClick={close}>{stage === 'done' ? 'Close' : 'Cancel'}</Button>
      {stage === 'review' && <Button variant="primary" icon={<Upload size={15} />} disabled={busy} onClick={runRecovery}>
        Review plan and restore
      </Button>}
    </>}
  >
    <div className="backup-flow">
      {stage === 'select' && <SelectStage
        busy={busy}
        parseError={parseError}
        onPick={() => fileInputRef.current?.click()}
        onExport={exportFile}
        lastRecovery={lastRecovery}
        onUndo={undo}
      />}
      {stage === 'review' && plan && <ReviewStage
        plan={plan}
        decisions={decisions}
        sourceFileName={sourceFileName}
        groupedEntries={groupedEntries}
        liveCounters={liveCounters}
        onToggle={toggleEntry}
        busy={busy}
      />}
      {stage === 'done' && plan && <DoneStage plan={plan} decisions={decisions} onUndo={undo} onExport={exportFile} />}
    </div>
    <input
      ref={fileInputRef}
      type="file"
      accept="application/json,.json"
      className="backup-file-input"
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void handleFile(file);
        event.target.value = '';
      }}
    />
    {toast && <div className="toast toast-warning backup-toast"><Info size={15} />{toast}</div>}
  </Modal>;
}

function SelectStage({ busy, parseError, onPick, onExport, lastRecovery, onUndo }: {
  busy: boolean;
  parseError: string | null;
  onPick: () => void;
  onExport: () => void;
  lastRecovery: ReturnType<typeof useWorkspace>['lastRecovery'];
  onUndo: () => void;
}) {
  return <div className="backup-select">
    <div className="backup-export-card">
      <div className="backup-card-icon"><FileDown size={20} /></div>
      <div className="backup-card-copy">
        <strong>Export the current workspace</strong>
        <p>Saves the version 2 workspace in a file this build (and future builds) can import again.</p>
      </div>
      <Button variant="secondary" icon={<Download size={15} />} onClick={onExport}>Download file</Button>
    </div>
    <div className="backup-import-card">
      <div className="backup-card-icon"><FileUp size={20} /></div>
      <div className="backup-card-copy">
        <strong>Import and migrate a saved file</strong>
        <p>Current-version files, legacy state exports, and pre-sequence workspaces are recognized automatically. Nothing changes until you approve the reviewed migration.</p>
      </div>
      <Button variant="primary" icon={<Upload size={15} />} disabled={busy} onClick={onPick}>{busy ? 'Reading…' : 'Choose JSON file'}</Button>
    </div>
    {parseError && <div className="backup-error" role="alert"><XCircle size={16} /><span>{parseError}</span></div>}
    {lastRecovery && <div className="backup-last">
      <div><History size={15} /><span>Last recovery: version {lastRecovery.provenance.sourceVersion} file restored on {formatDate(lastRecovery.provenance.restoredAt)}.</span></div>
      <Button variant="ghost" icon={<Undo2 size={14} />} onClick={onUndo}>Undo that recovery</Button>
    </div>}
    <div className="backup-safety"><ShieldCheck size={15} /><span>Recovery is validated before writing and can be rolled back; your current storage stays usable if anything fails.</span></div>
  </div>;
}

function ReviewStage({ plan, decisions, sourceFileName, groupedEntries, liveCounters, onToggle, busy }: {
  plan: MigrationPlan;
  decisions: ReviewDecisions;
  sourceFileName: string | undefined;
  groupedEntries: MigrationEntry[];
  liveCounters: { dropped: number; confirmed: number };
  onToggle: (entry: MigrationEntry) => void;
  busy: boolean;
}) {
  const { counters, report } = plan;
  return <div className="backup-review">
    <div className="backup-review-head">
      <div>
        <div className="eyebrow">REVIEW MIGRATION</div>
        <h3>{sourceFileName ?? 'Pasted workspace'}</h3>
      </div>
      <Badge tone="info">Source version {report.sourceVersion}</Badge>
    </div>
    <ol className="backup-steps">
      {report.steps.length === 0 && <li className="backup-step current"><span className="backup-step-num">v2</span><span className="backup-step-copy"><strong>Current format</strong><small>No structural migration needed; references are re-checked.</small></span></li>}
      {report.steps.map((step) => <li key={`${step.from}-${step.to}`} className="backup-step current">
        <span className="backup-step-num">v{step.from}<ArrowRight size={11} />v{step.to}</span>
        <span className="backup-step-copy"><strong>Migration step</strong><small>{step.description}</small></span>
      </li>)}
    </ol>
    <div className="backup-counters">
      <Counter label="Added" value={counters.added} tone="info" />
      <Counter label="Kept" value={counters.kept} tone="positive" />
      <Counter label="Invalidated" value={counters.invalid} tone="danger" />
      <Counter label="Needs confirmation" value={counters.review} tone="warning" />
    </div>
    <div className="backup-counter-note">
      {liveCounters.confirmed > 0 || liveCounters.dropped > 0
        ? <><CheckCircle2 size={14} /> {liveCounters.confirmed} record{liveCounters.confirmed === 1 ? '' : 's'} confirmed manually · {liveCounters.dropped} set to drop.</>
        : <><Info size={14} /> Records flagged “Needs confirmation” are kept by default; toggle any row to drop it instead. Invalid references are always removed.</>}
    </div>
    <div className="backup-entry-list" aria-busy={busy}>
      {groupedEntries.map((entry) => {
        const meta = VERDICT_META[entry.verdict];
        const Icon = meta.icon;
        const decision = entryDecision(entry, decisions);
        return <button
          type="button"
          key={entry.id}
          className={`backup-entry verdict-${entry.verdict} ${entry.adjustable ? 'adjustable' : 'locked'} drop-${decision}`}
          onClick={() => onToggle(entry)}
          disabled={!entry.adjustable}
          title={entry.adjustable ? 'Click to keep or drop this record' : undefined}
        >
          <span className="backup-entry-type"><Icon size={14} />{TYPE_LABELS[entry.recordType]}</span>
          <span className="backup-entry-body"><strong>{entry.label}</strong><small>{entry.detail}</small></span>
          <span className="backup-entry-decision">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {entry.adjustable && <span className={`decision-pill decision-${decision}`}>{decision === 'keep' ? 'Keep' : 'Drop'}</span>}
          </span>
        </button>;
      })}
    </div>
  </div>;
}

function Counter({ label, value, tone }: { label: string; value: number; tone: 'positive' | 'info' | 'danger' | 'warning' }) {
  return <div className={`backup-counter counter-${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

function DoneStage({ plan, decisions, onUndo, onExport }: {
  plan: MigrationPlan;
  decisions: ReviewDecisions;
  onUndo: () => void;
  onExport: () => void;
}) {
  let dropped = 0;
  for (const entry of plan.report.entries) {
    if (!entry.adjustable) continue;
    if ((decisions[entry.id] ?? entry.decision) === 'drop') dropped += 1;
  }
  return <div className="backup-done">
    <div className="backup-done-icon"><ShieldCheck size={28} /></div>
    <h3>Workspace restored</h3>
    <p>The migrated workspace passed structural validation, replaced the previous storage, and is now active. The previous workspace is held for rollback.</p>
    <div className="backup-counters">
      <Counter label="Added" value={plan.counters.added} tone="info" />
      <Counter label="Kept" value={plan.counters.kept} tone="positive" />
      <Counter label="Invalidated" value={plan.counters.invalid} tone="danger" />
      <Counter label="Dropped by review" value={dropped} tone="warning" />
    </div>
    <div className="backup-done-actions">
      <Button variant="secondary" icon={<Undo2 size={15} />} onClick={onUndo}>Roll back recovery</Button>
      <Button variant="primary" icon={<Download size={15} />} onClick={onExport}>Export migrated file</Button>
    </div>
    <div className="backup-safety"><RotateCcw size={14} /><span>You can also undo the most recent recovery later from this dialog.</span></div>
  </div>;
}
