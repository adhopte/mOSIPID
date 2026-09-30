import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useCameraPermissions } from 'expo-camera';
import { AutoCaptureDetector, AutoCaptureStatus, FrameOcr, MrzData, mrzFromPages, observeFrame } from '@mosipid/core';
import { useI18n, useBrand, Button, Card, ErrorBox, P } from '@mosipid/mobile-kit';
import { CaptureCameraView, CapturedStill, captureAvailable, normalizeImage, recognizeText, renderPdf } from '../../modules/mosipid-capture';

/** A document ready to send: upright JPEG page(s) on disk + the phone's OCR text and the MRZ parsed from it. */
export interface CapturedDocument { uris: string[]; ocrText: string; source: 'camera' | 'upload'; mrz: MrzData }

const STATUS_KEY: Record<AutoCaptureStatus, string> = {
  searching: 'w.cap.searching', too_far: 'w.cap.too_far', hold_still: 'w.cap.hold_still', capture: 'w.cap.captured',
};

/** Pick an image (gallery/files) or a PDF, render/normalise it, OCR it on-device and require a valid MRZ. */
export async function pickDocument(): Promise<CapturedDocument | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'], copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const f = r.assets[0];
  const isPdf = f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name ?? '');
  const pages = isPdf ? await renderPdf(f.uri, 2) : [await normalizeImage(f.uri, 2400)];
  const texts: string[] = [];
  for (const p of pages) texts.push((await recognizeText(p.uri)).text);
  const mrz = mrzFromPages(texts);
  if (!mrz?.checksOk) throw Object.assign(new Error('no_mrz'), { code: 'no_mrz' });
  return { uris: pages.map((p) => p.uri), ocrText: texts.join('\n'), source: 'upload', mrz };
}

/**
 * Seamless document capture: the camera OCRs the live preview on-device (ML Kit); as soon as a check-digit-valid MRZ has
 * been steady for three frames the photo is taken automatically. "Upload image or PDF" is always available.
 */
export function DocumentCapture({ onDone, onCancel }: { onDone: (d: CapturedDocument) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { theme } = useBrand();
  const [perm, requestPerm] = useCameraPermissions();
  const detector = useRef(new AutoCaptureDetector(3)).current;
  const capturing = useRef(false);
  const lastValid = useRef<FrameOcr | null>(null);
  const [status, setStatus] = useState<AutoCaptureStatus>('searching');
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
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

  const upload = async () => {
    setError(null); setBusy(true);
    try { const d = await pickDocument(); if (d) { setFound(d.mrz); setTimeout(() => onDone(d), 500); } }
    catch (e: any) { setError(e?.code === 'no_mrz' || e?.message === 'no_mrz' ? t('w.cap.noMrz') : `${t('w.cap.fileError')} (${e?.message ?? ''})`); }
    finally { setBusy(false); }
  };

  const ok = status === 'hold_still' || status === 'capture' || !!found;
  return (
    <View style={{ gap: 12 }}>
      {captureAvailable && perm?.granted ? (
        <View style={{ height: 420, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' }}>
          <CaptureCameraView style={{ flex: 1 }} mode="mrz" active={!found && !busy} captureNonce={nonce}
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
      {captureAvailable ? <Button kind="secondary" label={t('w.cap.now')} onPress={() => { if (!capturing.current) { capturing.current = true; setNonce((n) => n + 1); } }} disabled={busy || !!found} /> : null}
      <Button kind="secondary" label={busy ? t('w.cap.uploading') : t('w.cap.upload')} onPress={upload} busy={busy} disabled={!captureAvailable || !!found} />
      <Pressable onPress={onCancel} accessibilityRole="button" style={{ padding: 12 }}><Text style={{ color: theme.muted, textAlign: 'center' }}>{t('w.cancel')}</Text></Pressable>
    </View>
  );
}
