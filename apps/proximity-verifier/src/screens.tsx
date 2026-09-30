import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, View, Text } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { DOCTYPE_ID, NS_ID, LANGUAGES, ReaderProximity, RequestedItems, VerifiedDocument, toBase64 } from '@mosipid/core';
import { useI18n, useServers, useBrand, Button, Card, ErrorBox, Field, H, P, Screen } from '@mosipid/mobile-kit';
import { cachedTrust, identityAnchors, syncTrust } from './trust';

export type Profile = 'age' | 'identity' | 'full';
const PROFILES: Record<Profile, string[]> = {
  age: ['age_over_18'],
  identity: ['family_name', 'given_name', 'birth_date', 'portrait', 'age_over_18'],
  full: ['family_name', 'given_name', 'birth_date', 'sex', 'nationality', 'document_number', 'expiry_date', 'issuing_authority', 'portrait', 'age_over_18', 'assurance_level'],
};
export const wanted = (p: Profile): RequestedItems => ({ [DOCTYPE_ID]: { [NS_ID]: PROFILES[p] } });

export function HomeScreen({ onStart, onSettings }: { onStart: (p: Profile) => void; onSettings: () => void }) {
  const { t } = useI18n();
  const { name } = useBrand();
  const s = useServers();
  const [info, setInfo] = useState<{ count: number; at: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { const c = await cachedTrust(); if (c) setInfo({ count: c.anchors.length, at: c.syncedAt }); };
  const sync = async () => { setBusy(true); setErr(null); try { const r = await syncTrust(s.verifierUrl); setInfo({ count: r.anchors.length, at: r.syncedAt }); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  useEffect(() => { load().then(() => sync()); }, [s.verifierUrl]);
  return (
    <Screen title={name} right={<Text onPress={onSettings} accessibilityRole="button" accessibilityLabel={t('w.settings.title')} style={{ color: '#fff', fontSize: 24 }}>⚙︎</Text>}>
      <P muted>{t('p.intro')}</P>
      <Card><H>{t('p.whatToCheck')}</H>
        <Button label={t('p.profile.age')} onPress={() => onStart('age')} disabled={!info} />
        <Button kind="secondary" label={t('p.profile.identity')} onPress={() => onStart('identity')} disabled={!info} />
        <Button kind="secondary" label={t('p.profile.full')} onPress={() => onStart('full')} disabled={!info} />
      </Card>
      <Card>
        <H>{t('p.trust.title')}</H>
        <P muted>{info ? t('p.trust.info', { count: info.count, date: info.at.slice(0, 16).replace('T', ' ') }) : t('p.trust.none')}</P>
        <ErrorBox message={err} />
        <Button kind="secondary" label={t('p.trust.sync')} onPress={sync} busy={busy} />
      </Card>
    </Screen>
  );
}

export function VerifyScreen({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useI18n();
  const [perm, request] = useCameraPermissions();
  const handled = useRef(false);
  const [state, setState] = useState<'scan' | 'wait' | 'ok' | 'fail'>('scan');
  const [docs, setDocs] = useState<VerifiedDocument[]>([]);
  const [error, setError] = useState<string | null>(null);

  const onQr = async (data: string) => {
    if (handled.current) return; handled.current = true;
    if (!data.startsWith('mdoc:')) { setError(t('p.notMdoc')); setState('fail'); return; }
    setState('wait');
    try {
      const trust = await cachedTrust();
      if (!trust) throw new Error(t('p.trust.none'));
      const res = await ReaderProximity.request(data, wanted(profile), { trustAnchors: identityAnchors(trust.anchors), timeoutMs: 120_000 });
      if (res.ok) { setDocs(res.documents); setState('ok'); } else { setError(res.error); setState('fail'); }
    } catch (e: any) { setError(e.message); setState('fail'); }
  };

  return (
    <Screen title={t('p.verify.title')} onBack={onClose}>
      {state === 'scan' && (!perm?.granted ? (<><P>{t('w.scan.permission')}</P><Button label={t('w.scan.grant')} onPress={request} /></>) : (
        <>
          <View style={{ height: 420, borderRadius: 16, overflow: 'hidden' }}>
            <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => onQr(data)} />
          </View>
          <P muted style={{ textAlign: 'center' }}>{t('p.scan.hint')}</P>
        </>
      ))}
      {state === 'wait' && <Card><ActivityIndicator /><P style={{ textAlign: 'center' }}>{t('p.waiting')}</P></Card>}
      {state === 'ok' && <Result docs={docs} />}
      {state === 'fail' && <Card style={{ borderColor: '#B91C1C' }}><H>✗ {t('p.result.fail')}</H><ErrorBox message={error} /></Card>}
      {(state === 'ok' || state === 'fail') && <Button label={t('p.newScan')} onPress={onClose} />}
    </Screen>
  );
}

function Result({ docs }: { docs: VerifiedDocument[] }) {
  const { t } = useI18n();
  const d = docs[0];
  const claims = d.claims[NS_ID] ?? {};
  return (
    <>
      <Card style={{ borderColor: '#15803D' }}>
        <H>✓ {t('p.result.ok')}</H>
        <P muted>{t('p.result.issuer')}: {d.anchorSubject}</P>
        <P muted>{t('p.result.signedBy')}: {d.issuerSubject}</P>
        {claims.assurance_level === 'demo' ? <ErrorBox message={t('p.result.demo')} /> : null}
      </Card>
      <Card>
        {claims.portrait instanceof Uint8Array ? <Image source={{ uri: 'data:image/jpeg;base64,' + toBase64(claims.portrait as Uint8Array) }} style={{ width: 120, height: 160, borderRadius: 10 }} /> : null}
        {Object.entries(claims).filter(([k]) => k !== 'portrait').map(([k, v]) => (
          <View key={k}><P muted>{t('claim.' + k)}</P><P>{typeof v === 'boolean' ? (v ? '✓ Yes' : '✗ No') : String(v)}</P></View>
        ))}
      </Card>
    </>
  );
}

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const { t, lang, setLang } = useI18n();
  const s = useServers();
  const [v, setV] = useState({ adminUrl: s.adminUrl, issuerUrl: s.issuerUrl, verifierUrl: s.verifierUrl });
  return (
    <Screen title={t('w.settings.title')} onBack={onClose}>
      <Card><H>{t('w.settings.language')}</H>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{LANGUAGES.map((l) => <Button key={l.code} kind={lang === l.code ? 'primary' : 'secondary'} label={l.label} onPress={() => setLang(l.code)} />)}</View></Card>
      <Card><H>{t('w.settings.servers')}</H>
        <Field label={t('w.settings.adminUrl')} value={v.adminUrl} onChangeText={(x) => setV({ ...v, adminUrl: x })} autoCapitalize="none" keyboardType="url" />
        <Field label={t('w.settings.verifierUrl')} value={v.verifierUrl} onChangeText={(x) => setV({ ...v, verifierUrl: x })} autoCapitalize="none" keyboardType="url" />
        <Button label={t('w.settings.save')} onPress={() => s.update({ ...v, issuerUrl: s.issuerUrl })} /></Card>
    </Screen>
  );
}
