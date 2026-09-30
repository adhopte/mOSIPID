// Branding is controlled centrally in the Admin portal; the app fetches it at start-up and caches it.
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Branding, DEFAULT_BRANDING, brandName } from '@mosipid/core';
import { useI18n } from './i18n';
import { useServers } from './servers';

export interface Theme { dark: boolean; bg: string; surface: string; text: string; muted: string; border: string; primary: string; secondary: string; accent: string; danger: string; ok: string }

export function buildTheme(b: Branding, scheme: 'light' | 'dark' | null | undefined): Theme {
  const dark = b.theme === 'dark' || (b.theme === 'auto' && scheme === 'dark');
  return dark
    ? { dark, bg: '#0B1020', surface: '#141B2E', text: '#E6E9F2', muted: '#9AA4BF', border: '#26304A', primary: b.colors.primary, secondary: b.colors.secondary, accent: b.colors.accent, danger: '#F87171', ok: '#4ADE80' }
    : { dark, bg: b.colors.background, surface: b.colors.surface, text: b.colors.text, muted: '#667085', border: '#E4E7EC', primary: b.colors.primary, secondary: b.colors.secondary, accent: b.colors.accent, danger: '#B91C1C', ok: '#15803D' };
}

interface Ctx { theme: Theme; branding: Branding; name: string; logo?: string; tenant(id: string): Promise<Branding> }
const Brand = createContext<Ctx>(null as any);
const cache = new Map<string, Branding>();

export function BrandProvider({ tenant, children }: { tenant: string; children: React.ReactNode }) {
  const { adminUrl } = useServers();
  const { lang } = useI18n();
  const scheme = useColorScheme() as 'light' | 'dark' | null;
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING[tenant]);

  const fetchTenant = async (id: string): Promise<Branding> => {
    if (cache.has(id)) return cache.get(id)!;
    let b: Branding = DEFAULT_BRANDING[id];
    try {
      const cached = await AsyncStorage.getItem('brand:' + id);
      if (cached) b = JSON.parse(cached);
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`${adminUrl}/api/branding/${id}`, { signal: ctl.signal }); clearTimeout(to);
      if (r.ok) { b = await r.json(); AsyncStorage.setItem('brand:' + id, JSON.stringify(b)); }
    } catch { /* offline: cached or default */ }
    if (b) cache.set(id, b);
    return b;
  };

  useEffect(() => { cache.delete(tenant); fetchTenant(tenant).then((b) => b && setBranding(b)); }, [adminUrl, tenant]);
  const theme = buildTheme(branding, scheme);
  return <Brand.Provider value={{ theme, branding, name: brandName(branding, lang), logo: branding.logoUrl, tenant: fetchTenant }}>{children}</Brand.Provider>;
}
export const useBrand = () => useContext(Brand);
