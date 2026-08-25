import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Film,
  Image as ImageIcon,
  LayoutDashboard,
  Loader2,
  MonitorPlay,
  Plug,
  Power,
  PowerOff,
  RotateCcw,
  SunDim,
  Type,
  Wifi,
} from 'lucide-react';
import { useTelemetry } from '../hooks/useTelemetry';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { OLED_SPEC, createOledClient } from '../lib/oled';
import type { BridgeStatus, FitMode, OledClient } from '../lib/oled';
import { WTR_MAX } from '../lib/nodes';
import OledPanel from './OledPanel';
import type { PanelSource } from './OledPanel';
import OledOffTab from './OledOffTab';
import OledStatsTab from './OledStatsTab';
import { GifTab, ImageTab, VideoTab } from './OledMediaTabs';
import OledTextTab from './OledTextTab';
import { Chip, LogRow, SectionCard, TabBar } from './OledShared';
import type { ActivityEntry, PushLog } from './OledShared';

type Tab = 'stats' | 'gif' | 'video' | 'image' | 'text' | 'off';
type ConnState = 'sim' | 'checking' | 'ok' | 'unreachable';

const STATUS_POLL_MS = 2_000;

const TABS: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'stats', label: 'Stats', icon: LayoutDashboard },
  { id: 'gif', label: 'GIF', icon: Film },
  { id: 'video', label: 'Video', icon: MonitorPlay },
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'off', label: 'Off', icon: PowerOff },
];

const FITS: { id: FitMode; label: string }[] = [
  { id: 'contain', label: 'Fit' },
  { id: 'cover', label: 'Fill' },
  { id: 'stretch', label: 'Stretch' },
];

/**
 * Standalone OLED studio page. The embedded bridge supplies live Linux host
 * telemetry; frontend development falls back to a local preview source.
 */
