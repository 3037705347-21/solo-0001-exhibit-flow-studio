import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Compass,
  Gauge,
  Info,
  Layers3,
  MapPin,
  PackageOpen,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { formatDate, pluralize, titleCase } from '../../domain/formatters';
import type { CommandRisk, CommandRiskLevel, LastCheckStatus } from '../../domain/commandCenter';
import { useWorkspace } from '../../state/WorkspaceContext';
import { selectCommandCenter } from '../../state/selectors';

const RISK_ICON = { critical: XCircle, warning: AlertTriangle, info: Info } as const;
const RISK_TONE = { critical: 'danger', warning: 'warning', info: 'info' } as const;
const AREA_LABEL = { collection: 'Collection', journey: 'Journey', review: 'Review', insights: 'Insights' } as const;
const AREA_ICON = { collection: Boxes, journey: Compass, review: ClipboardCheck, insights: Gauge } as const;
const SCORE_TONE = (score: number): 'teal' | 'amber' | 'red' => (score >= 80 ? 'teal' : score >= 55 ? 'amber' : 'red');

const STAGE_BADGE: Record<string, { tone: 'neutral' | 'warning' | 'positive'; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  review: { tone: 'warning', label: 'In review' },
  ready: { tone: 'positive', label: 'Ready to share' },
};

const LAST_CHECK_COPY: Record<LastCheckStatus, { label: string; tone: 'neutral' | 'positive' | 'warning' | 'danger' | 'info' }> = {
  none: { label: 'No formal check recorded', tone: 'neutral' },
  passed: { label: 'Passed — plan confirmed ready', tone: 'positive' },
  'needs-refresh': { label: 'Passed before recent changes — re-run the gate', tone: 'warning' },
  blocked: { label: 'Did not pass — blockers remain', tone: 'danger' },
};

