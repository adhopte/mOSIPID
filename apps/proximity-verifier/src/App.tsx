import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { I18nProvider, ServersProvider, BrandProvider } from '@mosipid/mobile-kit';
import { HomeScreen, SettingsScreen, VerifyScreen, Profile } from './screens';

function Shell() {
  const [route, setRoute] = useState<{ n: 'home' } | { n: 'verify'; p: Profile } | { n: 'settings' }>({ n: 'home' });
  const home = () => setRoute({ n: 'home' });
  if (route.n === 'verify') return <VerifyScreen profile={route.p} onClose={home} />;
  if (route.n === 'settings') return <SettingsScreen onClose={home} />;
  return <HomeScreen onStart={(p) => setRoute({ n: 'verify', p })} onSettings={() => setRoute({ n: 'settings' })} />;
}
export default function App() {
  return (
    <I18nProvider><ServersProvider><BrandProvider tenant="verifier-proximity"><StatusBar style="light" /><Shell /></BrandProvider></ServersProvider></I18nProvider>
  );
}
