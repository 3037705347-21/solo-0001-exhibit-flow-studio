import { ArrowLeft, CalendarDays, Check, DoorOpen, Save, Settings2, SunMedium, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { SectionHeader } from '../../components/SectionHeader';
import { TextField } from '../../components/TextField';
import { formatDate } from '../../domain/formatters';
import { daysUntil } from '../../domain/dateMath';
import type { ProjectSettingsDraft } from '../../domain/models';
import { projectToSettingsDraft, validateProjectSettings } from '../../domain/projectSettings';
import { useWorkspace } from '../../state/WorkspaceContext';

const KNOWN_ROUTES = new Set(['/collection', '/journey', '/review', '/insights']);

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="settings-detail-row"><span className="settings-detail-icon">{icon}</span><span className="settings-detail-copy"><small>{label}</small><strong>{value}</strong></span></div>;
}

export function SettingsPage() {
  const { state, updateProjectSettings } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  // Re-seed the form when the saved project is replaced out from under it
  // (e.g. "Reset sample plan" in the sidebar). In-progress edits are preserved.
  const savedDraft = projectToSettingsDraft(state.project);
  const [draft, setDraft] = useState<ProjectSettingsDraft>(savedDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const lastSavedRef = useRef<ProjectSettingsDraft>(savedDraft);
  useEffect(() => {
    if (JSON.stringify(savedDraft) === JSON.stringify(lastSavedRef.current)) return;
    lastSavedRef.current = savedDraft;
    if (dirtyRef.current) return;
    setDraft(savedDraft);
    setErrors({});
    setFeedback(null);
  }, [savedDraft]);

  const returnTo = useMemo(() => {
    const target = (location.state as { from?: string } | null)?.from;
    return target && KNOWN_ROUTES.has(target) ? target : '/collection';
  }, [location.state]);

  const update = <K extends keyof ProjectSettingsDraft>(key: K, value: ProjectSettingsDraft[K]) => {
    dirtyRef.current = true;
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const save = () => {
    const validation = validateProjectSettings(draft);
    if (validation.length) {
      setErrors(Object.fromEntries(validation.map((error) => [error.field, error.message])));
      setFeedback(null);
      return;
    }
    const result = updateProjectSettings(draft);
    if (!result.ok) {
      setErrors(result.errors ?? {});
      return;
    }
    dirtyRef.current = false;
    lastSavedRef.current = draft;
    setErrors({});
    setFeedback('Exhibition settings saved.');
    window.setTimeout(() => setFeedback(null), 2600);
  };

  const cancel = () => navigate(returnTo);

  const project = state.project;
  const openingLabel = project.openingDate
    ? `${formatDate(`${project.openingDate}T00:00:00`)} · ${daysUntilLabel(project.openingDate)}`
    : 'Not scheduled yet';

  return <div className="page-stack">
    <SectionHeader eyebrow="WORKSPACE" title="Project settings" description="These details identify the exhibition across the sidebar, checklists, and exported snapshots." actions={<Button variant="secondary" icon={<ArrowLeft size={16} />} onClick={cancel}>Back to {returnTo === '/collection' ? 'Collection' : pageLabel(returnTo)}</Button>} />
    <div className="settings-layout">
      <section className="settings-panel" aria-label="Edit exhibition details">
        <div className="panel-heading"><div><div className="eyebrow">EXHIBITION DETAILS</div><h2>Project profile</h2></div><Settings2 size={19} /></div>
        <form className="settings-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <TextField label="Exhibition title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="Afterlight: Material Memory" maxLength={120} />
          <TextField label="Venue" value={draft.venue} onChange={(event) => update('venue', event.target.value)} error={errors.venue} placeholder="Building, gallery, or room" maxLength={160} />
          <TextField label="Target audience" value={draft.audience} onChange={(event) => update('audience', event.target.value)} error={errors.audience} placeholder="Who is this exhibition designed for?" maxLength={200} />
          <TextField label="Opening date" value={draft.openingDate} onChange={(event) => update('openingDate', event.target.value)} error={errors.openingDate} placeholder="YYYY-MM-DD" hint="Leave empty if the opening date is not scheduled yet." inputMode="numeric" autoComplete="off" />
          <div className="settings-actions"><Button variant="ghost" type="button" onClick={cancel}>Cancel</Button><Button variant="primary" icon={<Save size={16} />} type="submit">Save settings</Button></div>
        </form>
      </section>
      <aside className="settings-aside">
        <section className="settings-panel settings-overview" aria-label="Saved project overview">
          <div className="panel-heading"><div><div className="eyebrow">SAVED PROFILE</div><h2>{project.title || 'Untitled exhibition'}</h2></div></div>
          <div className="settings-detail-list">
            <DetailRow icon={<SunMedium size={16} />} label="Venue" value={project.venue || 'No venue set'} />
            <DetailRow icon={<Users size={16} />} label="Target audience" value={project.audience || 'No audience defined'} />
            <DetailRow icon={<CalendarDays size={16} />} label="Opening" value={openingLabel} />
            <DetailRow icon={<DoorOpen size={16} />} label="Readiness stage" value={project.stage === 'ready' ? 'Ready to share' : project.stage === 'review' ? 'In review' : 'Draft'} />
          </div>
        </section>
        <p className="settings-note">Settings are stored with this browser workspace. Objects, zones, findings, and planning preferences are not changed here.</p>
      </aside>
    </div>
    {feedback && <div className="toast toast-positive" role="status"><Check size={16} />{feedback}</div>}
  </div>;
}

function daysUntilLabel(isoDate: string): string {
  const days = daysUntil(isoDate);
  if (days === 0) return 'opens today';
  if (days < 0) return `opened ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  return `${days} day${days === 1 ? '' : 's'} to opening`;
}

function pageLabel(route: string): string {
  if (route === '/journey') return 'Visitor journey';
  if (route === '/review') return 'Review desk';
  return 'Insights';
}
