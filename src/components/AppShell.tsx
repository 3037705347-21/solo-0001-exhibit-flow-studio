import { BookOpen, Boxes, ChevronRight, CircleHelp, Compass, Download, Gauge, History, LayoutDashboard, RotateCcw, Settings2, Sparkles, SunMedium, Upload } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { downloadTextFile, workspaceFileName } from '../domain/export';
import { useWorkspace } from '../state/WorkspaceContext';
import { Badge } from './Badge';
import { Button } from './Button';
import { Callout } from './Callout';
import { WorkspaceTransferModal } from './WorkspaceTransferModal';

const navigation = [
  { to: '/collection', label: 'Collection', icon: Boxes, detail: 'Objects & metadata' },
  { to: '/journey', label: 'Visitor journey', icon: Compass, detail: 'Zones & sequence' },
  { to: '/review', label: 'Review desk', icon: BookOpen, detail: 'Findings & readiness' },
  { to: '/insights', label: 'Insights', icon: Gauge, detail: 'Scenario planning' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, storageHealthy, resetWorkspace, exportWorkspace, startupNotice, dismissStartupNotice } = useWorkspace();
  const [showTransfer, setShowTransfer] = useState(false);
  const location = useLocation();
  const active = navigation.find((item) => location.pathname.startsWith(item.to)) ?? navigation[0];

  const downloadWorkspace = () => {
    const result = exportWorkspace();
    if (result.ok && result.value) downloadTextFile(result.value, workspaceFileName());
    else window.alert(result.message ?? 'The workspace could not be exported.');
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={17} /></div><div><div className="brand-name">ExhibitFlow</div><div className="brand-sub">Studio workspace</div></div></div>
      <div className="sidebar-project"><div className="eyebrow">ACTIVE EXHIBITION</div><div className="project-name">{state.project.title}</div><div className="project-venue"><SunMedium size={14} /> {state.project.venue}</div></div>
      <nav className="main-nav" aria-label="Main navigation">{navigation.map(({ to, label, icon: Icon, detail }) => <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icon size={18} /><span><strong>{label}</strong><small>{detail}</small></span>{location.pathname.startsWith(to) && <ChevronRight size={15} className="nav-chevron" />}</NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><CircleHelp size={16} /><span><strong>Planning tip</strong><small>Keep each zone's thesis visible while you place objects.</small></span></div><div className="storage-status"><span className={`status-dot ${storageHealthy ? 'online' : 'offline'}`} />{storageHealthy ? 'Saved locally' : 'Local save unavailable'}</div><Button variant="ghost" icon={<RotateCcw size={15} />} onClick={() => { if (window.confirm('Reset this workspace to the sample exhibition?')) resetWorkspace(); }}>Reset sample plan</Button></div>
    </aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb"><LayoutDashboard size={15} /><span>ExhibitFlow</span><ChevronRight size={14} /><strong>{active.label}</strong></div><div className="topbar-actions"><Badge tone={state.project.stage === 'ready' ? 'positive' : 'warning'}>{state.project.stage === 'ready' ? 'Ready to share' : 'In review'}</Badge><Button variant="secondary" icon={<Download size={16} />} onClick={downloadWorkspace} data-testid="export-workspace-button">Export workspace</Button><Button variant="secondary" icon={<Upload size={16} />} onClick={() => setShowTransfer(true)} data-testid="import-workspace-button">Import & restore</Button><Button variant="ghost" icon={<Settings2 size={17} />} aria-label="Open settings" /></div></header><div className="page-content">{startupNotice && <Callout tone="warning" title="Workspace recovery" actions={<Button variant="ghost" onClick={dismissStartupNotice}>Dismiss</Button>}><span className="startup-notice"><History size={14} /> {startupNotice}</span></Callout>}{children}</div><footer className="app-footer"><span>ExhibitFlow Studio · offline workspace</span><span>Changes save automatically</span></footer></main>
    {showTransfer && <WorkspaceTransferModal onClose={() => setShowTransfer(false)} />}
  </div>;
}
