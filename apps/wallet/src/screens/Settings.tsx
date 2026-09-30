import React, { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { LANGUAGES } from '@mosipid/core';
import { isLockEnabled, setLockEnabled, authenticate } from '../lock';
import { useI18n, useServers, useBrand, Button, Card, Field, H, P, Screen } from '@mosipid/mobile-kit';

export function SettingsScreen({ onClose, onTutorial }: { onClose: () => void; onTutorial?: () => void }) {
  const { t, lang, setLang } = useI18n();
  const s = useServers();
  const { theme, name } = useBrand();
  const [lock, setLock] = useState(false);
  const [f, setF] = useState({ adminUrl: s.adminUrl, issuerUrl: s.issuerUrl, verifierUrl: s.verifierUrl });
  useEffect(() => { isLockEnabled().then(setLock); }, []);
  const toggleLock = async (v: boolean) => { if (await authenticate(t('w.lock.title'))) { await setLockEnabled(v); setLock(v); } };
  return (
    <Screen title={t('w.settings.title')} onBack={onClose}>
      <Card>
        <H>{t('w.settings.language')}</H>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {LANGUAGES.map((l) => <Button key={l.code} kind={lang === l.code ? 'primary' : 'secondary'} label={l.label} onPress={() => setLang(l.code)} />)}
        </View>
      </Card>
      {onTutorial ? <Button kind="secondary" label={t('w.tut.replay')} onPress={onTutorial} /> : null}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}><H>{t('w.settings.appLock')}</H><P muted>{t('w.settings.appLockHint')}</P></View>
          <Switch value={lock} onValueChange={toggleLock} trackColor={{ true: theme.primary }} />
        </View>
      </Card>
      <Card>
        <H>{t('w.settings.servers')}</H>
        <Field label={t('w.settings.adminUrl')} value={f.adminUrl} onChangeText={(v) => setF({ ...f, adminUrl: v })} autoCapitalize="none" keyboardType="url" />
        <Field label={t('w.settings.issuerUrl')} value={f.issuerUrl} onChangeText={(v) => setF({ ...f, issuerUrl: v })} autoCapitalize="none" keyboardType="url" />
        <Field label={t('w.settings.verifierUrl')} value={f.verifierUrl} onChangeText={(v) => setF({ ...f, verifierUrl: v })} autoCapitalize="none" keyboardType="url" />
        <Button label={t('w.settings.save')} onPress={() => s.update({ adminUrl: f.adminUrl.replace(/\/$/, ''), issuerUrl: f.issuerUrl.replace(/\/$/, ''), verifierUrl: f.verifierUrl.replace(/\/$/, '') })} />
      </Card>
      <P muted style={{ textAlign: 'center' }}>{name} · v0.1.0 · {t('common.mockNotice')}</P>
    </Screen>
  );
}
