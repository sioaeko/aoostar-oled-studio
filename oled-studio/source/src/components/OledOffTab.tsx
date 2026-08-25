import { Loader2, PowerOff } from 'lucide-react';
import { useState } from 'react';
import type { OledClient } from '../lib/oled';
import type { PushLog } from './OledShared';

interface OledOffTabProps {
  client: OledClient;
  displayOn: boolean;
  onPowerChange: (on: boolean) => void;
  pushLog: PushLog;
}

/** A real content mode for leaving the panel powered off. */
export default function OledOffTab({ client, displayOn, onPowerChange, pushLog }: OledOffTabProps) {
  const [working, setWorking] = useState(false);

  const applyOffMode = async () => {
    setWorking(true);
    try {
      const status = await client.setPower(false);
      const ok = status.connected || status.simulated;
      if (ok) onPowerChange(false);
      pushLog(
        'Off mode',
        ok ? 'Active playback stopped · display powered off' : 'Display did not power off',
        ok,
        status.simulated,
        status.error,
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex min-h-36 flex-col items-center justify-center rounded-xl bg-black px-6 py-7 text-center ring-1 ring-white/5">
        <PowerOff className="mb-3 h-7 w-7 text-zinc-500" strokeWidth={1.6} />
        <p className="text-sm font-medium text-zinc-200">Leave the panel off</p>
        <p className="mt-1 max-w-md text-[11px] leading-relaxed text-zinc-500">
          Stops an active GIF or frame stream, then sends the display-off command. The last frame remains in panel
          memory and returns when the display is powered on again.
        </p>
      </div>

      <button
        type="button"
        onClick={() => void applyOffMode()}
        disabled={working || !displayOn}
        className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--c-soft)] px-3 text-[11px] font-semibold text-[var(--c-text-2)] transition-colors hover:bg-[var(--c-border-strong)] hover:text-[var(--c-text)] disabled:cursor-default disabled:opacity-55"
      >
        {working ? <Loader2 className="h-3 w-3 animate-spin" /> : <PowerOff className="h-3 w-3" strokeWidth={2} />}
        {!displayOn ? 'Display is off' : working ? 'Turning display off…' : 'Apply off mode'}
      </button>

      <p className="text-[11px] leading-relaxed text-[var(--c-text-3)]">
        Use the power control in the page header to turn the panel back on without replacing its saved frame.
      </p>
    </div>
  );
}
