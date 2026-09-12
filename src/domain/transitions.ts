import type { IssueStatus, ProjectStage, ReviewIssue, WorkspaceState } from './models';

const ISSUE_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open: ['in-progress'],
  'in-progress': ['open', 'resolved'],
  resolved: ['in-progress'],
};

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

export function transitionIssue(issue: ReviewIssue, target: IssueStatus, at = new Date()): ReviewIssue {
  if (issue.status === target) return issue;
  if (!ISSUE_TRANSITIONS[issue.status].includes(target)) {
    throw new TransitionError(`Cannot move a review finding from ${issue.status} to ${target}.`, issue.status, target);
  }
  const timestamp = at.toISOString();
  return {
    ...issue,
    status: target,
    updatedAt: timestamp,
    resolvedAt: target === 'resolved' ? timestamp : undefined,
    revision: issue.revision + 1,
  };
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
