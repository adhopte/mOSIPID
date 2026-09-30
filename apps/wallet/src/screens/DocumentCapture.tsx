import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import { AutoCaptureDetector, AutoCaptureStatus, FrameOcr, MrzData, mrzFromPages, observeFrame } from '@mosipid/core';
import { useI18n, useBrand, Button, Card, ErrorBox, H, P } from '@mosipid/mobile-kit';
import { CaptureCameraView, CapturedStill, captureAvailable } from '../../modules/mosipid-capture';
import { CapturedDocument, PickedDocument, PickedPages, UploadButtons } from './UploadDocument';

export type { CapturedDocument } from './UploadDocument';
export type DocKind = 'passport' | 'id_card';

const STATUS_KEY: Record<AutoCaptureStatus, string> = {
  searching: 'w.cap.searching', too_far: 'w.cap.too_far', hold_still: 'w.cap.hold_still', capture: 'w.cap.captured',
};
const MAX_PAGES = 3;
interface Page { uri: string; text: string; uploaded: boolean }

/**
 * Document capture in the style of the eMRTD wallet:
 *  - Passport: ONE page (the data page, read automatically from its machine-readable zone), plus optional extra pages.
 *  - ID card: TWO sides – front (photo) then back (machine-readable zone read automatically).
 * Every step can also be filled with "Upload image" / "Upload PDF" (a two-page PDF fills both ID-card sides).
 */
