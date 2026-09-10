export function KeyValueList({
  items,
}: {
  items: Array<{ label: string; value: string; emphasis?: boolean }>;
}) {
  return (
    <dl className="key-value-list">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.emphasis ? 'emphasis' : ''}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
