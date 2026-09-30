import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useBrand, useI18n, Button, P } from '@mosipid/mobile-kit';

function Permission({ onGrant }: { onGrant?: () => void }) {
  const [perm, request] = useCameraPermissions();
  const { t } = useI18n();
  useEffect(() => { if (perm?.granted) onGrant?.(); }, [perm?.granted]);
  if (!perm) return <ActivityIndicator />;
  if (perm.granted) return null;
  return <View style={{ padding: 16, gap: 12 }}><P>{t('w.scan.permission')}</P><Button label={t('w.scan.grant')} onPress={request} /></View>;
}
export function useCamGranted() { const [p] = useCameraPermissions(); return !!p?.granted; }

/** Auto-capture: samples frames, asks the issuer (server-side OCR) whether a valid MRZ is visible, and stops when it is. */
export function DocumentAutoCapture({ probe, onCaptured }: {
  probe: (imageB64: string) => Promise<{ valid: boolean; mrz?: { documentNumber: string; birthDate: string; expiryDate: string } }>;
  onCaptured: (imageB64: string, mrz?: { documentNumber: string; birthDate: string; expiryDate: string }) => void;
}) {
  const { theme } = useBrand();
  const { t } = useI18n();
  const ref = useRef<CameraView>(null);
  const granted = useCamGranted();
  const [tries, setTries] = useState(0);
  const [note, setNote] = useState<string>(t('w.ocr.searching'));
  const done = useRef(false);

  useEffect(() => {
    if (!granted) return;
    let alive = true;
    (async () => {
      await new Promise((r) => setTimeout(r, 1200));
      while (alive && !done.current) {
        try {
          const pic = await ref.current?.takePictureAsync({ base64: true, quality: 0.7, shutterSound: false });
          if (pic?.base64 && alive && !done.current) {
            const r = await probe(pic.base64);
            if (r.valid) { done.current = true; setNote(t('w.ocr.captured')); onCaptured(pic.base64, r.mrz); return; }
            setNote(t('w.ocr.searching'));
          }
        } catch { setNote(t('w.ocr.searching')); }
        if (alive) setTries((n) => n + 1);
        await new Promise((r) => setTimeout(r, 900));
      }
    })();
    return () => { alive = false; };
  }, [granted]);

  const shoot = async () => {
    const pic = await ref.current?.takePictureAsync({ base64: true, quality: 0.8, shutterSound: false });
    if (pic?.base64) { done.current = true; onCaptured(pic.base64); }
  };
  if (!granted) return <Permission />;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ height: 380, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' }}>
        <CameraView ref={ref} style={{ flex: 1 }} facing="back" />
        <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, top: 70, bottom: 70, borderWidth: 3, borderColor: theme.accent, borderRadius: 14 }} />
        <View pointerEvents="none" style={{ position: 'absolute', left: 24, right: 24, bottom: 78, height: 54, borderWidth: 2, borderStyle: 'dashed', borderColor: '#fff', borderRadius: 6 }} />
      </View>
      <P style={{ textAlign: 'center' }}>{t('w.ocr.align')}</P>
      <P muted style={{ textAlign: 'center' }}>{note}{tries > 2 ? ' …' : ''}</P>
      {tries > 4 ? <Button kind="secondary" label={t('w.ocr.manual')} onPress={shoot} /> : null}
    </View>
  );
}

const STEPS = ['w.selfie.straight', 'w.selfie.left', 'w.selfie.right'] as const;

/** Captures a selfie plus two short head-turn frames that the face provider can use for liveness. */
export function SelfieCapture({ onDone }: { onDone: (r: { selfie: string; frames: string[] }) => void }) {
  const { t } = useI18n();
  const { theme } = useBrand();
  const ref = useRef<CameraView>(null);
  const granted = useCamGranted();
  const [step, setStep] = useState(-1);
  const [count, setCount] = useState(0);
  const shots = useRef<string[]>([]);

  const begin = async () => {
    shots.current = [];
    for (let i = 0; i < STEPS.length; i++) {
      setStep(i);
      for (let c = 3; c > 0; c--) { setCount(c); await new Promise((r) => setTimeout(r, 800)); }
      const pic = await ref.current?.takePictureAsync({ base64: true, quality: 0.7, shutterSound: false });
      if (!pic?.base64) throw new Error('capture failed');
      shots.current.push(pic.base64);
    }
    onDone({ selfie: shots.current[0], frames: shots.current });
  };

  if (!granted) return <Permission />;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ height: 420, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' }}>
        <CameraView ref={ref} style={{ flex: 1 }} facing="front" mirror />
        <View pointerEvents="none" style={{ position: 'absolute', left: '15%', right: '15%', top: '10%', bottom: '14%', borderWidth: 3, borderColor: theme.accent, borderRadius: 999 }} />
      </View>
      {step < 0 ? (<><P style={{ textAlign: 'center' }}>{t('w.selfie.hint')}</P><Button label={t('w.selfie.start')} onPress={begin} /></>)
        : <P style={{ textAlign: 'center', fontWeight: '700' }}>{t(STEPS[step])} · {count}</P>}
    </View>
  );
}
