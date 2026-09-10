import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function TextField({
  label,
  hint,
  error,
  textarea,
  ...props
}: (InputHTMLAttributes<HTMLInputElement> | TextareaHTMLAttributes<HTMLTextAreaElement>) & {
  label: string;
  hint?: string;
  error?: string;
  textarea?: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {textarea ? (
        <textarea {...(props as TextareaHTMLAttributes<HTMLTextAreaElement>)} />
      ) : (
        <input {...(props as InputHTMLAttributes<HTMLInputElement>)} />
      )}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
