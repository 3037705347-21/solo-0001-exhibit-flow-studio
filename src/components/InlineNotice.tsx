import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

export function InlineNotice({ tone = 'info', message }: { tone?: 'info' | 'warning' | 'success'; message: string }) {
  const Icon = tone === 'warning' ? AlertTriangle : tone === 'success' ? CheckCircle2 : Info;
  return <div className={`inline-notice inline-notice-${tone}`} role="status"><Icon size={14} /><span>{message}</span></div>;
}
