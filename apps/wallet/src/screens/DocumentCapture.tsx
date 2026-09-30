import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import { AutoCaptureDetector, AutoCaptureStatus, FrameOcr, MrzData, mrzFromPages, observeFrame } from '@mosipid/core';
import { useI18n, useBrand, Button, Card, ErrorBox, P } from '@mosipid/mobile-kit';
import { CaptureCameraView, CapturedStill, captureAvailable } from '../../modules/mosipid-capture';
import { CapturedDocument, PickedDocument, UploadDocument } from './UploadDocument';

export type { CapturedDocument } from './UploadDocument';

const STATUS_KEY: Record<AutoCaptureStatus, string> = {
  searching: 'w.cap.searching', too_far: 'w.cap.too_far', hold_still: 'w.cap.hold_still', capture: 'w.cap.captured',
};

/**
 * Seamless document capture: the camera OCRs the live preview on-device (ML Kit); as soon as a check-digit-valid MRZ has
 * been steady for three frames the photo is taken automatically. "Upload image or PDF" is always available.
 */
export function DocumentCapture({ onDone, onCancel }: { onDone: (d: PickedDocument) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { theme } = useBrand();
  const [perm, requestPerm] = useCameraPermissions();
  const detector = useRef(new AutoCaptureDetector(3)).current;
  const capturing = useRef(false);
  const lastValid = useRef<FrameOcr | null>(null);
  const [status, setStatus] = useState<AutoCaptureStatus>('searching');
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<MrzData | null>(null);

  useEffect(() => { if (!perm?.granted && perm?.canAskAgain !== false) requestPerm(); }, [perm?.granted]);

  const finish = useCallback((still: CapturedStill | null, frame: FrameOcr | null) => {
    const mrz = mrzFromPages([still?.text ?? '', frame?.text ?? ''].filter(Boolean));
    if (!mrz?.checksOk || !still) { capturing.current = false; detector.reset(); setError(t('w.cap.readFailed')); return; }
    setFound(mrz);
    setTimeout(() => onDone({ uris: [still.uri], ocrText: still.text + '\n' + (frame?.text ?? ''), source: 'camera', mrz }), 700);
  }, [onDone, t]);

  const onFrame = useCallback((f: FrameOcr) => {
    if (capturing.current) return;
    const o = observeFrame(f);
    if (o.mrzValid) lastValid.current = f;
    const s = detector.onFrame(o);
    setStatus(s);
    if (s === 'capture') { capturing.current = true; setNonce((n) => n + 1); }
  }, []);

  const ok = status === 'hold_still' || status === 'capture' || !!found;
  return (
    <View style={{ gap: 12 }}>
      {captureAvailable && perm?.granted ? (
        <View style={{ height: 420, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' }}>
          <CaptureCameraView style={{ flex: 1 }} mode="mrz" active={!found} captureNonce={nonce}
            onFrameText={onFrame} onCaptured={(s) => finish(s, lastValid.current)}
            onCaptureError={(m) => { capturing.current = false; setError(m); }} />
          {/* guide: the document frame and, at the bottom, where the MRZ lines should sit */}
          <View pointerEvents="none" style={{ position: 'absolute', left: 14, right: 14, top: 40, bottom: 40, borderWidth: 3, borderRadius: 16, borderColor: ok ? theme.ok : '#fff' }} />
          <View pointerEvents="none" style={{ position: 'absolute', left: 26, right: 26, bottom: 54, height: 64, borderWidth: 2, borderStyle: 'dashed', borderRadius: 8, borderColor: ok ? theme.ok : theme.accent }} />
          <View pointerEvents="none" style={{ position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center' }}>
            <View style={{ backgroundColor: '#000a', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              {found ? <Text style={{ color: '#4ade80', fontWeight: '800' }}>✓</Text> : <ActivityIndicator size="small" color="#fff" />}
              <Text style={{ color: '#fff', fontWeight: '700' }}>{found ? t('w.cap.read') : t(STATUS_KEY[status])}</Text>
            </View>
          </View>
        </View>
      ) : !captureAvailable ? <Card><P muted>{t('w.cap.noNative')}</P></Card>
        : <Card><P>{t('w.scan.permission')}</P><Button label={t('w.scan.grant')} onPress={requestPerm} /></Card>}
      <P muted style={{ textAlign: 'center' }}>{t('w.cap.tip')}</P>
      <ErrorBox message={error} />
      {found ? <Card><P muted>{t('w.cap.read')}</P><P style={{ fontWeight: '700' }}>{found.givenNames} {found.surname}</P><P muted>{found.documentNumber}</P></Card> : null}
      {captureAvailable ? <Button kind="secondary" label={t('w.cap.now')} onPress={() => { if (!capturing.current) { capturing.current = true; setNonce((n) => n + 1); } }} disabled={!!found} /> : null}
      {!found ? <UploadDocument onDone={onDone} /> : null}
      <Pressable onPress={onCancel} accessibilityRole="button" style={{ padding: 12 }}><Text style={{ color: theme.muted, textAlign: 'center' }}>{t('w.cancel')}</Text></Pressable>
    </View>
  );
}
