import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { toBase64 } from '@mosipid/core';
import { useI18n, useBrand, Button, Card, ErrorBox, Field, H, P, Screen } from '@mosipid/mobile-kit';
import { DocumentAutoCapture } from './Capture';
import { DocumentCapture } from './DocumentCapture';
import { PickedDocument, UploadDocument } from './UploadDocument';
import { LivenessCapture, SelfieResult } from './Liveness';
import { captureAvailable, readBase64 } from '../../modules/mosipid-capture';
import { nfcAvailable, openNfcSettings, readChipWithMrz } from '../nfc/reader';

async function post(api: string, path: string, body: unknown) {
  const r = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e: any = new Error(j.error || 'request_failed'); e.code = j.error; e.left = j.attempts_left; throw e; }
  return j;
}

/** Failures that only need a new selfie (the document / chip data is fine). */
const SELFIE_ONLY = new Set(['liveness_failed', 'liveness_missing', 'face_mismatch', 'selfie_no_face', 'selfie_multiple_faces', 'selfie_image_invalid', 'selfie_unusable']);

function Steps({ current, labels }: { current: number; labels: string[] }) {
  const { theme } = useBrand();
  return (
    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
      {labels.map((l, i) => (
        <View key={l} style={{ flex: 1, gap: 4 }}>
          <View style={{ height: 5, borderRadius: 3, backgroundColor: i <= current ? theme.primary : theme.border }} />
          <Text style={{ fontSize: 12, fontWeight: i === current ? '800' : '500', color: i <= current ? theme.text : theme.muted }}>{i + 1}. {l}</Text>
        </View>
      ))}
    </View>
  );
}

const errText = (t: (k: string) => string, code?: string) => (code && t('err.' + code) !== 'err.' + code ? t('err.' + code) : t('err.generic'));

