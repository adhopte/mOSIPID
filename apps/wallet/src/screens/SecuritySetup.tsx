import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, H, P, Screen, useI18n } from '@mosipid/mobile-kit';
import { PinPad } from './PinPad';
import { PIN_LENGTH, biometricPrompt, loadSecurity, setBioEnabled, setLockOnStart, setPin, verifyPin } from '../security';
import { logEvent } from '../history';
import { useSecurity } from '../SecurityContext';

/** Create or change the wallet PIN, then offer phone biometrics. Used on first launch and from Settings. */
export function SecuritySetup({ onDone, onSkip }: { onDone: () => void; onSkip?: () => void }) {
  const { t } = useI18n();
  const { refresh } = useSecurity();
  const [step, setStep] = useState<'intro' | 'current' | 'create' | 'confirm' | 'bio' | 'done'>('intro');
  const [first, setFirst] = useState('');
  const [hadPin, setHadPin] = useState(false);
  const [bioOk, setBioOk] = useState<boolean | null>(null);

  const start = async () => { const s = await loadSecurity(); setHadPin(s.pin); setStep(s.pin ? 'current' : 'create'); };
  const finishPin = async () => {
    await setLockOnStart(true);
    void logEvent({ type: 'security', title: hadPin ? 'pin_changed' : 'pin_set' });
    const s = await refresh();
    setStep(s.bioAvailable ? 'bio' : 'done');
  };

  return (
    <Screen title={t('w.sec.setupTitle')} onBack={onSkip ?? onDone}>
      {step === 'intro' && (
        <>
          <Card><H>{t('w.sec.introTitle')}</H><P muted>{t('w.sec.introText')}</P></Card>
          <Button label={t('w.sec.create')} onPress={start} />
          {onSkip ? <Button kind="secondary" label={t('w.sec.later')} onPress={onSkip} /> : null}
        </>
      )}
      {step === 'current' && (
        <PinPad title={t('w.sec.currentPin')} onComplete={async (pin) => {
          const r = await verifyPin(pin);
          if (r.ok) { setStep('create'); return null; }
          return r.lockedMs > 0 ? t('w.sec.locked', { s: Math.ceil(r.lockedMs / 1000) }) : t('w.sec.wrongPin', { n: r.left });
        }} />
      )}
      {step === 'create' && <PinPad title={t('w.sec.newPin')} subtitle={t('w.sec.newPinHint', { n: PIN_LENGTH })} onComplete={(pin) => {
        if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return t('w.sec.weak');
        setFirst(pin); setStep('confirm'); return null;
      }} />}
      {step === 'confirm' && <PinPad title={t('w.sec.confirmPin')} onComplete={async (pin) => {
        if (pin !== first) { setStep('create'); return null; }
        await setPin(pin); await finishPin(); return null;
      }} />}
      {step === 'bio' && (
        <>
          <Card><H>{t('w.sec.bioTitle')}</H><P muted>{t('w.sec.bioText')}</P>{bioOk === false ? <P>{t('w.sec.bioFailed')}</P> : null}</Card>
          <Button label={t('w.sec.bioEnable')} onPress={async () => {
            const ok = await biometricPrompt(t('w.sec.bioTitle'), t('w.cancel'), false);
            setBioOk(ok);
            if (ok) { await setBioEnabled(true); void logEvent({ type: 'security', title: 'bio_on' }); await refresh(); setStep('done'); }
          }} />
          <Button kind="secondary" label={t('w.sec.skipBio')} onPress={() => setStep('done')} />
        </>
      )}
      {step === 'done' && (
        <>
          <Card><H>✓ {t('w.sec.ready')}</H><P muted>{t('w.sec.readyText')}</P></Card>
          <View><Button label={t('w.ok')} onPress={onDone} /></View>
        </>
      )}
    </Screen>
  );
}
