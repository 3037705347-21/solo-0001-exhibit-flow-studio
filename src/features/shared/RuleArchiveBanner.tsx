import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../../state/WorkspaceContext';

const PROBLEM_COPY: Record<string, string> = {
  'storage-malformed': 'Saved workspace data could not be read; the sample plan is shown. Your file was not overwritten.',
  'profiles-filtered': 'One or more saved rule archive entries were invalid and ignored during load.',
  'rule-binding-missing': 'This project is not bound to a review rule archive version.',
  'rule-profile-unknown': 'The rule archive version this project was evaluated against is not present in this workspace.',
  'rule-profile-corrupt': 'The bound rule archive version holds invalid thresholds.',
};

/**
 * Hard block for unresolvable rule archives. Calculation surfaces render this
 * instead of silently evaluating plans against default rules.
 */
export function RuleArchiveBanner() {
  const { ruleResolution, loadProblems } = useWorkspace();
  if (ruleResolution.status === 'resolved') return null;
  const loadProblem = loadProblems.find((problem) => problem.startsWith('rule-') || problem === 'profiles-filtered');
  const detail = loadProblem ? PROBLEM_COPY[loadProblem] : undefined;
  return <section className="rule-banner" role="alert">
    <div className="rule-banner-icon"><ShieldAlert size={22} /></div>
    <div className="rule-banner-copy">
      <div className="eyebrow">RULE ARCHIVE REQUIRED</div>
      <h2>Readiness calculations are paused</h2>
      <p>{ruleResolution.reason}</p>
      {detail && <p className="rule-banner-detail">{detail}</p>}
      <p className="rule-banner-hint"><AlertTriangle size={14} /> Default thresholds are intentionally not used. Open the rule archive to bind this project to a version stored here.</p>
      <Link className="rule-banner-link" to="/review/rules">Open rule archive</Link>
    </div>
  </section>;
}
