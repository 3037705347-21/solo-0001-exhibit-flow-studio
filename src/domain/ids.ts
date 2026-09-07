export function createId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && 'randomUUID' in cryptoApi) {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeAccessionId(value: string): string {
  return value.trim().replace(/\s+/g, '-').toUpperCase();
}
