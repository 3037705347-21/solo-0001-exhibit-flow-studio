import { AlertTriangle, ArrowLeftRight, ArrowRight, XCircle } from 'lucide-react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { formatPercent } from '../../domain/formatters';
import type { Artifact, Zone } from '../../domain/models';
import type { SwapPreview, SwapSidePreview, SwapZonePreview } from '../../domain/swap';

export function SwapDialog({ preview, artifacts, zones, error, onCancel, onConfirm }: {
  preview: SwapPreview;
  artifacts: Map<string, Artifact>;
  zones: Map<string, Zone>;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <Modal
    title="Confirm swap"
    eyebrow="PLACEMENT TRANSACTION"
    onClose={onCancel}
    footer={<>
      <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" icon={<ArrowLeftRight size={15} />} disabled={!preview.canSwap} onClick={onConfirm}>Swap objects</Button>
    </>}
  >
    <div className="swap-grid">
      <SwapSideCard side={preview.first} artifact={artifacts.get(preview.first.artifactId)} zones={zones} />
      <div className="swap-arrow" aria-hidden="true"><ArrowLeftRight size={18} /></div>
      <SwapSideCard side={preview.second} artifact={artifacts.get(preview.second.artifactId)} zones={zones} />
    </div>
    <div className="swap-zones">
      {preview.zones.map((zone) => <SwapZoneCard key={zone.zoneId} preview={zone} name={zones.get(zone.zoneId)?.name ?? zone.zoneId} />)}
    </div>
    {(preview.errors.length > 0 || preview.warnings.length > 0) && <div className="swap-findings">
      {preview.errors.map((finding) => <div className="finding-row error" key={finding.id}><XCircle size={15} /><span><strong>{finding.title}</strong><small>{finding.detail}</small></span></div>)}
      {preview.warnings.map((finding) => <div className="finding-row warning" key={finding.id}><AlertTriangle size={15} /><span><strong>{finding.title}</strong><small>{finding.detail}</small></span></div>)}
    </div>}
    {!preview.canSwap && <p className="swap-blocked-note">Resolve the blocking conflict before this swap can be confirmed. No placements have changed.</p>}
    {error && <div className="finding-row error swap-error"><XCircle size={15} /><span><strong>Swap not applied</strong><small>{error}</small></span></div>}
  </Modal>;
}

function SwapSideCard({ side, artifact, zones }: { side: SwapSidePreview; artifact?: Artifact; zones: Map<string, Zone> }) {
  return <div className="swap-card">
    <strong>{artifact?.title ?? side.artifactId}</strong>
    <div className="swap-route">
      <span>From {zones.get(side.fromZoneId)?.name ?? side.fromZoneId} · slot {side.fromIndex + 1}</span>
      <span className="swap-target"><ArrowRight size={12} /> To {zones.get(side.toZoneId)?.name ?? side.toZoneId} · slot {side.toIndex + 1}</span>
    </div>
  </div>;
}

function SwapZoneCard({ preview, name }: { preview: SwapZonePreview; name: string }) {
  return <div className="swap-zone-card">
    <strong>{name}</strong>
    <div className="swap-delta"><span>Dwell</span><span>{preview.beforeDwellMinutes} → {preview.afterDwellMinutes} / {preview.capacityMinutes} min</span></div>
    <div className="swap-delta"><span>Objects</span><span>{preview.beforeObjects} → {preview.afterObjects} / {preview.maxObjects}</span></div>
    <div className="swap-delta"><span>Utilization</span><span>{formatPercent(preview.beforeUtilization)} → {formatPercent(preview.afterUtilization)}</span></div>
  </div>;
}
