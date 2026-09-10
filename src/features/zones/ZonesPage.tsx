import { AlertTriangle, Armchair, ArrowDown, ArrowUp, Layers, Lightbulb, MapPin, Minus, Plus, Trash2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { SectionHeader } from '../../components/SectionHeader';
import { TextField } from '../../components/TextField';
import { sortZones } from '../../domain/filters';
import { analyzeJourney } from '../../domain/journeyAnalysis';
import { titleCase } from '../../domain/formatters';
import { planZoneDelete, type ZoneDeleteImpact } from '../../domain/zoneRemoval';
import { emptyZoneDraft, zoneToDraft, ZONE_COLOR_OPTIONS } from '../../domain/zoneValidation';
import type { Zone, ZoneDraft } from '../../domain/models';
import { useWorkspace } from '../../state/WorkspaceContext';

export function ZonesPage() {
  const { state, upsertZone, removeZone, reorderZone } = useWorkspace();
  const [editor, setEditor] = useState<{ draft: ZoneDraft; existing?: Zone } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Zone | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const zones = useMemo(() => sortZones(state.zones), [state.zones]);
  const analysis = useMemo(() => analyzeJourney(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const issueCountByZone = useMemo(() => {
    const counts = new Map<string, number>();
    state.issues.forEach((issue) => {
      if (issue.status === 'resolved' || !issue.zoneId) return;
      counts.set(issue.zoneId, (counts.get(issue.zoneId) ?? 0) + 1);
    });
    return counts;
  }, [state.issues]);

  const notify = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 2800);
  };

  const handleSave = (draft: ZoneDraft, existing?: Zone) => {
    const result = upsertZone(draft, existing);
    if (!result.ok) return result;
    setEditor(null);
    notify(existing ? 'Zone configuration updated.' : 'Zone added to the visitor journey.');
    return result;
  };

  const handleDelete = (zoneId: string) => {
    const result = removeZone(zoneId);
    if (!result.ok) { notify(result.message ?? 'Zone could not be removed.'); return; }
    setDeleteTarget(null);
    notify('Zone removed. Its objects returned to the unplaced queue.');
  };

  return <div className="page-stack">
    <SectionHeader eyebrow="FLOOR CONFIGURATION" title="Exhibition zones" description="Define the rooms your team moves between. New zones take part in placement checks and review filtering right away." actions={<Button variant="primary" icon={<Plus size={17} />} onClick={() => setEditor({ draft: emptyZoneDraft })}>New zone</Button>} />
    <div className="summary-strip"><div><span className="eyebrow">ZONES</span><strong>{state.zones.length}<small> in sequence</small></strong></div><div><span className="eyebrow">LOW-LIGHT</span><strong>{state.zones.filter((zone) => zone.lowLight).length}<small> configured</small></strong></div><div><span className="eyebrow">WITH SEATING</span><strong>{state.zones.filter((zone) => zone.hasSeating).length}<small> configured</small></strong></div><div><span className="eyebrow">OPEN FINDINGS</span><strong>{state.issues.filter((issue) => issue.status !== 'resolved' && issue.zoneId).length}<small> zone-linked</small></strong></div></div>
    {zones.length === 0
      ? <EmptyState icon={<Layers size={24} />} title="No zones configured" detail="Create a zone before placing objects in the visitor journey." />
      : <div className="zone-admin-list">{zones.map((zone, index) => {
        const zoneAnalysis = analysis.zones.find((item) => item.zoneId === zone.id);
        const overObjects = (zoneAnalysis?.objectCount ?? 0) > zone.maxObjects;
        const overCapacity = (zoneAnalysis?.utilization ?? 0) > 1;
        const unresolved = issueCountByZone.get(zone.id) ?? 0;
        return <article className="zone-admin-card" key={zone.id}>
          <div className="zone-admin-sequence" style={{ backgroundColor: zone.color }}><span>{String(index + 1).padStart(2, '0')}</span></div>
          <div className="zone-admin-main">
            <div className="zone-admin-head">
              <div><h3>{zone.name}</h3>{zone.shortLabel && <div className="zone-admin-label">{zone.shortLabel}</div>}</div>
              <div className="zone-admin-badges">
                {overObjects && <Badge tone="danger">Over object limit</Badge>}
                {overCapacity && <Badge tone="danger">Over dwell capacity</Badge>}
                {unresolved > 0 && <Badge tone="warning">{unresolved} open finding{unresolved === 1 ? '' : 's'}</Badge>}
              </div>
            </div>
            {zone.thesis && <p className="zone-admin-thesis">{zone.thesis}</p>}
            <div className="zone-admin-meta">
              <span><Minus size={12} /> {zoneAnalysis?.objectCount ?? 0}/{zone.maxObjects} objects</span>
              <span>{zoneAnalysis?.dwellMinutes ?? 0}/{zone.capacityMinutes} min dwell</span>
              <span>{zone.lowLight ? <><Lightbulb size={12} /> Low-light</> : 'Standard light'}</span>
              <span>{zone.hasSeating ? <><Armchair size={12} /> Seating</> : 'Standing only'}</span>
            </div>
          </div>
          <div className="zone-admin-actions">
            <Button variant="ghost" icon={<ArrowUp size={15} />} aria-label={`Move ${zone.name} earlier`} disabled={index === 0} onClick={() => reorderZone(zone.id, -1)} />
            <Button variant="ghost" icon={<ArrowDown size={15} />} aria-label={`Move ${zone.name} later`} disabled={index === zones.length - 1} onClick={() => reorderZone(zone.id, 1)} />
            <Button variant="secondary" onClick={() => setEditor({ draft: zoneToDraft(zone), existing: zone })}>Edit</Button>
            <Button variant="ghost" icon={<Trash2 size={15} />} aria-label={`Delete ${zone.name}`} onClick={() => setDeleteTarget(zone)} />
          </div>
        </article>;
      })}</div>}
    {(overLimitNotice(analysis))}
    {editor && <ZoneEditor initial={editor.draft} existing={editor.existing} zones={state.zones} onClose={() => setEditor(null)} onSave={handleSave} />}
    {deleteTarget && <ZoneDeleteDialog zone={deleteTarget} impact={planZoneDelete(state, deleteTarget.id)} onClose={() => setDeleteTarget(null)} onConfirm={handleDelete} />}
    {feedback && <div className="toast toast-positive" role="status">{feedback}</div>}
  </div>;
}

function overLimitNotice(analysis: ReturnType<typeof analyzeJourney>) {
  const over = analysis.zones.filter((zone) => zone.findings.some((finding) => finding.type === 'error' && (finding.id.startsWith('density-') || finding.id.startsWith('capacity-'))));
  if (!over.length) return null;
  return <div className="zone-admin-warning" role="alert"><AlertTriangle size={16} /><span><strong>{over.length} zone{over.length === 1 ? '' : 's'} outside configured limits.</strong> Existing placements are kept, but the visitor journey now reports blocking constraints. Adjust limits or move objects on the journey board.</span></div>;
}

function ZoneEditor({ initial, existing, zones, onClose, onSave }: { initial: ZoneDraft; existing?: Zone; zones: Zone[]; onClose: () => void; onSave: (draft: ZoneDraft, existing?: Zone) => { ok: boolean; errors?: Record<string, string> } }) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = <K extends keyof ZoneDraft>(key: K, value: ZoneDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const currentObjects = existing ? zones.find((zone) => zone.id === existing.id)?.artifactIds.length ?? 0 : 0;
  const capacityWarning = Number(draft.maxObjects) > 0 && currentObjects > Number(draft.maxObjects);
  const submit = () => { const result = onSave(draft, existing); if (!result.ok) setErrors(result.errors ?? {}); };
  return <Modal eyebrow={existing ? 'EDIT ZONE' : 'NEW ZONE'} title={existing ? 'Edit exhibition zone' : 'Add exhibition zone'} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>{existing ? 'Save changes' : 'Create zone'}</Button></>}>
    <div className="form-grid">
      <TextField label="Zone name" value={draft.name} onChange={(event) => update('name', event.target.value)} error={errors.name} placeholder="e.g. Threshold Gallery" />
      <TextField label="Short label" value={draft.shortLabel} onChange={(event) => update('shortLabel', event.target.value)} error={errors.shortLabel} hint="Used on badges and checklists, up to 24 characters." placeholder="e.g. Threshold" />
      <TextField label="Theme" textarea rows={3} value={draft.thesis} onChange={(event) => update('thesis', event.target.value)} error={errors.thesis} hint="What story should this room carry?" />
      <div className="field zone-color-field"><span className="field-label">Color</span><div className="zone-color-options">{ZONE_COLOR_OPTIONS.map((color) => <button key={color} type="button" aria-label={`Use color ${color}`} className={draft.color === color ? 'selected' : ''} style={{ backgroundColor: color }} onClick={() => update('color', color)}>{draft.color === color ? '✓' : ''}</button>)}</div>{errors.color && <span className="field-error">{errors.color}</span>}</div>
      <TextField label="Dwell capacity (minutes)" type="number" min={1} max={1000} step={1} value={draft.capacityMinutes} onChange={(event) => update('capacityMinutes', event.target.value)} error={errors.capacityMinutes} hint="Warnings start at 80%; above 100% blocks readiness." />
      <TextField label="Maximum object count" type="number" min={1} max={1000} step={1} value={draft.maxObjects} onChange={(event) => update('maxObjects', event.target.value)} error={errors.maxObjects} hint={capacityWarning ? `Currently holds ${currentObjects} objects — saving creates an over-limit constraint.` : undefined} />
      <label className="check-field"><input type="checkbox" checked={draft.lowLight} onChange={(event) => update('lowLight', event.target.checked)} /><span><strong>Low-light zone</strong><small>Required for light-sensitive objects.</small></span></label>
      <label className="check-field"><input type="checkbox" checked={draft.hasSeating} onChange={(event) => update('hasSeating', event.target.checked)} /><span><strong>Seating available</strong><small>Satisfies seated-interpretation needs.</small></span></label>
    </div>
  </Modal>;
}

