import { BookOpen, Boxes, ChevronRight, CircleHelp, Compass, Gauge, History, LayoutDashboard, RotateCcw, Settings2, Sparkles, SunMedium, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { BackupCenter } from './BackupCenter';
import { useWorkspace } from '../state/WorkspaceContext';
import { Badge } from './Badge';
import { Button } from './Button';

const navigation = [
  { to: '/collection', label: 'Collection', icon: Boxes, detail: 'Objects & metadata' },
  { to: '/journey', label: 'Visitor journey', icon: Compass, detail: 'Zones & sequence' },
  { to: '/review', label: 'Review desk', icon: BookOpen, detail: 'Findings & readiness' },
  { to: '/insights', label: 'Insights', icon: Gauge, detail: 'Scenario planning' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, storageHealthy, resetWorkspace, lastRecovery, undoLastRecovery } = useWorkspace();
  const location = useLocation();
  const [backupOpen, setBackupOpen] = useState(false);
  const active = navigation.find((item) => location.pathname.startsWith(item.to)) ?? navigation[0];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={17} /></div><div><div className="brand-name">ExhibitFlow</div><div className="brand-sub">Studio workspace</div></div></div>
      <div className="sidebar-project"><div className="eyebrow">ACTIVE EXHIBITION</div><div className="project-name">{state.project.title}</div><div className="project-venue"><SunMedium size={14} /> {state.project.venue}</div>{state.project.planCode && <div className="project-plancode">Plan {state.project.planCode} · schema v{state.version}</div>}{state.restoredFrom && <div className="project-restored"><History size={13} /> Restored from v{state.restoredFrom.sourceVersion}{state.restoredFrom.sourceFileName ? ` · ${state.restoredFrom.sourceFileName}` : ''}</div>}</div>
      <nav className="main-nav" aria-label="Main navigation">{navigation.map(({ to, label, icon: Icon, detail }) => <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icon size={18} /><span><strong>{label}</strong><small>{detail}</small></span>{location.pathname.startsWith(to) && <ChevronRight size={15} className="nav-chevron" />}</NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><CircleHelp size={16} /><span><strong>Planning tip</strong><small>Keep each zone's thesis visible while you place objects.</small></span></div><div className="storage-status"><span className={`status-dot ${storageHealthy ? 'online' : 'offline'}`} />{storageHealthy ? 'Saved locally' : 'Local save unavailable'}</div>{lastRecovery && <Button variant="ghost" icon={<Undo2 size={15} />} onClick={() => { const result = undoLastRecovery(); if (!result.ok) window.alert(result.message ?? 'Undo failed.'); }}>Undo last recovery</Button>}<Button variant="ghost" icon={<Settings2 size={15} />} onClick={() => setBackupOpen(true)}>Backup &amp; restore</Button><Button variant="ghost" icon={<RotateCcw size={15} />} onClick={() => { if (window.confirm('Reset this workspace to the sample exhibition?')) resetWorkspace(); }}>Reset sample plan</Button></div>
    </aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb"><LayoutDashboard size={15} /><span>ExhibitFlow</span><ChevronRight size={14} /><strong>{active.label}</strong></div><div className="topbar-actions">{state.restoredFrom && <Badge tone="info">Recovered from v{state.restoredFrom.sourceVersion}</Badge>}<Badge tone={state.project.stage === 'ready' ? 'positive' : 'warning'}>{state.project.stage === 'ready' ? 'Ready to share' : 'In review'}</Badge><Button variant="ghost" icon={<Settings2 size={17} />} aria-label="Open backup and recovery" onClick={() => setBackupOpen(true)} /></div></header><div className="page-content">{children}</div><footer className="app-footer"><span>ExhibitFlow Studio · offline workspace</span><span>Changes save automatically</span></footer></main>
    {backupOpen && <BackupCenter open={backupOpen} onClose={() => setBackupOpen(false)} />}
  </div>;
}
