export function Skeleton({ lines = 3, compact = false }: { lines?: number; compact?: boolean }) {
  return (
    <div className={`skeleton ${compact ? 'compact' : ''}`} aria-label="Loading content">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} style={{ width: `${Math.max(38, 100 - index * 17)}%` }} />
      ))}
    </div>
  );
}
