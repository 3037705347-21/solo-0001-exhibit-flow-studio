export function ArtifactGlyph({
  color,
  size = 'medium',
}: {
  color: string;
  size?: 'small' | 'medium' | 'large';
}) {
  return (
    <span
      className={`artifact-glyph artifact-glyph-${size}`}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      <span />
    </span>
  );
}
