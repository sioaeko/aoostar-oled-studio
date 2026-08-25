import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import OledPage from './components/OledPage';
import { useReducedMotion } from './hooks/useReducedMotion';

type Theme = 'dark' | 'light';

const THEME_KEY = 'oled_studio_theme';

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable — fall through */
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <div className="min-h-screen bg-[linear-gradient(to_bottom,var(--c-bg-from),var(--c-bg),var(--c-bg-to))] text-[var(--c-text)]">
      <div
        className={`mx-auto w-full max-w-[1500px] px-4 py-6 md:px-6 ${
          reducedMotion ? 'animate-[fade-in-soft_0.2s_ease_both]' : 'animate-[fade-in_0.4s_ease_both]'
        }`}
      >
        <div className="mb-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-[var(--c-text-2)]">OLED Studio</span>
            <span className="rounded-md bg-[var(--c-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--c-text-2)]">
              WTR MAX
            </span>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--c-text-2)] transition-colors hover:bg-[var(--c-soft)] hover:text-[var(--c-text)]"
          >
            {theme === 'dark' ? (
              <Sun className="h-[18px] w-[18px]" strokeWidth={1.8} />
            ) : (
              <Moon className="h-[18px] w-[18px]" strokeWidth={1.8} />
            )}
          </button>
        </div>
        <OledPage />
      </div>
    </div>
  );
}
