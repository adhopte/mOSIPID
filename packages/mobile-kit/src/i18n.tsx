import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as Localization from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translate, normalizeLang, Lang } from '@mosipid/core';

interface Ctx { lang: Lang; setLang(l: Lang): void; t(key: string, params?: Record<string, string | number>): string }
const I18n = createContext<Ctx>({ lang: 'en', setLang() {}, t: (k) => k });

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(normalizeLang(Localization.getLocales()[0]?.languageCode));
  useEffect(() => { AsyncStorage.getItem('lang').then((l) => l && setLangState(normalizeLang(l))); }, []);
  const setLang = useCallback((l: Lang) => { setLangState(l); AsyncStorage.setItem('lang', l); }, []);
  const t = useCallback((key: string, params?: Record<string, string | number>) => translate(lang, key, params), [lang]);
  return <I18n.Provider value={{ lang, setLang, t }}>{children}</I18n.Provider>;
}
export const useI18n = () => useContext(I18n);
