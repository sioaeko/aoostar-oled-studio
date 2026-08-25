import { describe, expect, test } from 'bun:test';
import { networkScaleFor, nextNetworkScale } from './useTelemetry';

describe('adaptive network gauge scale', () => {
  test('uses power-of-ten MB/s ceilings', () => {
    expect(networkScaleFor(0)).toBe(1);
    expect(networkScaleFor(1)).toBe(1);
    expect(networkScaleFor(1.01)).toBe(10);
    expect(networkScaleFor(10)).toBe(10);
    expect(networkScaleFor(10.01)).toBe(100);
    expect(networkScaleFor(100.01)).toBe(1000);
  });

  test('expands immediately when a faster rate arrives', () => {
    expect(nextNetworkScale(125, 8)).toEqual({ peakMbps: 125, scaleMbps: 1000 });
  });

  test('decays the recent peak before lowering the scale', () => {
    expect(nextNetworkScale(0, 100)).toEqual({ peakMbps: 90, scaleMbps: 100 });
  });
});
