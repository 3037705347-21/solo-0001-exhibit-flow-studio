import { ArrowLeft, Compass } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useWorkspace } from '../state/WorkspaceContext';

/**
 * Shown on a target page after following a readiness blocker link, so the
 * user keeps the context of what they are fixing and has a way back.
 */
export function BlockerContextBanner() {
  const { state } = useWorkspace();
  const [searchParams] = useSearchParams();
  if (searchParams.get('from') !== 'readiness') return null;
  const blockerId = searchParams.get('blocker') ?? '';
  const blocker = state.readiness?.blockers.find((candidate) => candidate.id === blockerId);
  return <div className="blocker-context" role="status">
    <Compass size={15} />
    <span>{blocker
      ? <>Resolving blocker: <strong>{blocker.message}</strong></>
      : 'You arrived from a readiness check. The recorded blockers no longer match — re-run the check for a fresh list.'}</span>
    <Link className="blocker-context-return" to="/review"><ArrowLeft size={13} /> Back to review desk</Link>
  </div>;
}