function ZoneDeleteDialog({ zone, impact, onClose, onConfirm }: { zone: Zone; impact: ZoneDeleteImpact | null; onClose: () => void; onConfirm: (zoneId: string) => void }) {
  const findingCount = impact ? impact.zoneFindings.length + impact.objectFindings.length : 0;
  return <Modal eyebrow="DELETE ZONE" title={`Delete “${zone.name}”`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Keep zone</Button><Button variant="danger" icon={<Trash2 size={15} />} onClick={() => onConfirm(zone.id)}>Delete zone</Button></>}>
    <div className="zone-delete-body">
      <p className="zone-delete-intro">This changes the visitor journey. Review the impact before confirming.</p>
      {impact && impact.objects.length > 0 && <section className="zone-delete-section"><div className="eyebrow">{impact.objects.length} OBJECT{impact.objects.length === 1 ? '' : 'S'} RETURN TO THE UNPLACED QUEUE</div><ul className="zone-delete-list">{impact.objects.map((artifact) => <li key={artifact.id}><MapPin size={13} /> <strong>{artifact.title}</strong><small>{artifact.accessionId} · {titleCase(artifact.narrativeRole)}</small></li>)}</ul></section>}
      {impact && impact.zoneFindings.length > 0 && <section className="zone-delete-section"><div className="eyebrow">{impact.zoneFindings.length} ZONE-LEVEL FINDING{impact.zoneFindings.length === 1 ? '' : 'S'} KEPT, DETACHED FROM THE ZONE</div><ul className="zone-delete-list">{impact.zoneFindings.map((issue) => <li key={issue.id}><XCircle size={13} className={issue.severity === 'critical' ? 'text-danger' : issue.severity === 'warning' ? 'text-amber' : ''} /><span><strong>{issue.title}</strong><small>{titleCase(issue.severity)} · {titleCase(issue.status)} · {issue.owner} — marked “{zone.name} (zone removed)”</small></span></li>)}</ul></section>}
      {impact && impact.objectFindings.length > 0 && <section className="zone-delete-section"><div className="eyebrow">{impact.objectFindings.length} OBJECT FINDING{impact.objectFindings.length === 1 ? '' : 'S'} STAY WITH THEIR OBJECTS</div><ul className="zone-delete-list">{impact.objectFindings.map((issue) => <li key={issue.id}><AlertTriangle size={13} /><span><strong>{issue.title}</strong><small>{titleCase(issue.severity)} · {titleCase(issue.status)} · {issue.owner}</small></span></li>)}</ul></section>}
      {(!impact || (impact.objects.length === 0 && findingCount === 0)) && <p className="zone-delete-empty">This zone is empty. It will be removed from the journey sequence with no other changes.</p>}
    </div>
  </Modal>;
}
