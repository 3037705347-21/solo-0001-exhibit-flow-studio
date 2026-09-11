import { useState } from 'react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { emptyArtifactDraft, validateArtifactDraft } from '../../domain/artifactValidation';
import { titleCase } from '../../domain/formatters';
import type { ArtifactDraft, NarrativeRole, Sensitivity, WorkspaceState } from '../../domain/models';

const roleOptions: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const sensitivityOptions: Sensitivity[] = ['standard', 'low-light', 'fragile'];

export interface PendingSandboxArtifact {
  draft: ArtifactDraft;
  targetZoneId: string;
}

export function SandboxAddArtifactModal({
  state,
  stagedDrafts,
  onClose,
  onAdd,
}: {
  state: WorkspaceState;
  stagedDrafts: ArtifactDraft[];
  onClose: () => void;
  onAdd: (pending: PendingSandboxArtifact) => void;
}) {
  const [draft, setDraft] = useState<ArtifactDraft>(emptyArtifactDraft);
  const [targetZoneId, setTargetZoneId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const update = <K extends keyof ArtifactDraft>(key: K, value: ArtifactDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = () => {
    // Merge staged sibling drafts as minimal stand-ins so duplicate accession IDs are caught.
    const siblingArtifacts = stagedDrafts.map((sibling) => ({ accessionId: sibling.accessionId }));
    const validation = validateArtifactDraft(
      draft,
      [...state.artifacts, ...siblingArtifacts] as typeof state.artifacts,
    );
    if (validation.length) {
      setErrors(Object.fromEntries(validation.map((error) => [error.field, error.message])));
      return;
    }
    onAdd({ draft, targetZoneId });
  };

  const orderedZones = [...state.zones].sort((left, right) => left.sequence - right.sequence);

  return (
    <Modal
      eyebrow="TRIAL OBJECT"
      title="Stage an unrecorded object"
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Stage in sandbox</Button></>}
    >
      <div className="form-grid">
        <TextField label="Accession ID" value={draft.accessionId} onChange={(event) => update('accessionId', event.target.value)} error={errors.accessionId} placeholder="AF-2027-001" />
        <TextField label="Title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="Object title" />
        <TextField label="Maker / source" value={draft.maker} onChange={(event) => update('maker', event.target.value)} error={errors.maker} />
        <TextField label="Medium" value={draft.medium} onChange={(event) => update('medium', event.target.value)} error={errors.medium} />
        <TextField label="Width (cm)" type="number" min="0" step="0.1" value={draft.width} onChange={(event) => update('width', event.target.value)} error={errors.width} />
        <TextField label="Height (cm)" type="number" min="0" step="0.1" value={draft.height} onChange={(event) => update('height', event.target.value)} error={errors.height} />
        <TextField label="Depth (cm)" type="number" min="0" step="0.1" value={draft.depth} onChange={(event) => update('depth', event.target.value)} error={errors.depth} />
        <TextField label="Dwell time (min)" type="number" min="1" max="30" value={draft.dwellMinutes} onChange={(event) => update('dwellMinutes', event.target.value)} error={errors.dwellMinutes} />
        <SelectField label="Narrative role" value={draft.narrativeRole} onChange={(event) => update('narrativeRole', event.target.value as NarrativeRole)}>
          {roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}
        </SelectField>
        <SelectField label="Sensitivity" value={draft.sensitivity} onChange={(event) => update('sensitivity', event.target.value as Sensitivity)}>
          {sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
        </SelectField>
        <SelectField label="Accessibility need" value={draft.accessibilityNeed} onChange={(event) => update('accessibilityNeed', event.target.value as ArtifactDraft['accessibilityNeed'])}>
          <option value="none">None noted</option>
          <option value="seating">Seated interpretation</option>
          <option value="audio">Audio interpretation</option>
          <option value="tactile-alternative">Tactile alternative</option>
        </SelectField>
        <SelectField label="Trial placement" value={targetZoneId} onChange={(event) => setTargetZoneId(event.target.value)} hint="Leave unplaced to keep it in the object queue.">
          <option value="">Leave unplaced</option>
          {orderedZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.shortLabel}</option>)}
        </SelectField>
        <TextField label="Object summary" textarea rows={4} value={draft.summary} onChange={(event) => update('summary', event.target.value)} error={errors.summary} hint="At least 24 characters." />
        <label className="check-field"><input type="checkbox" checked={draft.isKeyObject} onChange={(event) => update('isKeyObject', event.target.checked)} /><span><strong>Key object</strong><small>Must be placed before readiness can pass.</small></span></label>
      </div>
    </Modal>
  );
}
