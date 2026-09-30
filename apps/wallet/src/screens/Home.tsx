import React, { useEffect, useState } from 'react';
import { Pressable, Text, View, Image } from 'react-native';
import { Branding, StoredCredential, brandName, DEFAULT_BRANDING } from '@mosipid/core';
import { claimsOf } from './Detail';
import { useI18n, useBrand, Button, Card, H, P, Screen } from '@mosipid/mobile-kit';

function CredentialCard({ c, onPress }: { c: StoredCredential; onPress: () => void }) {
  const { tenant } = useBrand();
  const { lang, t } = useI18n();
  const [b, setB] = useState<Branding | undefined>(c.brandingTenant ? DEFAULT_BRANDING[c.brandingTenant] : undefined);
  useEffect(() => { if (c.brandingTenant) tenant(c.brandingTenant).then((x) => x && setB(x)); }, [c.brandingTenant]);
  const bg = b?.colors.primary ?? '#334155';
  const holder = claimsOf(c);
  const given = holder.find((x) => x.name === 'given_name')?.value, fam = holder.find((x) => x.name === 'family_name')?.value;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={c.title}
      style={{ backgroundColor: bg, borderRadius: 18, padding: 18, gap: 6, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, elevation: 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {b?.logoUrl ? <Image source={{ uri: b.logoUrl }} style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: '#fff' }} resizeMode="contain" /> : null}
        <Text style={{ color: '#ffffffcc', fontWeight: '700', flex: 1 }}>{b ? brandName(b, lang) : c.issuerName}</Text>
      </View>
      <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>{c.title}</Text>
      {given || fam ? <Text style={{ color: '#fff', fontSize: 16 }}>{String(given ?? '')} {String(fam ?? '')}</Text> : null}
      <Text style={{ color: '#ffffffaa', fontSize: 12 }}>{c.format === 'mso_mdoc' ? 'mdoc · ISO 18013-5' : 'SD-JWT VC'}{c.expiresAt ? ` · ${t('w.detail.expires')} ${c.expiresAt.slice(0, 10)}` : ''}</Text>
    </Pressable>
  );
}

export function HomeScreen(p: { credentials: StoredCredential[]; onOpen: (c: StoredCredential) => void; onScan: () => void; onGetId: (m: 'nfc' | 'ocr') => void; onGetDegree: () => void; onProximity: () => void; onSettings: () => void; onHelp: () => void; onHistory: () => void; busy?: boolean }) {
  const { t } = useI18n();
  const { name } = useBrand();
  return (
    <Screen title={name} right={<View style={{ flexDirection: 'row', gap: 18 }}>
      <Pressable onPress={p.onHistory} accessibilityRole="button" accessibilityLabel={t('w.hist.title')} hitSlop={12}><Text style={{ color: '#fff', fontSize: 22 }}>🕘</Text></Pressable>
      <Pressable onPress={p.onHelp} accessibilityRole="button" accessibilityLabel={t('w.tut.replay')} hitSlop={12}><Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>?</Text></Pressable>
      <Pressable onPress={p.onSettings} accessibilityRole="button" accessibilityLabel={t('w.settings.title')} hitSlop={12}><Text style={{ color: '#fff', fontSize: 24 }}>⚙︎</Text></Pressable></View>}>
      {p.credentials.length === 0 ? (
        <Card><H>{t('w.home.emptyTitle')}</H><P muted>{t('w.home.emptyText')}</P></Card>
      ) : p.credentials.map((c) => <CredentialCard key={c.id} c={c} onPress={() => p.onOpen(c)} />)}
      <Button label={t('w.home.scan')} onPress={p.onScan} />
      <Card>
        <H>{t('w.home.add')}</H>
        <Button kind="secondary" label={t('w.home.getIdNfc')} onPress={() => p.onGetId('nfc')} busy={p.busy} />
        <Button kind="secondary" label={t('w.home.getIdOcr')} onPress={() => p.onGetId('ocr')} busy={p.busy} />
        <Button kind="secondary" label={t('w.home.getDegree')} onPress={p.onGetDegree} busy={p.busy} />
      </Card>
      {p.credentials.some((c) => c.format === 'mso_mdoc') ? <Button kind="secondary" label={t('w.home.proximity')} onPress={p.onProximity} /> : null}
    </Screen>
  );
}
