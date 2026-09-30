import React, { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { LANGUAGES } from '@mosipid/core';
import { biometricPrompt, clearPin, setBioEnabled, setLockOnStart } from '../security';
import { useSecurity } from '../SecurityContext';
import { logEvent } from '../history';
import { useI18n, useServers, useBrand, Button, Card, Field, H, P, Screen } from '@mosipid/mobile-kit';

export function SettingsScreen({ onClose, onTutorial, onHistory, onSecurity }: { onClose: () => void; onTutorial?: () => void; onHistory?: () => void; onSecurity?: () => void }) {
  const { t, lang, setLang } = useI18n();
  const s = useServers();
  const { theme, name } = useBrand();
  const sec = useSecurity();
  const st = sec.settings;
  const [f, setF] = useState({ adminUrl: s.adminUrl, issuerUrl: s.issuerUrl, verifierUrl: s.verifierUrl });
  useEffect(() => { void sec.refresh(); }, []);
  const toggleLock = async (v: boolean) => {
    if (v && !st.pin && !st.bio) return onSecurity?.();           // nothing to unlock with yet → set one up first
    if (!(await sec.confirm(t('w.lock.title')))) return;
    await setLockOnStart(v); void logEvent({ type: 'security', title: v ? 'lock_on' : 'lock_off' }); await sec.refresh();
  };
  const toggleBio = async (v: boolean) => {
    if (v && !(await biometricPrompt(t('w.sec.bioTitle'), t('w.cancel'), false))) return;
    if (!v && !(await sec.confirm(t('w.sec.bioOff')))) return;
    await setBioEnabled(v); void logEvent({ type: 'security', title: v ? 'bio_on' : 'bio_off' }); await sec.refresh();
  };
  const removePin = async () => {
    if (!(await sec.confirm(t('w.sec.removePin')))) return;
    await clearPin(); await setBioEnabled(false); await setLockOnStart(false);
    void logEvent({ type: 'security', title: 'pin_removed' }); await sec.refresh();
  };
  return (
    <Screen title={t('w.settings.title')} onBack={onClose}>
      <Card>
        <H>{t('w.settings.language')}</H>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {LANGUAGES.map((l) => <Button key={l.code} kind={lang === l.code ? 'primary' : 'secondary'} label={l.label} onPress={() => setLang(l.code)} />)}
        </View>
      </Card>
      {onTutorial ? <Button kind="secondary" label={t('w.tut.replay')} onPress={onTutorial} /> : null}
      {onHistory ? <Button kind="secondary" label={`🕘 ${t('w.hist.title')}`} onPress={onHistory} /> : null}
      <Card>
        <H>{t('w.sec.title')}</H>
        <P muted>{st.pin ? t('w.sec.pinSet') : t('w.sec.pinNotSet')}</P>
        <Button kind={st.pin ? 'secondary' : 'primary'} label={st.pin ? t('w.sec.changePin') : t('w.sec.create')} onPress={() => onSecurity?.()} />
        {st.pin ? <Button kind="danger" label={t('w.sec.removePin')} onPress={removePin} /> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1 }}><H>{t('w.sec.bioTitle')}</H><P muted>{st.bioAvailable ? t('w.sec.bioHint') : t('w.sec.bioNone')}</P></View>
          <Switch value={st.bio} disabled={!st.bioAvailable} onValueChange={toggleBio} trackColor={{ true: theme.primary }} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1 }}><H>{t('w.settings.appLock')}</H><P muted>{t('w.settings.appLockHint')}</P></View>
          <Switch value={st.lockOnStart} onValueChange={toggleLock} trackColor={{ true: theme.primary }} />
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
