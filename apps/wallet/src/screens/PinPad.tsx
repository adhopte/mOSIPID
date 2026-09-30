import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useBrand, useI18n, H, P } from '@mosipid/mobile-kit';
import { PIN_LENGTH } from '../security';

/** Six-digit PIN pad. `onComplete` returns an error message (shake + clear) or null to accept. */
export function PinPad({ title, subtitle, onComplete, onBio, onCancel, error }: {
  title: string; subtitle?: string; onComplete: (pin: string) => Promise<string | null> | string | null; onBio?: () => void; onCancel?: () => void; error?: string | null;
}) {
  const { theme } = useBrand();
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMsg(error ?? null); }, [error]);

  const press = async (d: string) => {
    if (busy || pin.length >= PIN_LENGTH) return;
    const next = pin + d;
    setPin(next); setMsg(null);
    if (next.length === PIN_LENGTH) {
      setBusy(true);
      const err = await onComplete(next);
      setBusy(false);
      if (err) { setMsg(err); setPin(''); }
    }
  };
  const key = (label: string, onPress?: () => void, a11y?: string) => (
    <Pressable key={label + (a11y ?? '')} onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={a11y ?? label}
      style={({ pressed }) => ({ width: 78, height: 62, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: onPress ? (pressed ? theme.border : theme.surface) : 'transparent', borderWidth: onPress ? 1 : 0, borderColor: theme.border })}>
      <Text style={{ color: theme.text, fontSize: 24, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ alignItems: 'center', gap: 14, paddingVertical: 12 }}>
      <H>{title}</H>
      {subtitle ? <P muted style={{ textAlign: 'center' }}>{subtitle}</P> : null}
      <View style={{ flexDirection: 'row', gap: 14, marginVertical: 8 }}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <View key={i} style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: msg ? theme.danger : theme.primary, backgroundColor: i < pin.length ? (msg ? theme.danger : theme.primary) : 'transparent' }} />
        ))}
      </View>
      <Text style={{ color: theme.danger, minHeight: 20, textAlign: 'center' }}>{msg ?? ' '}</Text>
      {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map((row) => (
        <View key={row.join('')} style={{ flexDirection: 'row', gap: 12 }}>{row.map((d) => key(d, () => press(d)))}</View>
      ))}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {onBio ? key('☝', onBio, t('w.sec.useBio')) : key(' ')}
        {key('0', () => press('0'))}
        {key('⌫', () => setPin((p) => p.slice(0, -1)), t('w.sec.delete'))}
      </View>
      {onCancel ? <Pressable onPress={onCancel} accessibilityRole="button" style={{ padding: 12 }}><Text style={{ color: theme.muted }}>{t('w.cancel')}</Text></Pressable> : null}
    </View>
  );
}
