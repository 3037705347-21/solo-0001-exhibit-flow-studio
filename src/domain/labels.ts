import type { AccessibilityNeed, IssueSeverity, IssueStatus, NarrativeRole, Sensitivity } from './models';

export const roleDescriptions: Record<NarrativeRole, string> = {
  threshold: 'Introduces the visitor to the exhibition question.',
  context: 'Offers grounding details, history, or a shared vocabulary.',
  'turning-point': 'Changes the direction or emotional temperature of the story.',
  reflection: 'Leaves room for connection, consequence, or afterthought.',
};

export const severityDescriptions: Record<IssueSeverity, string> = {
  note: 'Useful observation without a release-blocking consequence.',
  warning: 'Should be addressed before opening, but does not block release.',
  critical: 'Must be resolved before this plan can be shared.',
};

export const statusDescriptions: Record<IssueStatus, string> = {
  open: 'Needs an owner and a next step.',
  'in-progress': 'An owner is actively working on a resolution.',
  resolved: 'Evidence or a decision has been recorded.',
};

export const sensitivityDescriptions: Record<Sensitivity, string> = {
  standard: 'Standard display environment.',
  'low-light': 'Keep display lighting below the object limit.',
  fragile: 'Handle with additional care during installation.',
};

export const accessibilityDescriptions: Record<AccessibilityNeed, string> = {
  none: 'No additional interpretation requirement recorded.',
  seating: 'Provide a seated interpretation point.',
  audio: 'Provide audio interpretation and a non-audio alternative.',
  'tactile-alternative': 'Provide a tactile or material alternative.',
};

export function describeRole(role: NarrativeRole): string { return roleDescriptions[role]; }
export function describeSeverity(severity: IssueSeverity): string { return severityDescriptions[severity]; }
export function describeStatus(status: IssueStatus): string { return statusDescriptions[status]; }
export function describeSensitivity(value: Sensitivity): string { return sensitivityDescriptions[value]; }
export function describeAccessibility(value: AccessibilityNeed): string { return accessibilityDescriptions[value]; }
export function isBlockingSeverity(value: IssueSeverity): boolean { return value === 'critical'; }
