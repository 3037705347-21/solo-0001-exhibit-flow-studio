export function daysUntil(dateValue: string, from = new Date()): number {
  const target = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(target.getTime())) return 0;
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - start.getTime()) / 86_400_000);
}

export function isPast(dateValue: string, from = new Date()): boolean { return daysUntil(dateValue, from) < 0; }

export function dateStatus(dateValue: string, from = new Date()): 'past' | 'soon' | 'planned' {
  const days = daysUntil(dateValue, from);
  return days < 0 ? 'past' : days <= 30 ? 'soon' : 'planned';
}

export function monthLabel(dateValue: string): string {
  const date = new Date(`${dateValue}T00:00:00`);
  return Number.isNaN(date.getTime()) ? 'Unscheduled' : new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(date);
}

export function clampDate(value: string, minimum: string, maximum: string): string {
  const current = new Date(`${value}T00:00:00`).getTime();
  const min = new Date(`${minimum}T00:00:00`).getTime();
  const max = new Date(`${maximum}T00:00:00`).getTime();
  if (!Number.isFinite(current)) return minimum;
  if (current < min) return minimum;
  if (current > max) return maximum;
  return value;
}

export function addDays(dateValue: string, days: number): string {
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateValue;
  date.setDate(date.getDate() + Math.round(days));
  return date.toISOString().slice(0, 10);
}

export function isoToday(now = new Date()): string { return now.toISOString().slice(0, 10); }
export function sameDay(left: string, right: string): boolean { return left.slice(0, 10) === right.slice(0, 10); }
export function isValidDate(value: string): boolean { return !Number.isNaN(new Date(`${value}T00:00:00`).getTime()); }
export const DAY_MS = 86_400_000;

export function isWeekend(dateValue: string): boolean {
  const day = new Date(`${dateValue}T00:00:00`).getDay();
  return day === 0 || day === 6;
}
