import type { SelectHTMLAttributes } from 'react';

export function SelectField({ label, hint, error, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; error?: string }) {
  return <label className="field"><span className="field-label">{label}</span><select {...props} />{hint && !error && <span className="field-hint">{hint}</span>}{error && <span className="field-error">{error}</span>}</label>;
}