export default function OledPage() {
  const reducedMotion = useReducedMotion();

  const [bridgeUrl, setBridgeUrl] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('oled_studio_bridge');
      if (saved !== null) return saved;
    } catch {
      /* storage unavailable — fall through */
    }
    // Production is embedded in asterctl-web, with the API on this origin.
    // Vite development keeps the explicit bridge-address workflow.
    return import.meta.env.PROD ? window.location.origin : '';
  });
  const [client, setClient] = useState<OledClient>(() => createOledClient(null));
  const [conn, setConn] = useState<ConnState>('sim');
  const [bridgeInfo, setBridgeInfo] = useState<BridgeStatus | null>(null);
  const [displayOn, setDisplayOn] = useState(true);
  const [powerPending, setPowerPending] = useState(false);
  const [softwareBrightness, setSoftwareBrightness] = useState(100);
  const [brightnessPending, setBrightnessPending] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [fit, setFit] = useState<FitMode>('contain');
  const [tab, setTab] = useState<Tab>('stats');
  const [panelSource, setPanelSource] = useState<PanelSource | null>(null);
  const [log, setLog] = useState<ActivityEntry[]>([]);
  const logIdRef = useRef(0);
  const brightnessTimerRef = useRef<number | null>(null);
  const t = useTelemetry(WTR_MAX, client.kind === 'bridge' ? bridgeUrl : null);

  const pushLog = useCallback<PushLog>((label, detail, ok, simulated, error) => {
    setLog((prev) =>
      [{ id: ++logIdRef.current, at: Date.now(), label, detail, ok, simulated, error }, ...prev].slice(0, 50),
    );
  }, []);

  // Auto-connect to a saved bridge URL once on mount.
  const connectedOnceRef = useRef(false);
  useEffect(() => {
    if (connectedOnceRef.current) return;
    connectedOnceRef.current = true;
    const saved = bridgeUrl;
    if (saved) void handleConnect(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = useCallback(
    async (url: string) => {
      const trimmed = url.trim();
      const c = createOledClient(trimmed || null);
      setClient(c);
      if (!trimmed) {
        setConn('sim');
        setBridgeInfo(null);
        return;
      }
      try {
        localStorage.setItem('oled_studio_bridge', trimmed);
      } catch {
        /* storage unavailable */
      }
      setConn('checking');
      const st = await c.status();
      const healthy = st.connected && st.live;
      setBridgeInfo(st);
      setConn(healthy ? 'ok' : 'unreachable');
      if (st.connected) {
        setDisplayOn(st.displayOn);
        setSoftwareBrightness(st.brightness);
      }
      pushLog(
        'Bridge',
        healthy
          ? `${st.simulated ? 'Connected to simulation' : 'Connected'} — ${st.device ?? 'device'}`
          : st.connected
            ? `Display worker fault — ${st.error ?? 'unknown error'}`
            : `Unreachable — ${st.error ?? 'no response'}`,
        healthy,
        st.simulated,
        st.error,
      );
    },
    [pushLog],
  );

  // Keep display power, simulation mode and worker job synchronized without
  // allowing slow status requests to overlap.
  useEffect(() => {
    if (client.kind !== 'bridge') return;
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const st = await client.status();
      inFlight = false;
      if (disposed) return;
      setBridgeInfo(st);
      setConn(st.connected && st.live ? 'ok' : 'unreachable');
      if (st.connected) {
        setDisplayOn(st.displayOn);
        setSoftwareBrightness(st.brightness);
      }
    };
    const timer = window.setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [client]);

  useEffect(
    () => () => {
      if (brightnessTimerRef.current != null) window.clearTimeout(brightnessTimerRef.current);
    },
    [],
  );

  const applyBrightness = async (percent: number) => {
    setBrightnessPending(true);
    try {
      const st = await client.setBrightness(percent);
      const ok = st.connected || st.simulated;
      if (ok) {
        setSoftwareBrightness(st.brightness);
        if (client.kind === 'bridge') setBridgeInfo(st);
      }
      pushLog(
        'Brightness boost',
        ok ? `${st.brightness}% software boost` : st.error ?? 'Could not apply brightness boost',
        ok,
        st.simulated,
        st.error,
      );
    } finally {
      setBrightnessPending(false);
    }
  };

  const scheduleBrightness = (percent: number) => {
    setSoftwareBrightness(percent);
    if (brightnessTimerRef.current != null) window.clearTimeout(brightnessTimerRef.current);
    brightnessTimerRef.current = window.setTimeout(() => {
      brightnessTimerRef.current = null;
      void applyBrightness(percent);
    }, 180);
  };

  const togglePower = async () => {
    const next = !displayOn;
    if (!next) {
      // Unmount the active content tab first so browser-side video/text/stats
      // loops cannot enqueue more frames after the off command.
      setTab('off');
      setPanelSource(null);
    }
    setPowerPending(true);
    try {
      const st = await client.setPower(next);
      const ok = st.connected || st.simulated;
      if (ok) {
        setDisplayOn(st.displayOn);
        if (client.kind === 'bridge') setBridgeInfo(st);
      }
      pushLog('Power', next ? 'Display on' : 'Display off', ok, st.simulated, st.error);
    } finally {
      setPowerPending(false);
    }
  };

  const switchTab = (id: string) => {
    setTab(id as Tab);
    setPanelSource(null);
  };

  const workerLabel =
    bridgeInfo?.job === 'gif'
      ? 'GIF loop'
      : bridgeInfo?.job === 'still'
        ? 'Still frame'
        : bridgeInfo?.job === 'idle'
          ? 'Idle'
          : 'Unknown';

  const connChip =
    conn === 'ok' ? (
      <Chip tone={bridgeInfo?.simulated ? 'warn' : 'ok'}>
        <Wifi className="h-3 w-3" strokeWidth={2} /> {bridgeInfo?.simulated ? 'Bridge sim' : 'Live'}
      </Chip>
    ) : conn === 'checking' ? (
      <Chip tone="neutral">
        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} /> Checking
      </Chip>
    ) : conn === 'unreachable' ? (
      <Chip tone="danger">
        <Wifi className="h-3 w-3" strokeWidth={2} /> {bridgeInfo?.connected ? 'Fault' : 'Offline'}
      </Chip>
    ) : (
      <Chip tone="warn">Simulator</Chip>
    );

  return (
    <div
      className={`mx-auto w-full max-w-[1400px] ${
        reducedMotion ? 'animate-[fade-in-soft_0.2s_ease_both]' : 'animate-[fade-in_0.4s_ease_both]'
      }`}
    >
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-grotesk text-xl font-semibold text-[var(--c-text)]">Front-panel display</h1>
            <span className="rounded-md bg-[var(--c-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--c-text-2)]">
              WTR MAX
            </span>
          </div>
          <p className="mt-0.5 text-xs text-[var(--c-text-2)]">
            AOOSTAR WTR MAX OLED · {OLED_SPEC.width}×{OLED_SPEC.height} · RGB565 · USB UART bridge
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {connChip}
          <button
            type="button"
            onClick={() => void togglePower()}
            disabled={powerPending}
            aria-pressed={displayOn}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[11px] font-semibold transition-colors ${
              displayOn
                ? 'border-[var(--c-ok-border)] bg-[var(--c-ok-bg)] text-[var(--c-ok-text)]'
                : 'border-[var(--c-border-strong)] bg-[var(--c-soft)] text-[var(--c-text-2)]'
            }`}
          >
            {powerPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" strokeWidth={2} />}
            {powerPending ? 'Applying…' : displayOn ? 'Display on' : 'Display off'}
          </button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        {/* Left column — panel + bridge */}
        <div className="space-y-5">
          <SectionCard
            title="Panel preview"
            badge={
              conn === 'sim' ? (
                <Chip tone="warn">Simulated</Chip>
              ) : conn === 'ok' ? (
                <Chip tone={bridgeInfo?.simulated ? 'warn' : 'ok'}>
                  {bridgeInfo?.simulated ? 'Bridge simulation' : 'Hardware'} · {workerLabel}
                </Chip>
              ) : conn === 'unreachable' && bridgeInfo?.connected ? (
                <Chip tone="danger">Device fault</Chip>
              ) : undefined
            }
          >
            <OledPanel
              source={panelSource}
              power={displayOn}
              rotate180={rotate}
              simulated={conn === 'sim' || bridgeInfo?.simulated === true}
              softwareBrightness={softwareBrightness}
            />

            {/* Panel controls */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setRotate((v) => !v)}
                aria-pressed={rotate}
                title="Preview orientation — the protocol does not expose device rotation"
                className="flex h-7 items-center gap-1.5 rounded-lg border border-[var(--c-border-strong)] px-2.5 text-[11px] font-medium text-[var(--c-text-2)] transition-colors hover:bg-[var(--c-soft)] hover:text-[var(--c-text)]"
              >
                <RotateCcw className="h-3 w-3" strokeWidth={2} />
                {rotate ? 'Rotated 180°' : 'Rotate 180°'}
              </button>
              <div className="flex items-center gap-1 rounded-lg bg-[var(--c-soft-60)] p-0.5">
                {FITS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFit(f.id)}
                    aria-pressed={fit === f.id}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      fit === f.id ? 'bg-[var(--c-surface)] text-[var(--c-text)] shadow-sm' : 'text-[var(--c-text-2)] hover:text-[var(--c-text)]'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2.5 border-t border-[var(--c-border)] pt-3">
              {brightnessPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--c-text-3)]" />
              ) : (
                <SunDim className="h-3.5 w-3.5 text-[var(--c-text-3)]" strokeWidth={1.8} />
              )}
              <label htmlFor="software-brightness" className="shrink-0 text-[11px] font-medium text-[var(--c-text-2)]">
                Brightness boost
              </label>
              <input
                id="software-brightness"
                type="range"
                min={100}
                max={200}
                step={10}
                value={softwareBrightness}
                onChange={(event) => scheduleBrightness(Number(event.target.value))}
                className="min-w-0 flex-1 accent-emerald-500"
              />
              <span className="w-9 text-right font-mono text-[10px] tabular-nums text-[var(--c-text-3)]">
                {softwareBrightness}%
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--c-text-3)]">
              100% is the original image (recommended). Higher values brighten dark colors while largely preserving
              their hue and saturation. The UART protocol does not expose the physical LCD backlight, so fully white
              pixels cannot
              become brighter than the panel itself.
            </p>
          </SectionCard>

          <SectionCard title="Bridge connection" badge={<Plug className="h-3.5 w-3.5 text-[var(--c-text-3)]" strokeWidth={1.8} />}>
            <div className="flex gap-2">
              <input
                value={bridgeUrl}
                onChange={(e) => setBridgeUrl(e.target.value)}
                placeholder="http://192.168.1.10:8787"
                spellCheck={false}
                className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-soft)] px-3 font-mono text-xs text-[var(--c-text)] outline-none transition-colors placeholder:text-[var(--c-text-3)] focus:border-emerald-500 focus:bg-[var(--c-surface)]"
              />
              <button
                type="button"
                onClick={() => void handleConnect(bridgeUrl)}
                disabled={conn === 'checking'}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
              >
                {conn === 'checking' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" strokeWidth={2} />}
                Connect
              </button>
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--c-text-3)]">
              {conn === 'sim'
                ? 'No bridge configured — everything is simulated in this browser and clearly labeled. Run asterctl-web on the WTR MAX host and enter its URL to reach the real panel.'
                : conn === 'unreachable'
                  ? bridgeInfo?.connected
                    ? `Bridge is reachable, but the display worker reported: ${bridgeInfo.error ?? 'unknown device error'}`
                    : `Bridge at ${bridgeUrl} did not answer. Is the bridge service running on the host and reachable from this network?`
                  : bridgeInfo?.simulated
                    ? 'Connected to the bridge in simulation mode — no hardware is being touched.'
                    : `Connected to the bridge${bridgeInfo?.device ? ` on ${bridgeInfo.device}` : ''} — frames reach real hardware.`}
            </p>
          </SectionCard>
        </div>

        {/* Right column — content + activity */}
        <div className="space-y-5">
          <SectionCard title="Content">
            <TabBar tabs={TABS} active={tab} onChange={switchTab} />
            <div className="mt-4">
              {tab === 'stats' && (
                <OledStatsTab
                  t={t}
                  hostname={t.hostname ?? WTR_MAX.hostname}
                  client={client}
                  pushLog={pushLog}
                  onSource={setPanelSource}
                />
              )}
              {tab === 'gif' && <GifTab client={client} pushLog={pushLog} onSource={setPanelSource} />}
              {tab === 'video' && <VideoTab client={client} pushLog={pushLog} onSource={setPanelSource} />}
              {tab === 'image' && <ImageTab client={client} pushLog={pushLog} onSource={setPanelSource} fit={fit} />}
              {tab === 'text' && <OledTextTab client={client} pushLog={pushLog} onSource={setPanelSource} />}
              {tab === 'off' && (
                <OledOffTab
                  client={client}
                  displayOn={displayOn}
                  onPowerChange={setDisplayOn}
                  pushLog={pushLog}
                />
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="Activity"
            badge={
              log.length > 0 ? (
                <span className="font-mono text-[10px] tabular-nums text-[var(--c-text-3)]">{log.length}</span>
              ) : undefined
            }
          >
            {log.length === 0 ? (
              <p className="py-4 text-center text-xs text-[var(--c-text-3)]">
                Sends, streams and connection events appear here — simulated results are always flagged.
              </p>
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
                {log.map((entry) => (
                  <LogRow key={entry.id} entry={entry} />
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