export function DocumentCapture({ onDone, onCancel, fixedKind }: { onDone: (d: PickedDocument) => void; onCancel: () => void; fixedKind?: DocKind }) {
  const { t } = useI18n();
  const { theme } = useBrand();
  const [perm, requestPerm] = useCameraPermissions();
  const detector = useRef(new AutoCaptureDetector(3)).current;
  const capturing = useRef(false);
  const lastValid = useRef<FrameOcr | null>(null);
  const [kind, setKind] = useState<DocKind | null>(fixedKind ?? null);
  const [pages, setPages] = useState<Page[]>([]);
  const [combined, setCombined] = useState(false);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<AutoCaptureStatus>('searching');
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => { if (!perm?.granted && perm?.canAskAgain !== false) requestPerm(); }, [perm?.granted]);

  const mrzOf = (list: Page[]): MrzData | null => { const m = mrzFromPages(list.map((p) => p.text).filter(Boolean)); return m?.checksOk ? m : null; };
  const cardComplete = kind === 'id_card' && (combined || pages.length >= 2);
  const done = kind === 'passport' ? pages.length >= 1 && !adding : cardComplete && !adding;
  // the step that must contain the machine-readable zone
  const seeking = !!kind && !done && !adding && (kind === 'passport' ? pages.length === 0 : pages.length === 1 && !combined);
  const step: 'data' | 'front' | 'back' | 'extra' | 'review' =
    done ? 'review' : adding ? 'extra' : kind === 'passport' ? 'data' : pages.length === 0 ? 'front' : 'back';

  useEffect(() => { detector.reset(); capturing.current = false; lastValid.current = null; setStatus('searching'); }, [step, kind]);

  const reset = () => { setPages([]); setCombined(false); setAdding(false); setError(null); };

  /** Add pages from a capture or an upload, enforcing the MRZ rules of the current kind. */
  const addPages = (list: Page[], fromPdf = false) => {
    setError(null);
    if (!kind || !list.length) return;
    if (adding) { setPages((p) => [...p, ...list].slice(0, MAX_PAGES)); setAdding(false); return; }
    if (kind === 'passport') {
      const next = [...pages, ...list].slice(0, MAX_PAGES);
      if (!pages.length && !mrzOf(list.slice(0, 1)) && !mrzOf(list)) { setError(t('w.cap.noMrz')); return; }
      setPages(next);
      return;
    }
    // ID card: front, then back; a one-page PDF is taken to hold both sides
    const next = [...pages, ...list].slice(0, 2);
    const both = next.length >= 2 || (fromPdf && list.length === 1 && !pages.length);
    if (both && !mrzOf(next)) { setError(t('w.cap.noMrzCard')); if (next.length >= 2) setPages(next.slice(0, 1)); return; }
    setPages(next); setCombined(both && next.length < 2);
  };

  const finish = () => {
    const mrz = mrzOf(pages);
    if (!mrz) { setError(t('w.cap.noMrz')); return; }
    onDone({ uris: pages.map((p) => p.uri), ocrText: pages.map((p) => p.text).join('\n'), source: pages.some((p) => p.uploaded) ? 'upload' : 'camera', mrz });
  };

  const onFrame = useCallback((f: FrameOcr) => {
    if (!seeking || capturing.current) return;
    const o = observeFrame(f);
    if (o.mrzValid) lastValid.current = f;
    const s = detector.onFrame(o);
    setStatus(s);
    if (s === 'capture') { capturing.current = true; setNonce((n) => n + 1); }
  }, [seeking]);

  const onCaptured = (still: CapturedStill) => {
    const frame = lastValid.current;
    capturing.current = false;
    if (seeking) {
      const text = [still.text, frame?.text ?? ''].filter(Boolean).join('\n');
      if (!mrzFromPages([still.text, frame?.text ?? ''].filter(Boolean))?.checksOk) { detector.reset(); setError(t('w.cap.readFailed')); return; }
      setFlash(true); setTimeout(() => setFlash(false), 500);
      addPages([{ uri: still.uri, text, uploaded: false }]);
    } else addPages([{ uri: still.uri, text: still.text ?? '', uploaded: false }]);
  };
  const manualCapture = () => { if (!capturing.current) { capturing.current = true; setNonce((n) => n + 1); } };
  const uploaded = (p: PickedPages) => addPages(p.uris.map((uri, i) => ({ uri, text: p.texts[i] ?? '', uploaded: true })), p.pdf);

  // ---------- 1) choose the document type ----------
  if (!kind) {
    return (
      <View style={{ gap: 12 }}>
        <H>{t('w.cap.kind.title')}</H>
        {([['passport', 'w.cap.kind.passport', 'w.cap.kind.passportHint'], ['id_card', 'w.cap.kind.idcard', 'w.cap.kind.idcardHint']] as const).map(([k, a, b]) => (
          <Pressable key={k} onPress={() => setKind(k)} accessibilityRole="button">
            <Card><Text style={{ fontWeight: '800', fontSize: 17, color: theme.text }}>{t(a)}</Text><P muted>{t(b)}</P></Card>
          </Pressable>
        ))}
        <Pressable onPress={onCancel} accessibilityRole="button" style={{ padding: 12 }}><Text style={{ color: theme.muted, textAlign: 'center' }}>{t('w.cancel')}</Text></Pressable>
      </View>
    );
  }

  // ---------- 3) review ----------
  if (step === 'review') {
    const mrz = mrzOf(pages);
    const label = (i: number) => kind === 'id_card' ? (combined ? t('w.cap.bothSides') : i === 0 ? t('w.cap.front') : t('w.cap.back')) : i === 0 ? t('w.cap.dataPage') : `${t('w.cap.extraPage')} ${i}`;
    return (
      <View style={{ gap: 12 }}>
        <H>{t('w.cap.review')}</H>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          {pages.map((p, i) => (
            <View key={p.uri} style={{ width: 150 }}>
              <Image source={{ uri: p.uri }} resizeMode="contain" style={{ width: 150, height: 105, borderRadius: 8, backgroundColor: '#0001' }} />
              <P muted style={{ textAlign: 'center' }}>{label(i)}</P>
            </View>
          ))}
        </View>
        {mrz ? <Card><P muted>{t('w.cap.read')}</P><P style={{ fontWeight: '700' }}>{mrz.givenNames} {mrz.surname}</P><P muted>{mrz.documentNumber}</P></Card> : null}
        <ErrorBox message={error} />
        <Button label={t('w.cap.continue')} onPress={finish} />
        {kind === 'passport' && pages.length < MAX_PAGES ? <Button kind="secondary" label={t('w.cap.addPage')} onPress={() => { setError(null); setAdding(true); }} /> : null}
        <Button kind="secondary" label={t('w.cap.retake')} onPress={reset} />
      </View>
    );
  }

  // ---------- 2) capture / upload the current step ----------
  const tip = step === 'front' ? t('w.cap.frontTip') : step === 'back' ? t('w.cap.backTip') : step === 'extra' ? t('w.cap.extraTip') : kind === 'passport' ? t('w.cap.tip') : t('w.cap.backTip');
  const stepTitle = step === 'front' ? t('w.cap.front') : step === 'back' ? t('w.cap.back') : step === 'extra' ? t('w.cap.extraPage') : t('w.cap.dataPage');
  const ok = seeking && (status === 'hold_still' || status === 'capture');
  return (
    <View style={{ gap: 12 }}>
      <H>{stepTitle}{kind === 'id_card' ? ` · ${step === 'front' ? 1 : 2}/2` : ''}</H>
      {captureAvailable && perm?.granted ? (
        <View style={{ height: 380, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' }}>
          <CaptureCameraView style={{ flex: 1 }} mode="mrz" active={!flash} captureNonce={nonce}
            onFrameText={onFrame} onCaptured={onCaptured}
            onCaptureError={(m) => { capturing.current = false; setError(m); }} />
          <View pointerEvents="none" style={{ position: 'absolute', left: 14, right: 14, top: 40, bottom: 40, borderWidth: 3, borderRadius: 16, borderColor: ok || flash ? theme.ok : '#fff' }} />
          {seeking ? <View pointerEvents="none" style={{ position: 'absolute', left: 26, right: 26, bottom: 54, height: 64, borderWidth: 2, borderStyle: 'dashed', borderRadius: 8, borderColor: ok ? theme.ok : theme.accent }} /> : null}
          {seeking ? (
            <View pointerEvents="none" style={{ position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center' }}>
              <View style={{ backgroundColor: '#000a', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                {flash ? <Text style={{ color: '#4ade80', fontWeight: '800' }}>✓</Text> : <ActivityIndicator size="small" color="#fff" />}
                <Text style={{ color: '#fff', fontWeight: '700' }}>{flash ? t('w.cap.read') : t(STATUS_KEY[status])}</Text>
              </View>
            </View>
          ) : null}
        </View>
      ) : !captureAvailable ? <Card><P muted>{t('w.cap.noNative')}</P></Card>
        : <Card><P>{t('w.scan.permission')}</P><Button label={t('w.scan.grant')} onPress={requestPerm} /></Card>}
      <P muted style={{ textAlign: 'center' }}>{tip}</P>
      <ErrorBox message={error} />
      {captureAvailable ? <Button kind={seeking ? 'secondary' : 'primary'} label={seeking ? t('w.cap.now') : t('w.cap.shoot')} onPress={manualCapture} /> : null}
      <P muted style={{ textAlign: 'center' }}>{t('w.cap.orUpload')}</P>
      <UploadButtons onPages={uploaded} maxPages={step === 'front' || step === 'data' ? 2 : 1} />
      {kind === 'id_card' && step === 'front' ? <P muted style={{ textAlign: 'center' }}>{t('w.cap.cardPdfHint')}</P> : null}
      <Pressable onPress={() => { if (adding) setAdding(false); else if (pages.length) { setPages((p) => p.slice(0, -1)); setCombined(false); } else if (!fixedKind) setKind(null); else onCancel(); }} accessibilityRole="button" style={{ padding: 12 }}>
        <Text style={{ color: theme.muted, textAlign: 'center' }}>{adding || pages.length || !fixedKind ? t('w.cap.backStep') : t('w.cancel')}</Text>
      </Pressable>
    </View>
  );
}
