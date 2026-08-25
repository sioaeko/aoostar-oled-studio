import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function getPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * Live view of the OS-level `prefers-reduced-motion` preference.
 *
 * Unlike `useMotion` (a persisted, user-overridable intensity setting), this
 * hook always reflects the operating system's setting and re-renders the
 * consumer when the user flips it while the app is open. Transition
 * animations use it to degrade slide/scale effects to a plain opacity fade —
 * no translate, no scale — so vestibular-sensitive users get movement-free
 * transitions.
 *
 * Returns `true` when the OS requests reduced motion.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(getPrefersReducedMotion);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    // Modern API, with a fallback for older browsers that only expose
    // the deprecated addListener().
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return reduced;
}
