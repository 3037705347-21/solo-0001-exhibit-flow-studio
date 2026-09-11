import { BookOpen, Boxes, ChevronRight, CircleHelp, Compass, Gauge, LayoutDashboard, RotateCcw, Settings2, Sparkles, SunMedium, X } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
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
  const { state, storageHealthy, resetWorkspace, recoveryReport, dismissRecoveryReport } = useWorkspace();
  const location = useLocation();
  const active = navigation.find((item) => location.pathname.startsWith(item.to)) ?? navigation[0];
  const recoveryTone = recoveryReport?.kind === 'breakpoint' ? 'danger' : 'warning';
  const recoveryTitle = recoveryReport?.kind === 'breakpoint'
    ? `Recovery stopped at command #${recoveryReport.breakpoint?.seq ?? '?'}`
    : 'Workspace recovered after an interrupted save';
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={17} /></div><div><div className="brand-name">ExhibitFlow</div><div className="brand-sub">Studio workspace</div></div></div>
      <div className="sidebar-project"><div className="eyebrow">ACTIVE EXHIBITION</div><div className="project-name">{state.project.title}</div><div className="project-venue"><SunMedium size={14} /> {state.project.venue}</div></div>
      <nav className="main-nav" aria-label="Main navigation">{navigation.map(({ to, label, icon: Icon, detail }) => <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icon size={18} /><span><strong>{label}</strong><small>{detail}</small></span>{location.pathname.startsWith(to) && <ChevronRight size={15} className="nav-chevron" />}</NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><CircleHelp size={16} /><span><strong>Planning tip</strong><small>Keep each zone's thesis visible while you place objects.</small></span></div><div className="storage-status"><span className={`status-dot ${storageHealthy ? 'online' : 'offline'}`} />{storageHealthy ? 'Saved locally' : 'Local save unavailable'}</div><Button variant="ghost" icon={<RotateCcw size={15} />} onClick={() => { if (window.confirm('Reset this workspace to the sample exhibition?')) resetWorkspace(); }}>Reset sample plan</Button></div>
    </aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb"><LayoutDashboard size={15} /><span>ExhibitFlow</span><ChevronRight size={14} /><strong>{active.label}</strong></div><div className="topbar-actions"><Badge tone={state.project.stage === 'ready' ? 'positive' : 'warning'}>{state.project.stage === 'ready' ? 'Ready to share' : 'In review'}</Badge><Button variant="ghost" icon={<Settings2 size={17} />} aria-label="Open settings" /></div></header>{recoveryReport && <div className={`recovery-banner recovery-${recoveryTone}`} role="status"><div className="recovery-banner-body"><strong>{recoveryTitle}</strong><p>{recoveryReport.detail}</p><ul className="recovery-banner-meta">
      <li>{recoveryReport.replayed} command{recoveryReport.replayed === 1 ? '' : 's'} replayed</li>
      {recoveryReport.duplicates.length > 0 && <li>{recoveryReport.duplicates.length} duplicate command{recoveryReport.duplicates.length === 1 ? '' : 's'} applied once</li>}
      {recoveryReport.commandsAfterBreakpoint > 0 && <li>{recoveryReport.commandsAfterBreakpoint} later command{recoveryReport.commandsAfterBreakpoint === 1 ? '' : 's'} held back</li>}
    </ul></div><button type="button" className="recovery-dismiss" aria-label="Dismiss recovery notice" onClick={dismissRecoveryReport}><X size={16} /></button></div>}<div className="page-content">{children}</div><footer className="app-footer"><span>ExhibitFlow Studio · offline workspace</span><span>Changes save automatically</span></footer></main>
  </div>;
}
