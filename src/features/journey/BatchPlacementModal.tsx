import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ArtifactGlyph } from '../../components/ArtifactGlyph';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import {
  evaluateBatchPlacement,
  placementFingerprint,
  type BatchPlacementPlan,
  type CandidateAssessment,
  type PlacementCandidate,
} from '../../domain/batchPlacement';
import { createId } from '../../domain/ids';
import { titleCase } from '../../domain/formatters';
import { getUnplacedArtifacts } from '../../domain/journeyAnalysis';
import { useWorkspace } from '../../state/WorkspaceContext';

const VERDICT_BADGE: Record<CandidateAssessment['verdict'], { tone: 'positive' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  ready: { tone: 'positive', label: 'Ready' },
  tradeoff: { tone: 'warning', label: 'Trade-off' },
  blocked: { tone: 'danger', label: 'Blocked' },
  'already-placed': { tone: 'neutral', label: 'Placed' },
};

export function BatchPlacementModal({ onClose, onApplied }: { onClose: () => void; onApplied: (message: string) => void }) {
  const { state, commitBatchPlacement } = useWorkspace();
  const [transactionId] = useState(() => createId('batch'));
  const [baseFingerprint, setBaseFingerprint] = useState(() => placementFingerprint(state));
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const unplaced = getUnplacedArtifacts(state.artifacts, state.zones);
  const zones = useMemo(() => [...state.zones].sort((a, b) => a.sequence - b.sequence), [state.zones]);
  const candidates: PlacementCandidate[] = useMemo(
    () => unplaced
      .filter((artifact) => selections[artifact.id])
      .map((artifact) => ({ artifactId: artifact.id, zoneId: selections[artifact.id] })),
    [unplaced, selections],
  );
  const plan: BatchPlacementPlan = useMemo(
    () => ({ transactionId, baseFingerprint, candidates }),
    [transactionId, baseFingerprint, candidates],
  );
  const evaluation = useMemo(() => evaluateBatchPlacement(state, plan), [state, plan]);
  const assessmentByArtifact = useMemo(
    () => new Map(evaluation.assessments.map((assessment) => [assessment.candidate.artifactId, assessment])),
    [evaluation.assessments],
  );
  const touchedZoneIds = useMemo(() => new Set(candidates.map((candidate) => candidate.zoneId)), [candidates]);
  const artifactById = useMemo(() => new Map(state.artifacts.map((artifact) => [artifact.id, artifact])), [state.artifacts]);

  const blocked = evaluation.assessments.filter((assessment) => assessment.verdict === 'blocked');
  const tradeoffs = evaluation.assessments.filter((assessment) => assessment.verdict === 'tradeoff');
  const applyCount = evaluation.readyCount + evaluation.tradeoffCount;
  const needsAcknowledgement = evaluation.tradeoffCount > 0;
  const canConfirm = evaluation.canApply && (!needsAcknowledgement || acknowledged);

  const choose = (artifactId: string, zoneId: string) => {
    setFeedback(null);
    setSelections((current) => ({ ...current, [artifactId]: zoneId }));
  };

  const confirm = () => {
    const result = commitBatchPlacement(plan);
    if (result.ok) {
      onApplied(result.message ?? `Batch placement applied: ${applyCount} object${applyCount === 1 ? '' : 's'} placed.`);
      onClose();
      return;
    }
    if (result.value?.stale) setBaseFingerprint(result.value.currentFingerprint);
    setFeedback(result.message ?? 'The batch could not be applied.');
  };

  return <Modal
    title="Batch placement"
    eyebrow="PLACEMENT TRANSACTION"
    onClose={onClose}
    footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!canConfirm} onClick={confirm}>
        Apply batch{applyCount > 0 ? ` (${applyCount})` : ''}
      </Button>
    </>}
  >
    {unplaced.length === 0 ? (
      <EmptyState icon={<CheckCircle2 size={22} />} title="Queue is clear" detail="Every collection object already has a place in the visitor journey." />
    ) : <>
      <p className="batch-intro">Assign a zone to each queued object. The batch is evaluated as one transaction: it applies in full or not at all.</p>
      <div className="batch-candidate-list">
        {unplaced.map((artifact) => {
          const assessment = assessmentByArtifact.get(artifact.id);
          const verdict = assessment?.verdict;
          return <div className={`batch-candidate-row ${verdict === 'blocked' ? 'is-blocked' : ''}`} key={artifact.id}>
            <ArtifactGlyph color={artifact.color} size="small" />
            <div className="batch-candidate-meta">
              <strong>{artifact.title}</strong>
              <small>{artifact.accessionId} · {titleCase(artifact.narrativeRole)} · {artifact.dwellMinutes} min</small>
            </div>
            <select
              aria-label={`Zone for ${artifact.title}`}
              value={selections[artifact.id] ?? ''}
              onChange={(event) => choose(artifact.id, event.target.value)}
            >
              <option value="">Not in this batch</option>
              {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
            </select>
            {verdict && <Badge tone={VERDICT_BADGE[verdict].tone}>{VERDICT_BADGE[verdict].label}</Badge>}
          </div>;
        })}
      </div>

      {candidates.length > 0 && <div className="batch-assessment">
        <div className="batch-summary-row">
          <Badge tone="positive">{evaluation.readyCount} ready</Badge>
          <Badge tone={evaluation.tradeoffCount ? 'warning' : 'neutral'}>{evaluation.tradeoffCount} trade-offs</Badge>
          <Badge tone={evaluation.blockedCount ? 'danger' : 'neutral'}>{evaluation.blockedCount} blocked</Badge>
        </div>

        {blocked.length > 0 && <div className="finding-list compact">
          {blocked.map((assessment) => <div className="finding-row error" key={assessment.candidate.artifactId}>
            <XCircle size={15} />
            <span>
              <strong>{assessment.artifact?.title ?? 'Unknown object'} cannot be placed</strong>
              {assessment.reasons.map((reason) => <small key={reason}>{reason}</small>)}
            </span>
          </div>)}
        </div>}

        {tradeoffs.length > 0 && <div className="finding-list compact">
          {tradeoffs.map((assessment) => <div className="finding-row warning" key={assessment.candidate.artifactId}>
            <AlertTriangle size={15} />
            <span>
              <strong>{assessment.artifact?.title ?? 'Unknown object'}</strong>
              {assessment.reasons.map((reason) => <small key={reason}>{reason}</small>)}
            </span>
          </div>)}
        </div>}

        {(evaluation.roleGaps.length > 0 || evaluation.keyObjectGaps.length > 0) && <div className="finding-list compact">
          {evaluation.roleGaps.map((role) => <div className="finding-row notice" key={role}>
            <Info size={15} />
            <span><strong>Missing {titleCase(role)} role</strong><small>No placed object covers this narrative role after the batch.</small></span>
          </div>)}
          {evaluation.keyObjectGaps.map((artifactId) => <div className="finding-row notice" key={artifactId}>
            <Info size={15} />
            <span><strong>Key object still unplaced</strong><small>{artifactById.get(artifactId)?.title ?? artifactId} remains outside the journey after the batch.</small></span>
          </div>)}
        </div>}

        <div className="batch-zone-summary">
          {evaluation.zoneSummaries.filter((summary) => touchedZoneIds.has(summary.zoneId)).map((summary) => {
            const over = summary.overCapacity || summary.overObjectLimit;
            return <div className={`batch-zone-row ${over ? 'is-over' : ''}`} key={summary.zoneId}>
              <strong>{summary.zoneName}</strong>
              <span>{summary.resultingObjects}/{summary.maxObjects} objects</span>
              <span>{summary.resultingMinutes}/{summary.capacityMinutes} min</span>
            </div>;
          })}
        </div>

        {needsAcknowledgement && <label className="batch-acknowledge">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>I have reviewed the {evaluation.tradeoffCount} trade-off{evaluation.tradeoffCount === 1 ? '' : 's'} above and accept them for this batch.</span>
        </label>}

        {feedback && <div className="finding-row warning"><AlertTriangle size={15} /><span><strong>{feedback}</strong></span></div>}
      </div>}
    </>}
  </Modal>;
}
