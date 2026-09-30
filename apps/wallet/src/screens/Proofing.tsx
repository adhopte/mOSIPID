import React, { useState } from 'react';
import { View } from 'react-native';
import { toBase64 } from '@mosipid/core';
import { DocumentAutoCapture, SelfieCapture } from './Capture';
import { nfcAvailable, openNfcSettings, readChipWithMrz } from '../nfc/reader';
import { useI18n, Button, Card, ErrorBox, Field, H, P, Screen } from '@mosipid/mobile-kit';

async function post(api: string, path: string, body: unknown) {
  const r = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e: any = new Error(j.error || 'request_failed'); e.code = j.error; e.left = j.attempts_left; throw e; }
  return j;
}

/** Optical path: auto-capture document (server OCR of the MRZ) → live selfie → face match on the issuer. */
export function OcrProofing({ sid, api, onVerified, onCancel }: { sid: string; api: string; onVerified: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (selfie: { selfie: string; frames: string[] }) => {
    setBusy(true); setErr(null);
    try { await post(api, `/api/proofing/${sid}/ocr`, { image: doc, selfie: selfie.selfie, liveness_frames: selfie.frames }); onVerified(); }
    catch (e: any) { setErr(t('err.' + e.code) === 'err.' + e.code ? t('err.generic') : t('err.' + e.code)); setDoc(null); }
    finally { setBusy(false); }
  };
  return (
    <Screen title={t('w.ocr.title')} onBack={onCancel}>
      <ErrorBox message={err} />
      {!doc ? <DocumentAutoCapture probe={(image) => post(api, `/api/proofing/${sid}/probe`, { image })} onCaptured={(img) => setDoc(img)} />
        : busy ? <Card><H>{t('w.proof.checking')}</H></Card> : <SelfieCapture onDone={submit} />}
    </Screen>
  );
}

/** NFC path: MRZ (typed or scanned) → BAC → read DG1/DG2/SOD → live selfie → passive authentication on the issuer. */
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

  const validDates = /^\d{4}-\d{2}-\d{2}$/.test(dob) && /^\d{4}-\d{2}-\d{2}$/.test(exp) && docNo.length >= 6;

  const read = async () => {
    setErr(null);
    const avail = await nfcAvailable();
    if (avail === 'unsupported') return setErr(t('w.nfc.unsupported'));
    if (avail === 'disabled') { openNfcSettings(); return setErr(t('w.nfc.disabled')); }
    setBusy(true);
    try {
      const r = await readChipWithMrz({ documentNumber: docNo.trim().toUpperCase(), birthDate: dob, expiryDate: exp }, (stage, d, tot) => setProgress(stage + (tot ? ` ${Math.round(((d ?? 0) / tot) * 100)}%` : '')), t('w.nfc.hold'));
      setChip({ dg1: toBase64(r.dg1), dg2: toBase64(r.dg2), sod: toBase64(r.sod) });
    } catch (e: any) { setErr(t('w.nfc.failed') + (e?.message ? ` (${e.message})` : '')); }
    finally { setBusy(false); setProgress(null); }
  };

  const submit = async (s: { selfie: string; frames: string[] }) => {
    setBusy(true); setErr(null);
    try { await post(api, `/api/proofing/${sid}/nfc`, { ...chip, selfie: s.selfie, liveness_frames: s.frames }); onVerified(); }
    catch (e: any) { setErr(t('err.' + e.code) === 'err.' + e.code ? t('err.generic') : t('err.' + e.code)); setChip(null); }
    finally { setBusy(false); }
  };

  if (scanning) return (
    <Screen title={t('w.nfc.scanMrz')} onBack={() => setScanning(false)}>
      <DocumentAutoCapture probe={(image) => post(api, `/api/proofing/${sid}/probe`, { image })}
        onCaptured={(_img, m) => { if (m) { setDocNo(m.documentNumber); setDob(m.birthDate); setExp(m.expiryDate); } setScanning(false); }} />
    </Screen>
  );
  if (chip) return <Screen title={t('w.selfie.title')} onBack={onCancel}><ErrorBox message={err} />{busy ? <Card><H>{t('w.proof.checking')}</H></Card> : <SelfieCapture onDone={submit} />}</Screen>;

  return (
    <Screen title={t('w.nfc.title')} onBack={onCancel}>
      <P muted>{t('w.nfc.intro')}</P>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Button kind={mode === 'mrz' ? 'primary' : 'secondary'} label={t('w.nfc.useMrz')} onPress={() => setMode('mrz')} /></View>
        <View style={{ flex: 1 }}><Button kind={mode === 'can' ? 'primary' : 'secondary'} label={t('w.nfc.useCan')} onPress={() => setMode('can')} /></View>
      </View>
      {mode === 'mrz' ? (
        <Card>
          <Field label={t('w.nfc.docNo')} value={docNo} onChangeText={setDocNo} autoCapitalize="characters" autoCorrect={false} />
          <Field label={t('w.nfc.dob')} value={dob} onChangeText={setDob} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
          <Field label={t('w.nfc.expiry')} value={exp} onChangeText={setExp} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
          <Button kind="secondary" label={t('w.nfc.scanMrz')} onPress={() => setScanning(true)} />
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
