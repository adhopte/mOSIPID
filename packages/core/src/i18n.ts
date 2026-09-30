import en from './locales/en.json';
import fr from './locales/fr.json';
import es from './locales/es.json';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
] as const;
export type Lang = (typeof LANGUAGES)[number]['code'];
export const DEFAULT_LANG: Lang = 'en';

export const dictionaries: Record<Lang, Record<string, string>> = { en, fr, es };

export function normalizeLang(l?: string | null): Lang {
  const c = (l ?? '').toLowerCase().slice(0, 2);
  return (LANGUAGES.some((x) => x.code === c) ? c : DEFAULT_LANG) as Lang;
}

export function translate(lang: string, key: string, params?: Record<string, string | number>): string {
  const d = dictionaries[normalizeLang(lang)];
  let s = d[key] ?? dictionaries.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
