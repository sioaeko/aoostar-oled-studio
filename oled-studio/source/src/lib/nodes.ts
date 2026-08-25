/**
 * Minimal node model for the standalone OLED Studio.
 *
 * These values are only frontend-development fallbacks. The embedded Linux
 * bridge replaces them with live Proxmox host telemetry.
 */
export interface NodeConfig {
  id: string;
  hostname: string;
  coreCount: number;
  memTotalGb: number;
  cpuBase: number;
  tempBase: number;
  nvmeBase: number;
  rxBase: number;
  txBase: number;
}

/** The device this studio targets — the AOOSTAR WTR MAX itself. */
export const WTR_MAX: NodeConfig = {
  id: 'wtr-max',
  hostname: 'wtr-max',
  coreCount: 8,
  memTotalGb: 64,
  cpuBase: 26,
  tempBase: 44,
  nvmeBase: 40,
  rxBase: 12,
  txBase: 4,
};
