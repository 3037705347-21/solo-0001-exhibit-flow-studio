import { BookOpen, Boxes, CalendarDays, ChevronRight, CircleHelp, Compass, Gauge, LayoutDashboard, RotateCcw, Settings2, Sparkles, SunMedium, Users } from 'lucide-react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { formatDate } from '../domain/formatters';
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
  const { state, storageHealthy, resetWorkspace } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const onSettings = location.pathname === '/settings';
  const active = navigation.find((item) => location.pathname.startsWith(item.to)) ?? (onSettings
    ? { to: '/settings', label: 'Project settings' }
    : navigation[0]);
  const project = state.project;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={17} /></div><div><div className="brand-name">ExhibitFlow</div><div className="brand-sub">Studio workspace</div></div></div>
      <div className="sidebar-project"><div className="eyebrow">ACTIVE EXHIBITION</div><div className="project-name">{project.title || 'Untitled exhibition'}</div><div className="project-meta"><span className="project-venue"><SunMedium size={14} /> {project.venue || 'No venue set'}</span><span><Users size={14} /> {project.audience || 'No audience defined'}</span><span><CalendarDays size={14} /> {project.openingDate ? formatDate(`${project.openingDate}T00:00:00`) : 'Opening not scheduled'}</span></div></div>
      <nav className="main-nav" aria-label="Main navigation">{navigation.map(({ to, label, icon: Icon, detail }) => <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icon size={18} /><span><strong>{label}</strong><small>{detail}</small></span>{location.pathname.startsWith(to) && <ChevronRight size={15} className="nav-chevron" />}</NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><CircleHelp size={16} /><span><strong>Planning tip</strong><small>Keep each zone's thesis visible while you place objects.</small></span></div><div className="storage-status"><span className={`status-dot ${storageHealthy ? 'online' : 'offline'}`} />{storageHealthy ? 'Saved locally' : 'Local save unavailable'}</div><Button variant="ghost" icon={<RotateCcw size={15} />} onClick={() => { if (window.confirm('Reset this workspace to the sample exhibition?')) resetWorkspace(); }}>Reset sample plan</Button></div>
    </aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb"><LayoutDashboard size={15} /><span>ExhibitFlow</span><ChevronRight size={14} /><strong>{active.label}</strong></div><div className="topbar-actions"><Badge tone={state.project.stage === 'ready' ? 'positive' : 'warning'}>{state.project.stage === 'ready' ? 'Ready to share' : 'In review'}</Badge><Button variant="ghost" icon={<Settings2 size={17} />} aria-label="Open settings" aria-current={onSettings ? 'page' : undefined} onClick={() => { if (!onSettings) navigate('/settings', { state: { from: location.pathname } }); }} /></div></header><div className="page-content">{children}</div><footer className="app-footer"><span>ExhibitFlow Studio · offline workspace</span><span>Changes save automatically</span></footer></main>
  </div>;
}