export function CommandCenterPage() {
  const { state } = useWorkspace();
  const command = useMemo(() => selectCommandCenter(state), [state]);
  const stage = STAGE_BADGE[command.stage] ?? STAGE_BADGE.draft;
  const countdownTone = command.daysToOpening === null || command.daysToOpening < 0
    ? 'default'
    : command.daysToOpening <= 30 ? 'red' : command.daysToOpening <= 90 ? 'amber' : 'teal';

  return <div className="page-stack">
    <SectionHeader
      eyebrow="PROJECT COMMAND CENTER"
      title={command.project.title}
      description="One project-level view of what remains before opening. Every figure is recomputed from the same planning data used on the other pages."
      actions={<Badge tone={stage.tone}>{stage.label}</Badge>}
    />

    {command.empty && <EmptyWorkspaceBanner />}

    <section className="command-hero">
      <div className="command-identity">
        <div className="command-identity-row"><MapPin size={15} /><strong>{command.project.venue || 'Venue not set'}</strong></div>
        <div className="command-identity-row"><CalendarClock size={15} /><span>{command.openingDate ? formatDate(command.openingDate) : 'Opening date not set'}</span></div>
        <div className="command-identity-row"><Sparkles size={15} /><span>{command.project.audience || 'Audience not defined'}</span></div>
      </div>
      <div className={`command-countdown command-tone-${countdownTone}`}>
        <span className="eyebrow">OPENING COUNTDOWN</span>
        <strong>{command.daysToOpening === null ? '—' : command.daysToOpening < 0 ? 'Past' : command.daysToOpening}</strong>
        <small>{command.countdownLabel}</small>
      </div>
      <div className={`command-score command-tone-${command.empty ? 'default' : SCORE_TONE(command.readiness.score)}`}>
        <span className="eyebrow">LIVE READINESS SCORE</span>
        <strong data-testid="command-score">{command.empty ? '—' : command.readiness.score}</strong>
        <small>{command.empty ? 'No collection yet' : command.readiness.ready ? 'Clears the readiness gate today' : 'Recomputed from the current plan'}</small>
      </div>
    </section>

    <div className="metric-grid four" data-testid="command-metrics">
      <Metric label="Objects placed" value={command.empty ? '—' : `${command.coverage.placedCount}/${command.coverage.totalArtifacts}`} detail={command.empty ? 'No objects yet' : command.analysis.unplacedCount === 0 ? 'All objects placed' : pluralize(command.analysis.unplacedCount, 'object') + ' unplaced'} icon={<Layers3 size={17} />} tone={command.empty ? 'default' : command.coverage.placementRatio === 1 ? 'teal' : 'amber'} />
      <Metric label="Key objects" value={command.empty ? '—' : `${command.coverage.keyPlaced}/${command.coverage.keyTotal}`} detail={command.empty ? 'No key objects yet' : 'Required objects placed'} icon={<ShieldCheck size={17} />} tone={command.empty ? 'default' : command.coverage.keyRatio === 1 ? 'teal' : 'red'} />
      <Metric label="Story roles" value={command.empty ? '—' : `${command.coverage.rolesCovered.length}/4`} detail={command.empty ? 'No story arc yet' : command.coverage.missingRoles.length ? command.coverage.missingRoles.map(titleCase).join(', ') : 'Arc complete'} icon={<Sparkles size={17} />} tone={command.empty ? 'default' : command.coverage.roleRatio === 1 ? 'teal' : 'amber'} />
      <Metric label="Open findings" value={command.empty ? '0' : String(command.unresolvedIssues.length)} detail={command.empty ? 'No findings yet' : `${command.criticalIssues.length} critical`} icon={<ShieldAlert size={17} />} tone={command.criticalIssues.length ? 'red' : command.unresolvedIssues.length ? 'amber' : 'teal'} />
    </div>

    <div className="command-layout">
      <section className="panel command-panel" aria-labelledby="risk-register-heading">
        <div className="panel-heading">
          <div><div className="eyebrow">WHAT IS BETWEEN US AND READY</div><h2 id="risk-register-heading">Risk register</h2></div>
          <span data-testid="risk-count"><Badge tone={command.risks.some((risk) => risk.level === 'critical') ? 'danger' : command.risks.length ? 'warning' : 'positive'}>{command.risks.length ? `${command.risks.length} open` : 'All clear'}</Badge></span>
        </div>
        {command.risks.length === 0
          ? <div className="command-all-clear"><CheckCircle2 size={20} /><div><strong>No open risks</strong><p>The collection is placed, findings are resolved, capacity holds, and the formal gate is current.</p></div></div>
          : <div className="risk-register">{command.risks.map((risk, index) => <RiskCard key={risk.id} risk={risk} rank={index + 1} />)}</div>}
      </section>

      <aside className="command-side">
        <section className="panel command-panel" aria-labelledby="capacity-heading">
          <div className="panel-heading"><div><div className="eyebrow">EXHIBITION FLOOR</div><h2 id="capacity-heading">Zone capacity</h2></div><Compass size={18} /></div>
          {command.empty
            ? <p className="command-muted">No zones exist yet.</p>
            : <>
              {command.capacityRisks.length === 0
                ? <div className="command-mini-clear"><CheckCircle2 size={15} /><span>Every zone is within dwell and object limits.</span></div>
                : <div className="capacity-risk-list">{command.capacityRisks.map((zone) => <Link key={zone.zoneId} to={zone.to} className={`capacity-risk-row${zone.pressured ? ' pressured' : ''}`} data-testid="capacity-risk">
                    <span className="zone-color" style={{ backgroundColor: zone.color }} />
                    <span className="capacity-risk-body"><span className="capacity-risk-title"><strong>{zone.zoneName}</strong>{zone.pressured && <Badge tone="warning">Scenario pressure</Badge>}</span><small>{zone.detail}</small><ProgressBar value={Math.max(zone.dwellUtilization, zone.objectUtilization) * 100} tone={zone.level === 'critical' ? 'red' : 'amber'} /></span>
                    {zone.level === 'critical' ? <XCircle size={16} className="capacity-risk-icon critical" /> : <AlertTriangle size={16} className="capacity-risk-icon warning" />}
                  </Link>)}</div>}
              <div className="command-capacity-note">{command.pressureZoneIds.length > 0
                ? <><Gauge size={13} /><span>The saved visitor scenario flags {command.pressureZoneIds.length} zone{command.pressureZoneIds.length === 1 ? '' : 's'} as pressure points.</span></>
                : <><CheckCircle2 size={13} /><span>No pressure zones under the saved visitor scenario.</span></>}</div>
            </>}
          <Link className="command-textlink" to="/journey">Open visitor journey <ArrowRight size={14} /></Link>
        </section>

        <section className="panel command-panel" aria-labelledby="check-heading">
          <div className="panel-heading"><div><div className="eyebrow">FORMAL GATE</div><h2 id="check-heading">Last readiness check</h2></div><ClipboardCheck size={18} /></div>
          <div className="command-check" data-testid="last-check">
            <Badge tone={LAST_CHECK_COPY[command.lastCheck.status].tone}>{LAST_CHECK_COPY[command.lastCheck.status].label}</Badge>
            <p data-testid="last-check-date">{command.lastCheck.hasCheck && command.lastCheck.checkedAt ? formatDate(command.lastCheck.checkedAt) : 'Run the gate from the review desk to record a formal result.'}</p>
          </div>
          <Link className="command-textlink" to="/review">{command.lastCheck.status === 'passed' ? 'Open review desk' : 'Go to readiness check'} <ArrowRight size={14} /></Link>
        </section>
      </aside>
    </div>
  </div>;
}

function RiskCard({ risk, rank }: { risk: CommandRisk; rank: number }) {
  const Icon = RISK_ICON[risk.level];
  const AreaIcon = AREA_ICON[risk.area];
  return <Link to={risk.to} className={`risk-card risk-level-${risk.level}`} data-testid="risk-card" data-level={risk.level}>
    <span className="risk-rank">{String(rank).padStart(2, '0')}</span>
    <span className="risk-icon"><Icon size={18} /></span>
    <span className="risk-body">
      <span className="risk-title-line"><strong>{risk.title}</strong><Badge tone={RISK_TONE[risk.level as CommandRiskLevel]}>{titleCase(risk.level)}</Badge></span>
      <span className="risk-detail">{risk.detail}</span>
      <span className="risk-cta"><AreaIcon size={13} />{AREA_LABEL[risk.area]} · {risk.cta}<ArrowRight size={13} /></span>
    </span>
  </Link>;
}

function EmptyWorkspaceBanner() {
  return <EmptyState
    icon={<PackageOpen size={24} />}
    title="This workspace has no project content yet"
    detail="Objects, zones, and findings all read as empty. Start the collection and the rest of the command center will fill in from the same planning data."
    action={<Link className="button button-primary" to="/collection"><Boxes size={16} /><span>Add the first object</span></Link>}
  />;
}
