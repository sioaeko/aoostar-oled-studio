import { useEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import type { Telemetry } from '../hooks/useTelemetry';
import {
  OLED_SPEC,
  createOledCanvas,
  fmtBytes,
  renderStatsFrame,
  rgb565FromCanvas,
} from '../lib/oled';
import type { OledClient, StatsTheme, StatsWidgets } from '../lib/oled';
import type { PanelSource } from './OledPanel';
import type { PushLog } from './OledShared';

const WIDGETS: { key: keyof StatsWidgets; label: string }[] = [
  { key: 'cpu', label: 'CPU' },
  { key: 'ram', label: 'RAM' },
  { key: 'temp', label: 'Temp' },
  { key: 'net', label: 'Network' },
  { key: 'clock', label: 'Clock' },
  { key: 'hostname', label: 'Hostname' },
  { key: 'uptime', label: 'Uptime' },
  { key: 'load', label: 'Load' },
];

const THEME_OPTIONS: { id: StatsTheme; label: string; swatch: string }[] = [
  { id: 'dark', label: 'Dark', swatch: '#0b0f1a' },
  { id: 'light', label: 'Light', swatch: '#f5f2ee' },
  { id: 'cyan', label: 'Cyan', swatch: '#04101a' },
  { id: 'amber', label: 'Amber', swatch: '#150f04' },
];

interface OledStatsTabProps {
  t: Telemetry;
  hostname: string;
  client: OledClient;
  pushLog: PushLog;
  onSource: (s: PanelSource | null) => void;
}

export default function OledStatsTab({ t, hostname, client, pushLog, onSource }: OledStatsTabProps) {
  const [widgets, setWidgets] = useState<StatsWidgets>({
    cpu: true,
    ram: true,
    temp: true,
    net: true,
    clock: true,
    hostname: true,
    uptime: true,
    load: false,
  });
  const [theme, setTheme] = useState<StatsTheme>('dark');
  const [streamSec, setStreamSec] = useState<0 | 1 | 2 | 5>(2);
  const [streaming, setStreaming] = useState(false);

  // Latest telemetry without re-creating the render loop each second.
  const tRef = useRef(t);
  tRef.current = t;
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Render loop — redraws the stats frame every second while the tab is open.
  useEffect(() => {
    const [canvas, ctx] = createOledCanvas();
    canvasRef.current = canvas;
    ctxRef.current = ctx;
    onSource({ el: canvas });
    const render = () =>
      renderStatsFrame(ctx, tRef.current, {
        widgets: widgetsRef.current,
        theme,
        hostname,
      });
    render();
    const id = window.setInterval(render, 1000);
    return () => {
      window.clearInterval(id);
      onSource(null);
      canvasRef.current = null;
      ctxRef.current = null;
    };
  }, [theme, hostname, onSource]);

  // Streaming — push the current frame to the bridge on the chosen cadence.
  useEffect(() => {
    if (!streaming || streamSec === 0) return;
    let cancelled = false;
    let timer = 0;
    const cadenceMs = streamSec * 1000;
    let nextTarget = performance.now();
    const send = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bytes = rgb565FromCanvas(canvas);
      const r = await client.sendFrame(bytes);
      if (cancelled) return;
      pushLog('Stats dashboard', `${fmtBytes(bytes.length)} frame`, r.ok, r.simulated ?? client.kind === 'simulator', r.error);
      nextTarget += cadenceMs;
      if (nextTarget < performance.now()) {
        const missed = Math.floor((performance.now() - nextTarget) / cadenceMs) + 1;
        nextTarget += missed * cadenceMs;
      }
      timer = window.setTimeout(send, Math.max(0, nextTarget - performance.now()));
    };
    void send();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void client.stop();
    };
  }, [streaming, streamSec, client, pushLog]);

  const toggleWidget = (key: keyof StatsWidgets) =>
    setWidgets((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="space-y-4">
      {/* Widget toggles */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--c-text-3)]">Widgets</p>
        <div className="flex flex-wrap gap-1.5">
          {WIDGETS.map((w) => {
            const on = widgets[w.key];
            return (
              <button
                key={w.key}
                type="button"
                onClick={() => toggleWidget(w.key)}
                aria-pressed={on}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                  on
                    ? 'border-[var(--c-accent-text)]/40 bg-[var(--c-accent-bg)] text-[var(--c-accent-text)]'
                    : 'border-[var(--c-border-strong)] text-[var(--c-text-2)] hover:bg-[var(--c-soft)]'
                }`}
              >
                {w.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Theme */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--c-text-3)]">Theme</p>
        <div className="flex gap-1.5">
          {THEME_OPTIONS.map((th) => (
            <button
              key={th.id}
              type="button"
              onClick={() => setTheme(th.id)}
              aria-pressed={theme === th.id}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                theme === th.id
                  ? 'border-[var(--c-accent-text)]/40 bg-[var(--c-accent-bg)] text-[var(--c-accent-text)]'
                  : 'border-[var(--c-border-strong)] text-[var(--c-text-2)] hover:bg-[var(--c-soft)]'
              }`}
            >
              <span
                className="h-3 w-3 rounded-full ring-1 ring-black/10 dark:ring-white/20"
                style={{ backgroundColor: th.swatch }}
              />
              {th.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stream controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--c-soft-60)] px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <label className="text-[11px] text-[var(--c-text-2)]" htmlFor="stats-interval">
            Refresh
          </label>
          <select
            id="stats-interval"
            value={streamSec}
            onChange={(e) => {
              const next = Number(e.target.value) as 0 | 1 | 2 | 5;
              setStreamSec(next);
              if (next === 0) setStreaming(false);
            }}
            className="rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-surface)] px-2 py-1.5 text-[11px] text-[var(--c-text)] outline-none focus:border-emerald-500"
          >
            <option value={0}>Off</option>
            <option value={1}>1 s</option>
            <option value={2}>2 s</option>
            <option value={5}>5 s</option>
          </select>
        </div>
        {streaming ? (
          <button
            type="button"
            onClick={() => setStreaming(false)}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--c-danger-bg)] px-3 text-[11px] font-semibold text-[var(--c-danger-text)] transition-colors hover:opacity-90"
          >
            <Square className="h-3 w-3" strokeWidth={2} />
            Stop streaming
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStreaming(true)}
            disabled={streamSec === 0}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play className="h-3 w-3" strokeWidth={2} />
            {client.kind === 'simulator' ? 'Simulate stream' : 'Stream to display'}
          </button>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--c-text-3)]">
        Renders a card-style {OLED_SPEC.width}×{OLED_SPEC.height} dashboard from live host telemetry when the bridge
        is connected, with local preview values during frontend development. Stream pushes frames at the chosen cadence.
        The Light theme sends the highest average pixel luminance, but it does not change the physical backlight.
      </p>
    </div>
  );
}
