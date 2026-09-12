import { useState } from 'react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { TextField } from '../../components/TextField';
import { titleCase } from '../../domain/formatters';
import type { ScenarioInput } from '../../domain/models';

export function SaveComparisonDialog({
  defaultName,
  input,
  onSave,
  onClose,
}: {
  defaultName: string;
  input: ScenarioInput;
  onSave: (name: string, input: ScenarioInput) => { ok: boolean; errors?: Record<string, string>; message?: string };
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | undefined>();

  const submit = () => {
    const result = onSave(name, input);
    if (!result.ok) {
      setErrors(result.errors ?? {});
      setMessage(result.message);
      return;
    }
    onClose();
  };

  return (
    <Modal
      eyebrow="SAVE COMPARISON"
      title="Save scenario comparison"
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="save-comparison-confirm" onClick={submit}>Save comparison</Button>
      </>}
    >
      <div className="save-comparison-form">
        <p className="save-comparison-summary">
          Freezes <strong>{titleCase(input.pace)}</strong> pace · {input.groupSize} people · {input.accessibilityPriority}% access priority
          together with the current plan version and the projected outcomes.
        </p>
        <TextField
          label="Comparison name"
          data-testid="comparison-name-input"
          value={name}
          autoFocus
          maxLength={80}
          error={errors.name}
          onChange={(event) => { setName(event.target.value); setErrors({}); setMessage(undefined); }}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
        />
        {(errors.duplicate || message) && !errors.name && <p className="field-error" role="alert">{errors.duplicate ?? message}</p>}
      </div>
    </Modal>
  );
}
