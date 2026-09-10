import { ArrowDown, ArrowUp, Boxes, Compass, ClipboardCheck, Gauge, History, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { SectionHeader } from '../../components/SectionHeader';
import { HISTORY_LIMIT, type HistoryCategory, type HistoryEntry } from '../../domain/commandLog';
import { formatDateTime } from '../../domain/formatters';
import { useWorkspace } from '../../state/WorkspaceContext';

const CATEGORY_META: Record<HistoryCategory, { label: string; icon: ReactNode; tone: 'neutral' | 'info' | 'warning' | 'positive' | 'danger' }> = {
  object: { label: 'Object', icon: <Boxes size={14} />, tone: 'neutral' },
  journey: { label: 'Journey', icon: <Compass size={14} />, tone: 'info' },
  finding: { label: 'Finding', icon: <ClipboardCheck size={14} />, tone: 'warning' },
  preferences: { label: 'Preferences', icon: <Gauge size={14} />, tone: 'info' },
  readiness: { label: 'Readiness', icon: <ShieldCheck size={14} />, tone: 'positive' },
  workspace: { label: 'Workspace', icon: <RotateCcw size={14} />, tone: 'danger' },
};

function summaryIcon(entry: HistoryEntry): ReactNode {
  if (entry.action === 'placement/reorder') {
    return entry.summary.includes('earlier') ? <ArrowUp size={13} /> : <ArrowDown size={13} />;
  }
  return CATEGORY_META[entry.category].icon;
}

export function HistoryPage() {
  const { history } = useWorkspace();
  // Entries are stored oldest-first; the page presents the newest events first.
  const entries = useMemo(() => history.slice().reverse(), [history]);

  const counts = useMemo(() => {
    return {
      total: history.length,
      object: history.filter((entry) => entry.category === 'object').length,
      journey: history.filter((entry) => entry.category === 'journey').length,
      finding: history.filter((entry) => entry.category === 'finding').length,
      readiness: history.filter((entry) => entry.category === 'readiness' || entry.category === 'workspace').length,
    };
  }, [history]);

  return <div className="page-stack">
    <SectionHeader eyebrow="AUDIT TRAIL" title="Operation history" description="Every workspace-changing command is recorded here with its summary, source, and time. History is stored separately from the plan and survives refreshes and sample resets." />
    <div className="summary-strip">
      <div><span className="eyebrow">RECORDED EVENTS</span><strong data-testid="history-count">{counts.total}<small> kept of max {HISTORY_LIMIT}</small></strong></div>
      <div><span className="eyebrow">OBJECT EDITS</span><strong>{counts.object}<small> commands</small></strong></div>
      <div><span className="eyebrow">JOURNEY MOVES</span><strong>{counts.journey}<small> commands</small></strong></div>
      <div><span className="eyebrow">REVIEW EVENTS</span><strong>{counts.finding + counts.readiness}<small> findings &amp; checks</small></strong></div>
    </div>
    {entries.length === 0 ? (
      <EmptyState icon={<History size={24} />} title="No commands recorded yet" detail="Object edits, journey placements, finding updates, applied preferences, readiness checks, and workspace resets will appear here as soon as they happen." />
    ) : (
      <section className="activity-card">
        <div className="panel-heading">
          <div><div className="eyebrow">NEWEST FIRST</div><h2>Command timeline</h2></div>
          <Badge tone={history.length >= HISTORY_LIMIT ? 'warning' : 'neutral'}>{history.length >= HISTORY_LIMIT ? `Cap of ${HISTORY_LIMIT} reached` : `${history.length} events`}</Badge>
        </div>
        <ol className="activity-list" aria-label="Operation history">
          {entries.map((entry, index) => {
            const meta = CATEGORY_META[entry.category];
            return (
              <li className="activity-row" key={entry.id} data-testid="activity-row" data-category={entry.category}>
                <span className="activity-icon" data-category={entry.category}>{summaryIcon(entry)}</span>
                <div className="activity-copy">
                  <strong>{entry.summary}</strong>
                  <div className="activity-tags">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <span className="activity-source"><Sparkles size={11} />{entry.source}</span>
                  </div>
                </div>
                <time className="activity-time" dateTime={entry.timestamp} title={new Date(entry.timestamp).toISOString()}>{formatDateTime(entry.timestamp)}</time>
                {index < entries.length - 1 && <span className="activity-line" aria-hidden="true" />}
              </li>
            );
          })}
        </ol>
        <div className="activity-footnote">
          <History size={14} />
          <span>History is capped at the {HISTORY_LIMIT} most recent commands; older events roll off automatically. This trail never changes workspace data or command results.</span>
        </div>
      </section>
    )}
  </div>;
}
