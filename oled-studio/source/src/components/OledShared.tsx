import { useRef } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, CircleAlert, TriangleAlert, Upload } from 'lucide-react';
import { OLED_SPEC } from '../lib/oled';

export interface ActivityEntry {
  id: number;
  at: number;
  label: string;
  detail: string;
  ok: boolean;
  simulated: boolean;
  error?: string;
}

export type PushLog = (
  label: string,
  detail: string,
  ok: boolean,
  simulated: boolean,
  error?: string,
) => void;

/** Card wrapper matching the dashboard's MetricCard surface styling. */
export function SectionCard({
  title,
  badge,
  children,
  className = '',
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl bg-[var(--c-surface)] p-5 shadow-[var(--shadow-card)] ${className}`}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--c-text-2)]">{title}</h3>
        {badge}
      </div>
      {children}
    </section>
  );
}

export function Chip({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    ok: 'bg-[var(--c-ok-bg)] text-[var(--c-ok-text)]',
    warn: 'bg-[var(--c-warn-bg)] text-[var(--c-warn-text)]',
    danger: 'bg-[var(--c-danger-bg)] text-[var(--c-danger-text)]',
    neutral: 'bg-[var(--c-soft)] text-[var(--c-text-2)]',
  };
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; icon: typeof Upload }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl bg-[var(--c-soft-60)] p-1">
      {tabs.map((t) => {
        const Icon = t.icon;
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            aria-pressed={selected}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              selected
                ? 'bg-[var(--c-surface)] text-[var(--c-accent-text)] shadow-[var(--shadow-card)]'
                : 'text-[var(--c-text-2)] hover:bg-[var(--c-soft)] hover:text-[var(--c-text)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Click-to-browse file input styled as a dashed dropzone. */
export function FileDrop({
  accept,
  onFile,
  icon: Icon,
  hint,
  compact = false,
}: {
  accept: string;
  onFile: (f: File) => void;
  icon: typeof Upload;
  hint: string;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--c-border-strong)] bg-[var(--c-soft-60)] text-[var(--c-text-2)] transition-colors hover:border-[var(--c-accent-text)] hover:text-[var(--c-text)] ${
        compact ? 'px-4 py-5' : 'px-4 py-8'
      }`}
    >
      <Icon className="h-5 w-5" strokeWidth={1.6} />
      <span className="text-xs font-medium">{hint}</span>
      <span className="text-[10px] text-[var(--c-text-3)]">Click to browse</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </button>
  );
}

/** One row of the activity log. */
export function LogRow({ entry }: { entry: ActivityEntry }) {
  const time = new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false });
  const Icon = entry.ok
    ? entry.simulated
      ? CircleAlert
      : CheckCircle2
    : TriangleAlert;
  const tone = entry.ok
    ? entry.simulated
      ? 'text-[var(--c-warn-text)]'
      : 'text-[var(--c-ok-text)]'
    : 'text-[var(--c-danger-text)]';
  return (
    <li className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--c-soft-60)]">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-medium text-[var(--c-text)]">{entry.label}</span>
          {entry.simulated && (
            <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--c-warn-text)]">
              simulated
            </span>
          )}
        </div>
        <p className="truncate text-[11px] text-[var(--c-text-2)]" title={entry.error ?? entry.detail}>
          {entry.error ?? entry.detail}
        </p>
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--c-text-3)]">{time}</span>
    </li>
  );
}

/** Persistent note about the device link rate — shown in the media tabs. */
export function LinkNote() {
  return (
    <p className="rounded-lg bg-[var(--c-soft-60)] px-3 py-2 text-[11px] leading-relaxed text-[var(--c-text-2)]">
      The panel uses a USB UART configured for 1.5&nbsp;Mbaud, so each{' '}
      <span className="font-mono text-[10px]">{OLED_SPEC.width}×{OLED_SPEC.height}</span> full frame ({' '}
      <span className="font-mono text-[10px]">{(OLED_SPEC.bytesPerFrame / 1024).toFixed(0)} KB</span>) lands in about
      1.3 seconds in upstream measurements. Small partial changes can land much faster; the preview above
      remains independent of device throughput.
    </p>
  );
}
