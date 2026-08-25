import { useEffect, useState } from 'react';
import type { NodeConfig } from '../lib/nodes';

/**
 * Telemetry shape consumed by the stats frame renderer.
 *
 * The embedded bridge exposes live Proxmox/Linux host telemetry. Development
 * without a bridge falls back to a local preview walk.
 */
export interface Telemetry {
  cpu: number; // 0-100
  memUsedGb: number;
  memTotalGb: number;
  cpuTemp: number; // °C
  nvmeTemp: number; // °C
  rx: number; // MB/s
  tx: number; // MB/s
  loadAvg: [number, number, number];
  networkLive: boolean;
  /** Decaying recent network peak used to keep the gauge from jumping down every second. */
  networkPeakMbps?: number;
  /** Power-of-ten MB/s ceiling currently shown by the network gauge. */
  networkScaleMbps?: number;
  /** Simulated host uptime (seconds). */
  uptimeSec?: number;
  hostname?: string;
  source: 'simulated' | 'live';
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Smallest 1/10/100/1000… MB/s scale that contains the observed rate. */
export function networkScaleFor(rateMbps: number): number {
  if (!Number.isFinite(rateMbps) || rateMbps <= 1) return 1;
  return 10 ** Math.ceil(Math.log10(rateMbps));
}

/**
 * Expand immediately for a new peak, but decay the remembered peak by 10% per
 * telemetry tick so the gauge does not flicker between adjacent scales.
 */
export function nextNetworkScale(currentMbps: number, previousPeakMbps = 0) {
  const current = Number.isFinite(currentMbps) ? Math.max(0, currentMbps) : 0;
  const previous = Number.isFinite(previousPeakMbps) ? Math.max(0, previousPeakMbps) : 0;
  const peakMbps = Math.max(current, previous * 0.9);
  return { peakMbps, scaleMbps: networkScaleFor(peakMbps) };
}

function withNetworkScale(next: Telemetry, previous?: Telemetry): Telemetry {
  const { peakMbps, scaleMbps } = nextNetworkScale(
    Math.max(next.rx, next.tx),
    previous?.networkPeakMbps,
  );
  return { ...next, networkPeakMbps: peakMbps, networkScaleMbps: scaleMbps };
}

/** Random walk that drifts back toward `center` so values don't stick at the extremes. */
function walk(prev: number, step: number, min: number, max: number, center: number) {
  const pull = (center - prev) * 0.06;
  const delta = (Math.random() - 0.5) * 2 * step + pull;
  return clamp(prev + delta, min, max);
}

function seed(config: NodeConfig): Telemetry {
  return withNetworkScale({
    cpu: config.cpuBase,
    memUsedGb: config.memTotalGb * 0.52,
    memTotalGb: config.memTotalGb,
    cpuTemp: config.tempBase,
    nvmeTemp: config.nvmeBase,
    rx: config.rxBase,
    tx: config.txBase,
    loadAvg: [config.cpuBase / 20, config.cpuBase / 24, config.cpuBase / 28],
    networkLive: false,
    uptimeSec: 47 * 86400 + 3 * 3600 + 21 * 60,
    hostname: config.hostname,
    source: 'simulated',
  });
}

function walkPreview(prev: Telemetry, config: NodeConfig): Telemetry {
  return withNetworkScale({
    ...prev,
    cpu: walk(prev.cpu, 5, 3, 96, config.cpuBase),
    memUsedGb: walk(prev.memUsedGb, config.memTotalGb * 0.015, config.memTotalGb * 0.3, config.memTotalGb * 0.9, config.memTotalGb * 0.55),
    cpuTemp: walk(prev.cpuTemp, 1.1, 30, 88, config.tempBase),
    nvmeTemp: walk(prev.nvmeTemp, 0.6, 28, 78, config.nvmeBase),
    rx: walk(prev.rx, config.rxBase * 0.4, 0, config.rxBase * 6, config.rxBase),
    tx: walk(prev.tx, config.txBase * 0.4, 0, config.txBase * 7, config.txBase),
    loadAvg: [
      walk(prev.loadAvg[0], 0.2, 0.05, 8, config.cpuBase / 20),
      walk(prev.loadAvg[1], 0.1, 0.05, 8, config.cpuBase / 24),
      walk(prev.loadAvg[2], 0.05, 0.05, 8, config.cpuBase / 28),
    ],
    uptimeSec: (prev.uptimeSec ?? 0) + 1,
    hostname: prev.hostname ?? config.hostname,
    source: 'simulated',
  }, prev);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseLiveTelemetry(value: unknown): Telemetry | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const load = Array.isArray(data.load_avg) ? data.load_avg.map(finite) : [];
  const cpu = finite(data.cpu);
  const memUsedGb = finite(data.mem_used_gb);
  const memTotalGb = finite(data.mem_total_gb);
  if (cpu == null || memUsedGb == null || memTotalGb == null || load.some((v) => v == null) || load.length !== 3) {
    return null;
  }
  return {
    cpu: clamp(cpu, 0, 100),
    memUsedGb: Math.max(0, memUsedGb),
    memTotalGb: Math.max(0, memTotalGb),
    cpuTemp: finite(data.cpu_temp) ?? 0,
    nvmeTemp: finite(data.nvme_temp) ?? 0,
    rx: Math.max(0, finite(data.rx) ?? 0),
    tx: Math.max(0, finite(data.tx) ?? 0),
    loadAvg: load as [number, number, number],
    networkLive: data.network_live === true,
    uptimeSec: Math.max(0, finite(data.uptime_sec) ?? 0),
    hostname: typeof data.hostname === 'string' && data.hostname.trim() ? data.hostname.trim() : undefined,
    source: 'live',
  };
}

/**
 * Host telemetry from the embedded bridge, with a local preview fallback for
 * frontend development or an unreachable server.
 */
export function useTelemetry(config: NodeConfig, bridgeUrl: string | null): Telemetry {
  const [t, setT] = useState<Telemetry>(() => seed(config));

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const base = bridgeUrl?.trim().replace(/\/+$/, '') ?? '';
    const update = async () => {
      if (disposed || inFlight) return;
      if (!base) {
        setT((prev) => walkPreview(prev, config));
        return;
      }
      inFlight = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 3_000);
      try {
        const response = await fetch(`${base}/api/telemetry`, { signal: controller.signal, cache: 'no-store' });
        const live = response.ok ? parseLiveTelemetry(await response.json()) : null;
        if (!disposed && live) setT((prev) => withNetworkScale(live, prev));
        else if (!disposed) setT((prev) => walkPreview(prev, config));
      } catch {
        if (!disposed) setT((prev) => walkPreview(prev, config));
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
      }
    };
    void update();
    const id = window.setInterval(() => void update(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [bridgeUrl, config]);

  return t;
}
