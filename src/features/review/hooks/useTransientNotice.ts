import { useCallback, useState } from 'react';

const NOTICE_DURATION_MS = 2600;

/** Shows a short-lived confirmation message that clears itself. */
export function useTransientNotice(durationMs = NOTICE_DURATION_MS) {
  const [notice, setNotice] = useState<string | null>(null);

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), durationMs);
  }, [durationMs]);

  return { notice, notify };
}
