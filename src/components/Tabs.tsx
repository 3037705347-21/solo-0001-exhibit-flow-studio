import type { ReactNode } from 'react';

export interface TabOption<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: ReactNode;
}

export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-selected={value === option.id}
          className={value === option.id ? 'active' : ''}
          onClick={() => onChange(option.id)}
        >
          {option.icon}
          <span>{option.label}</span>
          {option.count !== undefined && <small>{option.count}</small>}
        </button>
      ))}
    </div>
  );
}
