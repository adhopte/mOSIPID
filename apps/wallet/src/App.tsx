import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, View } from 'react-native';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { StoredCredential } from '@mosipid/core';
import { loadCredentials, saveCredentials } from './vault';
import { authenticate, isLockEnabled } from './lock';
import { HomeScreen } from './screens/Home';
import { ScanScreen } from './screens/Scan';
import { OfferScreen } from './screens/Offer';
import { PresentScreen } from './screens/Present';
import { DetailScreen } from './screens/Detail';
import { ProximityScreen } from './screens/Proximity';
import { SettingsScreen } from './screens/Settings';
import { I18nProvider, useI18n, ServersProvider, useServers, BrandProvider, useBrand, Button, H, P } from '@mosipid/mobile-kit';

type Route =
  | { name: 'home' } | { name: 'scan' } | { name: 'settings' } | { name: 'proximity' }
  | { name: 'offer'; uri: string } | { name: 'present'; uri: string } | { name: 'detail'; id: string };

function Shell() {
  const { t } = useI18n();
  const { issuerUrl } = useServers();
  const { theme } = useBrand();
  const [creds, setCreds] = useState<StoredCredential[]>([]);
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [locked, setLocked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const unlock = useCallback(async () => { setLocked(!(await authenticate(t('w.lock.title')))); }, [t]);
  useEffect(() => { isLockEnabled().then((on) => (on ? unlock() : setLocked(false))); }, []);
  useEffect(() => { if (locked === false) loadCredentials().then(setCreds); }, [locked]);

  const route$ = useCallback((url: string | null) => {
    if (!url) return;
    if (/^(openid-credential-offer|haip):/i.test(url) && /credential_offer/.test(url)) setRoute({ name: 'offer', uri: url });
    else if (/^(openid4vp|haip-vp|mdoc-openid4vp):/i.test(url) || /request_uri=/.test(url)) setRoute({ name: 'present', uri: url });
    else if (/credential_offer/.test(url)) setRoute({ name: 'offer', uri: url });
  }, []);
  useEffect(() => {
    Linking.getInitialURL().then(route$);
    const sub = Linking.addEventListener('url', (e) => route$(e.url));
    return () => sub.remove();
  }, [route$]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (route.name !== 'home') { setRoute({ name: 'home' }); return true; } return false; });
    return () => sub.remove();
  }, [route]);

  const persist = async (list: StoredCredential[]) => { setCreds(list); await saveCredentials(list); };
  const home = () => setRoute({ name: 'home' });

  const startIssuerFlow = async (path: string, body: object) => {
    setBusy(true);
    try {
      const r = await fetch(issuerUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'issuer unavailable');
      setRoute({ name: 'offer', uri: j.offer_uri });
    } catch (e: any) { Alert.alert(t('err.generic'), e.message); }
    finally { setBusy(false); }
  };

  if (locked === null) return <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center' }}><ActivityIndicator /></View>;
  if (locked) return (
    <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center', padding: 24, gap: 16 }}>
      <H>{t('w.lock.title')}</H><P muted>{t('w.lock.text')}</P><Button label={t('w.lock.unlock')} onPress={unlock} />
    </View>
  );

  switch (route.name) {
    case 'scan': return <ScanScreen onClose={home} onData={(d) => { if (/^(openid|haip|mdoc)/i.test(d) || /credential_offer|request_uri/.test(d)) route$(d); else { Alert.alert(t('w.scan.unsupported')); home(); } }} />;
    case 'offer': return <OfferScreen uri={route.uri} onClose={home} onIssued={(c) => persist([...creds, ...c])} />;
    case 'present': return <PresentScreen uri={route.uri} credentials={creds} onClose={home} />;
    case 'proximity': return <ProximityScreen credentials={creds} onClose={home} />;
    case 'settings': return <SettingsScreen onClose={home} />;
    case 'detail': {
      const c = creds.find((x) => x.id === route.id);
      return c ? <DetailScreen credential={c} onClose={home} onDelete={async () => { await persist(creds.filter((x) => x.id !== c.id)); home(); }} /> : null;
    }
    default:
      return <HomeScreen credentials={creds} busy={busy} onOpen={(c) => setRoute({ name: 'detail', id: c.id })} onScan={() => setRoute({ name: 'scan' })}
        onGetId={(m) => startIssuerFlow('/api/enroll', { method: m })} onGetDegree={() => startIssuerFlow('/api/university/offer', {})}
        onProximity={() => setRoute({ name: 'proximity' })} onSettings={() => setRoute({ name: 'settings' })} />;
  }
}

export default function App() {
  return (
    <I18nProvider>
      <ServersProvider>
        <BrandProvider tenant="wallet">
          <StatusBar style="light" />
          <Shell />
        </BrandProvider>
      </ServersProvider>
    </I18nProvider>
  );
}
