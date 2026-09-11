import { Eraser } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { Button } from '../../components/Button';
import type { ZoneRulePatch as Patch } from '../../domain/sandbox';

export interface ZoneRuleDraft {
  capacityMinutes: string;
  maxObjects: string;
  lowLight: boolean;
  hasSeating: boolean;
}

export function zoneToRuleDraft(zone: { capacityMinutes: number; maxObjects: number; lowLight: boolean; hasSeating: boolean }): ZoneRuleDraft {
  return {
    capacityMinutes: String(zone.capacityMinutes),
    maxObjects: String(zone.maxObjects),
    lowLight: zone.lowLight,
    hasSeating: zone.hasSeating,
  };
}

export function buildZoneRulePatch(zone: { capacityMinutes: number; maxObjects: number; lowLight: boolean; hasSeating: boolean }, draft: ZoneRuleDraft): Partial<Patch> | null {
  const patch: Partial<Patch> = {};
  const capacity = Number(draft.capacityMinutes);
  const maxObjects = Number(draft.maxObjects);
  if (Number.isFinite(capacity) && capacity !== zone.capacityMinutes) patch.capacityMinutes = capacity;
  if (Number.isFinite(maxObjects) && maxObjects !== zone.maxObjects) patch.maxObjects = maxObjects;
  if (draft.lowLight !== zone.lowLight) patch.lowLight = draft.lowLight;
  if (draft.hasSeating !== zone.hasSeating) patch.hasSeating = draft.hasSeating;
  return Object.keys(patch).length ? patch : null;
}

export function ZoneRuleCard({
  zone,
  draft,
  onChange,
  onReset,
}: {
  zone: { id: string; shortLabel: string; name: string; capacityMinutes: number; maxObjects: number; lowLight: boolean; hasSeating: boolean };
  draft: ZoneRuleDraft;
  onChange: (next: ZoneRuleDraft) => void;
  onReset: () => void;
}) {
  const updateNumber = (field: 'capacityMinutes' | 'maxObjects') => (event: ChangeEvent<HTMLInputElement>) =>
    onChange({ ...draft, [field]: event.target.value });
  const dirty = buildZoneRulePatch(zone, draft) !== null;
  return (
    <div className={`sandbox-rule-card ${dirty ? 'dirty' : ''}`}>
      <div className="sandbox-rule-head">
        <strong>{zone.shortLabel}</strong>
        {dirty && <Button variant="ghost" icon={<Eraser size={13} />} onClick={onReset}>Reset</Button>}
      </div>
      <div className="sandbox-rule-grid">
        <label className="field"><span className="field-label">Dwell cap (min)</span>
          <input aria-label={`${zone.name} dwell capacity minutes`} type="number" min={1} max={600} value={draft.capacityMinutes} onChange={updateNumber('capacityMinutes')} />
        </label>
        <label className="field"><span className="field-label">Object limit</span>
          <input aria-label={`${zone.name} maximum objects`} type="number" min={1} max={50} value={draft.maxObjects} onChange={updateNumber('maxObjects')} />
        </label>
      </div>
      <div className="sandbox-toggles">
        <label className="sandbox-toggle"><input type="checkbox" checked={draft.lowLight} onChange={(event) => onChange({ ...draft, lowLight: event.target.checked })} /><span>Low-light zone</span></label>
        <label className="sandbox-toggle"><input type="checkbox" checked={draft.hasSeating} onChange={(event) => onChange({ ...draft, hasSeating: event.target.checked })} /><span>Seating available</span></label>
      </div>
    </div>
  );
}
