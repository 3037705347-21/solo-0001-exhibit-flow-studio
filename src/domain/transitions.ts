import { IssueHistoryError, recordIssueStatus } from './issueHistory';
import type { IssueStatus, ProjectStage, ReviewIssue, WorkspaceState } from './models';

const PROJECT_TRANSITIONS: Record<ProjectStage, ProjectStage[]> = {
  draft: ['review'],
  review: ['draft', 'ready'],
  ready: ['review'],
};

export class TransitionError extends Error {
  constructor(message: string, public readonly from: string, public readonly to: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

export function transitionIssue(
  issue: ReviewIssue,
  target: IssueStatus,
  at = new Date(),
  actor = issue.owner,
  note?: string,
): ReviewIssue {
  try {
    return recordIssueStatus(issue, target, at, actor, note);
  } catch (error) {
    if (error instanceof IssueHistoryError) {
      throw new TransitionError(error.message, issue.status, target);
    }
    throw error;
  }
}

export function transitionProject(state: WorkspaceState, target: ProjectStage): WorkspaceState {
  const source = state.project.stage;
  if (source === target) return state;
  if (!PROJECT_TRANSITIONS[source].includes(target)) {
    throw new TransitionError(`Cannot move the project from ${source} to ${target}.`, source, target);
  }
  return { ...state, project: { ...state.project, stage: target } };
}

export function regressReadyProject(state: WorkspaceState): WorkspaceState {
  if (state.project.stage !== 'ready') return state;
  return { ...state, project: { ...state.project, stage: 'review' } };
}