/** Optical path: document (auto-capture or upload of image/PDF) → liveness selfie → issuer checks MRZ + face match + liveness. */
export function OcrProofing({ sid, api, onVerified, onCancel }: { sid: string; api: string; onVerified: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<PickedDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const labels = [t('w.step.document'), t('w.step.selfie'), t('w.step.verify')];

  const submit = async (s: SelfieResult) => {
    setBusy(true); setErr(null);
    try {
      const payload: Record<string, unknown> = { selfie: s.selfie, turn_left: s.turnLeft, turn_right: s.turnRight, liveness_report: s.report };
      if (doc && 'uris' in doc) { payload.images = await Promise.all(doc.uris.map(readBase64)); payload.ocr_text = doc.ocrText; payload.capture_source = doc.source; }
      else if (doc) { payload.image = doc.fallbackImage; payload.capture_source = doc.uri ? 'upload' : 'camera'; }
      await post(api, `/api/proofing/${sid}/ocr`, payload);
      onVerified();
    } catch (e: any) {
      setErr(errText(t, e.code));
      if (!SELFIE_ONLY.has(e.code)) setDoc(null);
    } finally { setBusy(false); }
  };

  return (
    <Screen title={t('w.ocr.title')} onBack={onCancel}>
      <Steps current={busy ? 2 : doc ? 1 : 0} labels={labels} />
      <ErrorBox message={err} />
      {busy ? <Card><H>{t('w.proof.checking')}</H><P muted>{t('w.proof.checkingHint')}</P></Card>
        : !doc ? (captureAvailable ? <DocumentCapture onDone={setDoc} onCancel={onCancel} />
          : <View style={{ gap: 12 }}>
              <DocumentAutoCapture probe={(image) => post(api, `/api/proofing/${sid}/probe`, { image })} onCaptured={(img) => setDoc({ fallbackImage: img, uri: '' })} />
              <UploadDocument onDone={setDoc} />
            </View>)
        : <LivenessCapture onDone={submit} />}
    </Screen>
  );
}

/** NFC path: MRZ (typed, scanned or read from an uploaded file) → BAC → DG1/DG2/SOD → liveness selfie → passive authentication. */
export function NfcProofing({ sid, api, onVerified, onCancel }: { sid: string; api: string; onVerified: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'mrz' | 'can'>('mrz');
  const [docNo, setDocNo] = useState('');
  const [dob, setDob] = useState('');
  const [exp, setExp] = useState('');
  const [can, setCan] = useState('');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [chip, setChip] = useState<{ dg1: string; dg2: string; sod: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = [t('w.step.chip'), t('w.step.selfie'), t('w.step.verify')];

  const validDates = /^\d{4}-\d{2}-\d{2}$/.test(dob) && /^\d{4}-\d{2}-\d{2}$/.test(exp) && docNo.length >= 6;

  const read = async () => {
    setErr(null);
    const avail = await nfcAvailable();
    if (avail === 'unsupported') return setErr(t('w.nfc.unsupported'));
    if (avail === 'disabled') { openNfcSettings(); return setErr(t('w.nfc.disabled')); }
    setBusy(true);
    try {
      const r = await readChipWithMrz({ documentNumber: docNo.trim().toUpperCase(), birthDate: dob, expiryDate: exp },
        (stage, d, tot) => setProgress(stage + (tot ? ` ${Math.round(((d ?? 0) / tot) * 100)}%` : '')), t('w.nfc.hold'));
      setChip({ dg1: toBase64(r.dg1), dg2: toBase64(r.dg2), sod: toBase64(r.sod) });
    } catch (e: any) { setErr(t('w.nfc.failed') + (e?.message ? ` (${e.message})` : '')); }
    finally { setBusy(false); setProgress(null); }
  };

  const submit = async (s: SelfieResult) => {
    setBusy(true); setErr(null);
    try { await post(api, `/api/proofing/${sid}/nfc`, { ...chip, selfie: s.selfie, turn_left: s.turnLeft, turn_right: s.turnRight, liveness_report: s.report }); onVerified(); }
    catch (e: any) { setErr(errText(t, e.code)); if (!SELFIE_ONLY.has(e.code)) setChip(null); }
    finally { setBusy(false); }
  };

  if (scanning) return (
    <Screen title={t('w.nfc.scanMrz')} onBack={() => setScanning(false)}>
      {captureAvailable
        ? <DocumentCapture onCancel={() => setScanning(false)} onDone={(d) => { if ('mrz' in d) { setDocNo(d.mrz.documentNumber); setDob(d.mrz.birthDate); setExp(d.mrz.expiryDate); } setScanning(false); }} />
        : <DocumentAutoCapture probe={(image) => post(api, `/api/proofing/${sid}/probe`, { image })}
            onCaptured={(_img, m) => { if (m) { setDocNo(m.documentNumber); setDob(m.birthDate); setExp(m.expiryDate); } setScanning(false); }} />}
    </Screen>
  );
  if (chip) return (
    <Screen title={t('w.selfie.title')} onBack={onCancel}>
      <Steps current={busy ? 2 : 1} labels={labels} />
      <ErrorBox message={err} />
      {busy ? <Card><H>{t('w.proof.checking')}</H><P muted>{t('w.proof.checkingHint')}</P></Card> : <LivenessCapture onDone={submit} />}
    </Screen>
  );

  return (
    <Screen title={t('w.nfc.title')} onBack={onCancel}>
      <Steps current={0} labels={labels} />
      <P muted>{t('w.nfc.intro')}</P>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Button kind={mode === 'mrz' ? 'primary' : 'secondary'} label={t('w.nfc.useMrz')} onPress={() => setMode('mrz')} /></View>
        <View style={{ flex: 1 }}><Button kind={mode === 'can' ? 'primary' : 'secondary'} label={t('w.nfc.useCan')} onPress={() => setMode('can')} /></View>
      </View>
      {mode === 'mrz' ? (
        <Card>
          <Button kind="secondary" label={t('w.nfc.scanMrz')} onPress={() => setScanning(true)} />
          <Field label={t('w.nfc.docNo')} value={docNo} onChangeText={setDocNo} autoCapitalize="characters" autoCorrect={false} />
          <Field label={t('w.nfc.dob')} value={dob} onChangeText={setDob} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
          <Field label={t('w.nfc.expiry')} value={exp} onChangeText={setExp} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
        </Card>
      ) : (
        <Card>
          <Field label={t('w.nfc.can')} value={can} onChangeText={setCan} keyboardType="number-pad" maxLength={6} />
          <ErrorBox message={t('w.nfc.canUnsupported')} />
        </Card>
      )}
      <ErrorBox message={err} />
      {progress ? <P muted>{t('w.nfc.reading')} {progress}</P> : null}
      <Button label={t('w.nfc.read')} onPress={read} busy={busy} disabled={mode === 'can' || !validDates} />
    </Screen>
  );
}
