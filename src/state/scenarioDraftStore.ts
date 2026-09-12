import { isValidScenarioDraft, type ScenarioDraft } from '../domain/scenarioDraft';

export const SCENARIO_DRAFT_KEY = 'exhibit-flow.scenario-draft.v1';

export function loadScenarioDraft(storage: Pick<Storage, 'getItem'> = localStorage): ScenarioDraft | null {
  try {
    const raw = storage.getItem(SCENARIO_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidScenarioDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveScenarioDraft(draft: ScenarioDraft, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(SCENARIO_DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearScenarioDraft(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  try {
    storage.removeItem(SCENARIO_DRAFT_KEY);
  } catch {
    // Draft recovery is best-effort; ignore storage failures.
  }
}
