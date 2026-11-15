import { en } from './en';
import { ja, type Dict } from './ja';

export type Lang = 'ja' | 'en';
const KEY = 'kamen.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = typeof navigator === 'undefined' ? 'ja' : navigator.language.toLowerCase();
  return nav.startsWith('ja') ? 'ja' : 'en';
}

/** Chosen once at startup; switching reloads the page (see setLang). */
export const lang: Lang = detect();
export const t: Dict = lang === 'en' ? en : ja;
export const locale = lang === 'en' ? 'en-US' : 'ja-JP';

if (typeof document !== 'undefined') document.documentElement.lang = lang;

/** The preference is a per-device convenience in localStorage; it is never sent anywhere. */
export function setLang(next: Lang): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  location.reload();
}

export function formatSats(msat: number): string {
  return t.app.sats(Math.floor(msat / 1000));
}
