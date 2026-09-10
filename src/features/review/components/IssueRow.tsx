import { AlertCircle, Check, FileWarning, MapPin, RotateCcw, ShieldAlert, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { formatDate, titleCase } from '../../../domain/formatters';
import type { ReviewIssue } from '../../../domain/models';
import { issueActionLabel, nextIssueStatus } from '../findings/issueControls';

interface IssueRowProps {
  issue: ReviewIssue;
  onTransition: (status: ReviewIssue['status']) => { ok: boolean; message?: string };
}

export function IssueRow({ issue, onTransition }: IssueRowProps) {
  const [error, setError] = useState<string | null>(null);
  const next = nextIssueStatus(issue.status);
  const resultLabel = issueActionLabel(issue.status);
  const result = () => { const response = onTransition(next); if (!response.ok) { setError(response.message ?? 'Transition failed.'); window.setTimeout(() => setError(null), 2500); } };
  return <article className={`issue-row issue-${issue.severity}`}><div className="issue-severity">{issue.severity === 'critical' ? <ShieldAlert size={19} /> : issue.severity === 'warning' ? <AlertCircle size={19} /> : <FileWarning size={19} />}</div><div className="issue-main"><div className="issue-title-line"><h3>{issue.title}</h3><Badge tone={issue.status === 'resolved' ? 'positive' : issue.severity === 'critical' ? 'danger' : issue.severity === 'warning' ? 'warning' : 'neutral'}>{titleCase(issue.status)}</Badge></div><p>{issue.description}</p><div className="issue-meta"><span><UserRound size={13} /> {issue.owner}</span>{issue.zoneId && <span><MapPin size={13} /> Zone linked</span>}{issue.artifactId && <span>Object linked</span>}<span>Updated {formatDate(issue.updatedAt)}</span></div>{error && <div className="field-error">{error}</div>}</div><Button variant={issue.status === 'resolved' ? 'ghost' : 'secondary'} icon={issue.status === 'resolved' ? <RotateCcw size={15} /> : <Check size={15} />} onClick={result}>{resultLabel}</Button></article>;
}
