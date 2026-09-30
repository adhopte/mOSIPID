import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { Button, H, P, useBrand, useI18n } from '@mosipid/mobile-kit';
import { SecuritySettings, biometricPrompt, loadSecurity, lockedForMs, verifyPin } from './security';
import { authenticate } from './lock';
import { logEvent } from './history';
import { PinPad } from './screens/PinPad';

interface Ctx { settings: SecuritySettings; refresh: () => Promise<SecuritySettings>; confirm: (reason: string) => Promise<boolean> }
const C = createContext<Ctx>(null as any);
export const useSecurity = () => useContext(C);

/** Wallet PIN and/or phone-biometric challenge. Used for the start-up lock and before anything is shared. */
export function UnlockPanel({ reason, settings, onSuccess, onCancel }: { reason: string; settings: SecuritySettings; onSuccess: () => void; onCancel?: () => void }) {
  const { t } = useI18n();
  const { theme } = useBrand();
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);

  const bio = useCallback(async () => {
    if (await biometricPrompt(reason, settings.pin ? t('w.sec.usePin') : t('w.cancel'), !settings.pin)) onSuccess();
  }, [reason, settings.pin]);
  useEffect(() => {
    if (settings.bio && !asked.current) { asked.current = true; void bio(); }
    lockedForMs().then((ms) => { if (ms > 0) setError(t('w.sec.locked', { s: Math.ceil(ms / 1000) })); });
  }, []);

  if (!settings.pin) {
    return (
      <View style={{ gap: 14, alignItems: 'center', padding: 8 }}>
        <H>{t('w.lock.title')}</H><P muted style={{ textAlign: 'center' }}>{reason}</P>
        <Button label={t('w.lock.unlock')} onPress={bio} />
        {onCancel ? <Text style={{ color: theme.muted, padding: 10 }} onPress={onCancel}>{t('w.cancel')}</Text> : null}
      </View>
    );
  }
  return (
    <PinPad title={t('w.sec.enterPin')} subtitle={reason} error={error} onCancel={onCancel} onBio={settings.bio ? bio : undefined}
      onComplete={async (pin) => {
        const r = await verifyPin(pin);
        if (r.ok) { onSuccess(); return null; }
        void logEvent({ type: 'security', title: 'pin_failed' });
        return r.lockedMs > 0 ? t('w.sec.locked', { s: Math.ceil(r.lockedMs / 1000) }) : t('w.sec.wrongPin', { n: r.left });
      }} />
  );
}

export function SecurityProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useBrand();
  const [settings, setSettings] = useState<SecuritySettings>({ pin: false, bio: false, lockOnStart: false, bioAvailable: false });
  const [ask, setAsk] = useState<{ reason: string; resolve: (ok: boolean) => void } | null>(null);
  const ref = useRef(settings);
  ref.current = settings;

  const refresh = useCallback(async () => { const s = await loadSecurity(); setSettings(s); ref.current = s; return s; }, []);
  useEffect(() => { void refresh(); }, []);

  const confirm = useCallback(async (reason: string) => {
    const s = await loadSecurity();
    if (!s.pin && !s.bio) return authenticate(reason); // nothing set up in the wallet: fall back to the phone's own screen lock
    return new Promise<boolean>((resolve) => { setSettings(s); setAsk({ reason, resolve }); });
  }, []);
  const close = (ok: boolean) => { ask?.resolve(ok); setAsk(null); };

  return (
    <C.Provider value={{ settings, refresh, confirm }}>
      {children}
      <Modal visible={!!ask} animationType="slide" onRequestClose={() => close(false)}>
        <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center', padding: 20 }}>
          {ask ? <UnlockPanel reason={ask.reason} settings={settings} onSuccess={() => close(true)} onCancel={() => close(false)} /> : null}
        </View>
      </Modal>
    </C.Provider>
  );
}
