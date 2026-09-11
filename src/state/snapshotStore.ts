import { migrateWorkspace, validateReferences } from './migrations';
import type { WorkspaceState } from '../domain/models';

/**
 * Verified state snapshots.
 *
 * A snapshot is a checksummed envelope. On load the checksum and shape are
 * verified, so a torn or partially flushed `setItem` write is detected instead
 * of being trusted. Two alternating slots mean a crashed snapshot write can
 * never destroy the previous known-good snapshot.
 */
export const SNAPSHOT_KEY_A = 'exhibit-flow.snapshot-a.v1';
export const SNAPSHOT_KEY_B = 'exhibit-flow.snapshot-b.v1';
export const LEGACY_STATE_KEY = 'exhibit-flow.workspace.v1';

export interface SnapshotEnvelope {
  format: 'exhibit-flow-snapshot';
  envelopeVersion: 1;
  /** Command sequence represented by this snapshot. */
  seq: number;
  /** Reset epoch represented by this snapshot. */
  epoch: string;
  /** FNV-1a 32-bit checksum of the serialized state. */
  checksum: string;
  state: WorkspaceState;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

/** Small deterministic non-cryptographic checksum; detects truncation/garbling. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16).padStart(8, '0')}`;
}

function isStateShape(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkspaceState>;
  return candidate.version === 1
    && Boolean(candidate.project)
    && Array.isArray(candidate.artifacts)
    && Array.isArray(candidate.zones)
    && Array.isArray(candidate.issues)
    && Boolean(candidate.preferences);
}

/**
 * Parses and verifies one envelope slot. `raw` is the exact string returned by
 * storage (so torn writes are detected rather than silently JSON-repaired).
 */
export function parseEnvelope(raw: string | null): { ok: true; envelope: SnapshotEnvelope } | { ok: false; reason: 'empty' | 'torn' | 'invalid' } {
  if (raw === null) return { ok: false, reason: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'torn' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'invalid' };
  const envelope = parsed as Partial<SnapshotEnvelope>;
  if (envelope.format !== 'exhibit-flow-snapshot'
    || envelope.envelopeVersion !== 1
    || typeof envelope.seq !== 'number'
    || typeof envelope.epoch !== 'string'
    || typeof envelope.checksum !== 'string'
    || !isStateShape(envelope.state)) {
    return { ok: false, reason: 'invalid' };
  }
  if (fnv1a(JSON.stringify(envelope.state)) !== envelope.checksum) {
    return { ok: false, reason: 'torn' };
  }
  return { ok: true, envelope: envelope as SnapshotEnvelope };
}

export interface LoadedSnapshot {
  state: WorkspaceState;
  seq: number;
  epoch: string;
  slot: 'a' | 'b';
}

/**
 * Reads both slots and returns the most recent verified snapshot within the
 * newest epoch. A corrupted slot is never chosen over a verified older one.
 */
export function loadVerifiedSnapshot(storage: ReadStorage): LoadedSnapshot | null {
  return inspectSnapshotSlots(storage).best;
}

export interface SnapshotSlotInspection {
  best: LoadedSnapshot | null;
  /** Slots that contain bytes but failed verification (torn/garbled). */
  corruptSlots: Array<{ slot: 'a' | 'b'; reason: 'torn' | 'invalid' }>;
}

export function inspectSnapshotSlots(storage: ReadStorage): SnapshotSlotInspection {
  const slots: Array<{ slot: 'a' | 'b'; raw: string | null }> = [
    { slot: 'a', raw: storage.getItem(SNAPSHOT_KEY_A) },
    { slot: 'b', raw: storage.getItem(SNAPSHOT_KEY_B) },
  ];
  let best: LoadedSnapshot | null = null;
  const corruptSlots: SnapshotSlotInspection['corruptSlots'] = [];
  for (const { slot, raw } of slots) {
    const result = parseEnvelope(raw);
    if (!result.ok) {
      if (result.reason !== 'empty') corruptSlots.push({ slot, reason: result.reason });
      continue;
    }
    const { envelope } = result;
    const candidate: LoadedSnapshot = {
      state: validateReferences(migrateWorkspace(envelope.state) ?? envelope.state),
      seq: envelope.seq,
      epoch: envelope.epoch,
      slot,
    };
    if (!best || candidate.epoch > best.epoch
      || (candidate.epoch === best.epoch && candidate.seq > best.seq)) {
      best = candidate;
    }
  }
  return { best, corruptSlots };
}

/**
 * Migrates a pre-journal installation: the old key held the bare state object.
 * The legacy value is consumed so later loads use verified snapshots only.
 */
export function loadLegacyBareState(raw: string | null): WorkspaceState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const migrated = migrateWorkspace(parsed);
  if (!migrated || !isStateShape(migrated)) return null;
  return validateReferences(migrated);
}

/**
 * Writes a snapshot to the opposite slot from `previousSlot`, verifies it by
 * reading the exact bytes back, and only then reports success. A failed write
 * leaves the previous verified slot untouched.
 */
export function writeVerifiedSnapshot(
  storage: WriteStorage & ReadStorage,
  state: WorkspaceState,
  seq: number,
  epoch: string,
  previousSlot: 'a' | 'b' | null,
): { ok: true; slot: 'a' | 'b' } | { ok: false; reason: string } {
  const targetSlot: 'a' | 'b' = previousSlot === 'a' ? 'b' : 'a';
  const key = targetSlot === 'a' ? SNAPSHOT_KEY_A : SNAPSHOT_KEY_B;
  const envelope: SnapshotEnvelope = {
    format: 'exhibit-flow-snapshot',
    envelopeVersion: 1,
    seq,
    epoch,
    checksum: fnv1a(JSON.stringify(state)),
    state,
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
    storage.setItem(key, serialized);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Storage rejected the snapshot.' };
  }
  const verified = parseEnvelope(storage.getItem(key));
  if (!verified.ok || verified.envelope.seq !== seq || verified.envelope.epoch !== epoch) {
    return { ok: false, reason: `Snapshot verification failed after writing slot ${targetSlot}.` };
  }
  return { ok: true, slot: targetSlot };
}

export function clearSnapshots(storage: WriteStorage & Pick<Storage, 'removeItem'>): void {
  storage.removeItem(SNAPSHOT_KEY_A);
  storage.removeItem(SNAPSHOT_KEY_B);
}
