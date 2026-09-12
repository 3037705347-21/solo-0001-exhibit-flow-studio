/**
 * Versioned reorder protocol for zone placements.
 *
 * Every reorder carries the zone version (and order) the client saw when the
 * drag started. Before anything is committed, the intent is resolved against
 * the authoritative order:
 *
 * - `apply`    — versions match; the move is replayed exactly as requested.
 * - `rebase`   — the order changed underneath; a deterministic equivalent move
 *                is generated on top of the current order, preserving every
 *                external edit, plus a human-readable diff of what changed.
 * - `conflict` — no deterministic equivalent exists (e.g. the object was
 *                removed from the zone); the caller must show the diff and let
 *                the user re-confirm against the fresh order.
 * - `noop`     — boundary moves and drags back to the original position.
 *
 * All functions are pure and never lose or duplicate object ids: every
 * returned `nextOrder` is an exact permutation of the current order.
 */

export interface ReorderIntent {
  /** Order the client rendered when the drag started (at the expected version). */
  baseOrder: string[];
  /** Authoritative order in the workspace right now. */
  currentOrder: string[];
  /** Object being moved. */
  artifactId: string;
  /** Desired index, interpreted on `baseOrder`. */
  targetIndex: number;
  /** True when the client's expected version no longer matches the zone version. */
  versionMismatch: boolean;
  /** Optional display-name resolver used for diff lines. */
  titleOf?: (id: string) => string;
}

export type ReorderResolution =
  | { kind: 'apply'; nextOrder: string[] }
  | { kind: 'rebase'; nextOrder: string[]; changes: string[] }
  | { kind: 'conflict'; reason: string; changes: string[] }
  | { kind: 'noop' };

export interface ReorderOutcome {
  kind: 'applied' | 'rebased' | 'conflict' | 'noop';
  /** Deterministic diff lines describing external changes, when relevant. */
  changes?: string[];
}

/** Remove duplicate ids, keeping the first occurrence. */
export function dedupeOrder(order: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

/**
 * Move `artifactId` to `targetIndex` (clamped to the list bounds). The object
 * ends up at exactly `targetIndex`; boundary targets and moves back to the
 * original position return the input array unchanged.
 */
export function moveInOrder(order: string[], artifactId: string, targetIndex: number): string[] {
  const from = order.indexOf(artifactId);
  if (from === -1) return order;
  const to = clampIndex(targetIndex, order.length);
  if (to === from) return order;
  const without = order.filter((id) => id !== artifactId);
  without.splice(to, 0, artifactId);
  return without;
}

/** True when `next` contains exactly the same ids as `current`, once each. */
export function isPermutationOf(next: string[], current: string[]): boolean {
  if (next.length !== current.length) return false;
  const remaining = new Map<string, number>();
  for (const id of current) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  for (const id of next) {
    const count = remaining.get(id);
    if (!count) return false;
    remaining.set(id, count - 1);
  }
  return true;
}

/**
 * Deterministic, human-readable diff between two orders: removals (in
 * before-order), then additions and moves (in after-order, 1-based positions).
 */
export function diffZoneOrders(
  before: string[],
  after: string[],
  titleOf: (id: string) => string = (id) => id,
): string[] {
  const beforeList = dedupeOrder(before);
  const afterList = dedupeOrder(after);
  const beforeSet = new Set(beforeList);
  const afterSet = new Set(afterList);
  const lines: string[] = [];
  for (const id of beforeList) {
    if (!afterSet.has(id)) lines.push(`“${titleOf(id)}” was removed from the zone`);
  }
  afterList.forEach((id, index) => {
    if (!beforeSet.has(id)) {
      lines.push(`“${titleOf(id)}” was added at position ${index + 1}`);
    } else {
      const previousIndex = beforeList.indexOf(id);
      if (previousIndex !== index) {
        lines.push(`“${titleOf(id)}” moved from position ${previousIndex + 1} to ${index + 1}`);
      }
    }
  });
  return lines;
}

/**
 * The id that should sit immediately after the moved object once it lands at
 * `targetIndex` in `order`, or `null` when the object moves to the end.
 */
function successorAnchor(order: string[], artifactId: string, targetIndex: number): string | null {
  const without = order.filter((id) => id !== artifactId);
  const to = clampIndex(targetIndex, order.length);
  return to < without.length ? without[to] : null;
}

/**
 * Resolve a reorder intent against the authoritative order. When the versions
 * match, the client's base order is trusted to equal the current order. When
 * they diverge, the intent is rebased: the object is inserted next to the same
 * successor it had in the client's order (or at a clamped positional fallback
 * when that successor is gone), leaving every external edit untouched.
 */
export function resolveZoneReorder(intent: ReorderIntent): ReorderResolution {
  const current = dedupeOrder(intent.currentOrder);
  const base = intent.versionMismatch ? dedupeOrder(intent.baseOrder) : current;
  const titleOf = intent.titleOf ?? ((id: string) => id);
  const { artifactId } = intent;

  if (!current.includes(artifactId)) {
    return {
      kind: 'conflict',
      reason: 'This object is no longer placed in the zone.',
      changes: diffZoneOrders(base, current, titleOf),
    };
  }
  if (!base.includes(artifactId)) {
    return {
      kind: 'conflict',
      reason: 'The order this drag was based on no longer includes the object.',
      changes: diffZoneOrders(base, current, titleOf),
    };
  }

  const from = base.indexOf(artifactId);
  const to = clampIndex(intent.targetIndex, base.length);
  if (from === to) return { kind: 'noop' };

  if (!intent.versionMismatch) {
    return { kind: 'apply', nextOrder: moveInOrder(current, artifactId, to) };
  }

  const anchor = successorAnchor(base, artifactId, to);
  const currentWithout = current.filter((id) => id !== artifactId);
  let insertAt: number;
  if (anchor === null) {
    insertAt = currentWithout.length;
  } else {
    const anchorIndex = currentWithout.indexOf(anchor);
    insertAt = anchorIndex === -1 ? Math.min(to, currentWithout.length) : anchorIndex;
  }
  const nextOrder = [...currentWithout];
  nextOrder.splice(insertAt, 0, artifactId);
  if (sameOrder(nextOrder, current)) return { kind: 'noop' };
  return { kind: 'rebase', nextOrder, changes: diffZoneOrders(base, current, titleOf) };
}
