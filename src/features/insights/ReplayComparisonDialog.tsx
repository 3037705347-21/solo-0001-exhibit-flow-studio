import { AlertTriangle, ArrowRight, History, Play, Trash2 } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { formatDate, formatMinutes, titleCase } from '../../domain/formatters';
import type { JourneyAnalysis, ScenarioInput, ScenarioProjection, ScenarioRecord, WorkspaceState } from '../../domain/models';
import { projectScenario } from '../../domain/scenario';
import { isRecordStale } from '../../domain/scenarioRecords';

interface ReplayComparisonDialogProps {
  record: ScenarioRecord;
  state: WorkspaceState;
  analysis: JourneyAnalysis;
  currentPlanVersion: string;
  onLoadInputs: (input: ScenarioInput) => void;
  onDelete: (recordId: string) => void;
  onClose: () => void;
}

function inputSummary(input: ScenarioInput): string {
  return `${titleCase(input.pace)} pace · ${input.groupSize} people · ${input.accessibilityPriority}% access`;
}

function OutcomeColumn({
  eyebrow,
  title,
  badge,
  projection,
  frozen,
}: {
  eyebrow: string;
  title: string;
  badge?: React.ReactNode;
  projection: ScenarioProjection;
  frozen?: boolean;
}) {
  return (
    <div className={`replay-column ${frozen ? 'replay-frozen' : 'replay-current'}`}>
      <div className="replay-column-head">
        <div className="eyebrow">{eyebrow}</div>
        <h3>{title}</h3>
        {badge}
      </div>
      <dl className="replay-metrics">
        <div><dt>Expected duration</dt><dd>{formatMinutes(projection.durationMinutes)}</dd></div>
        <div><dt>Comfort score</dt><dd>{projection.comfortScore}/100</dd></div>
        <div><dt>Access coverage</dt><dd>{projection.accessibilityScore}/100</dd></div>
        <div><dt>Narrative</dt><dd>{projection.narrativeScore}/100</dd></div>
        <div><dt>Pressure zones</dt><dd>{projection.pressureZoneIds.length}</dd></div>
      </dl>
      <div className="replay-recommendations">
        <div className="eyebrow">RECOMMENDED BECAUSE</div>
        {projection.recommendations.map((recommendation) => (
          <div className="recommendation" key={recommendation}><ArrowRight size={14} /><span>{recommendation}</span></div>
        ))}
      </div>
    </div>
  );
}

export function ReplayComparisonDialog({ record, state, analysis, currentPlanVersion, onLoadInputs, onDelete, onClose }: ReplayComparisonDialogProps) {
  // Recomputed from the SAME inputs against the CURRENT plan. It is presented
  // as a fresh projection alongside the record — it never overwrites it.
  const liveProjection = projectScenario(state, analysis, record.input);
  const stale = isRecordStale(record, currentPlanVersion);

  return (
    <Modal
      eyebrow="REPLAY COMPARISON"
      title={record.name}
      onClose={onClose}
      footer={<>
        <Button variant="danger" icon={<Trash2 size={15} />} data-testid="replay-delete" onClick={() => onDelete(record.id)}>Delete</Button>
        <span className="replay-footer-spacer" />
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" icon={<Play size={15} />} data-testid="replay-load-inputs" onClick={() => { onLoadInputs(record.input); onClose(); }}>Load inputs into lab</Button>
      </>}
    >
      <div className="replay-meta">
        <History size={15} />
        <span>Saved {formatDate(record.createdAt)} · inputs: {inputSummary(record.input)}</span>
        {stale
          ? <Badge tone="warning"><AlertTriangle size={12} /> Basis changed</Badge>
          : <Badge tone="positive">Basis current</Badge>}
      </div>
      {stale && (
        <div className="replay-stale-notice" data-testid="replay-stale-notice">
          <AlertTriangle size={15} />
          <div>
            <strong>The plan changed since this comparison was saved.</strong>
            <p>
              The saved outcome below stays frozen on plan version <code>{record.planVersion}</code> ({record.planBasis.artifactCount} objects · {record.planBasis.placedCount} placed · {record.planBasis.totalDwellMinutes} min). It is shown for review and is not replaced by the current-plan projection on the right.
            </p>
          </div>
        </div>
      )}
      <div className="replay-grid">
        <OutcomeColumn
          eyebrow="SAVED OUTCOME — IMMUTABLE"
          title={`Plan v${record.planVersion.slice(0, 6)}`}
          frozen
          badge={<Badge tone="neutral">{record.planBasis.zoneCount} zones</Badge>}
          projection={record.projection}
        />
        <div className="replay-vs" aria-hidden="true"><ArrowRight size={18} /></div>
        <OutcomeColumn
          eyebrow="SAME INPUTS ON CURRENT PLAN"
          title={`Plan v${currentPlanVersion.slice(0, 6)}`}
          badge={<Badge tone="info">Live replay</Badge>}
          projection={liveProjection}
        />
      </div>
    </Modal>
  );
}
