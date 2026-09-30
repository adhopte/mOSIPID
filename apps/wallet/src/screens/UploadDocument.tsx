import React, { useState } from 'react';
import { Image, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { MrzData, mrzFromPages } from '@mosipid/core';
import { useI18n, Button, Card, ErrorBox, H, P } from '@mosipid/mobile-kit';
import { captureAvailable, normalizeImage, recognizeText, renderPdf } from '../../modules/mosipid-capture';

/** A document ready to send: upright JPEG page(s) on disk + the phone's OCR text and the MRZ parsed from it. */
export interface CapturedDocument { uris: string[]; ocrText: string; source: 'camera' | 'upload'; mrz: MrzData }
/** Upload result when the native module is missing: the raw image as base64 (the issuer does the OCR). */
export interface FallbackDocument { fallbackImage: string; uri: string }
export type PickedDocument = CapturedDocument | FallbackDocument;

const asBase64 = async (uri: string): Promise<string> => {
  const blob = await (await fetch(uri)).blob();
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('read_failed'));
    r.readAsDataURL(blob);
  });
};

export interface PickedPages { uris: string[]; texts: string[]; pdf: boolean }

/** Pick an image or PDF and return its page(s) (PDF: up to `maxPages`) with on-device OCR text. Native module required. */
export async function pickPages(kind: 'image' | 'pdf', maxPages = 2): Promise<PickedPages | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: kind === 'pdf' ? ['application/pdf'] : ['image/*'], copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const f = r.assets[0];
  const isPdf = kind === 'pdf' || f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name ?? '');
  const pages = isPdf ? await renderPdf(f.uri, maxPages) : [await normalizeImage(f.uri, 2400)];
  const texts: string[] = [];
  for (const p of pages) texts.push((await recognizeText(p.uri)).text);
  return { uris: pages.map((p) => p.uri), texts, pdf: isPdf };
}

/** Upload image / Upload PDF buttons that hand back the picked pages (no review UI, no MRZ requirement). */
export function UploadButtons({ onPages, disabled, maxPages = 2 }: { onPages: (p: PickedPages) => void; disabled?: boolean; maxPages?: number }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'image' | 'pdf' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (kind: 'image' | 'pdf') => {
    setError(null); setBusy(kind);
    try { const p = await pickPages(kind, maxPages); if (p) onPages(p); }
    catch (e: any) { setError(`${t('w.cap.fileError')} (${e?.message ?? ''})`); }
    finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 10 }}>
      <Button kind="secondary" label={busy === 'image' ? t('w.cap.uploading') : t('w.cap.uploadImage')} onPress={() => pick('image')} busy={busy === 'image'} disabled={disabled || !!busy} />
      <Button kind="secondary" label={busy === 'pdf' ? t('w.cap.uploading') : t('w.cap.uploadPdf')} onPress={() => pick('pdf')} busy={busy === 'pdf'} disabled={disabled || !!busy} />
      <ErrorBox message={error} />
    </View>
  );
}

/** Pick an image (gallery / files) or a PDF; with the native module it is normalised, OCR-ed on-device and must hold a valid MRZ. */
export async function pickDocument(kind: 'image' | 'pdf'): Promise<PickedDocument | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: kind === 'pdf' ? ['application/pdf'] : ['image/*'], copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const f = r.assets[0];
  const isPdf = kind === 'pdf' || f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name ?? '');
  if (!captureAvailable) {
    if (isPdf) throw Object.assign(new Error('pdf_unsupported'), { code: 'pdf_unsupported' });
    return { fallbackImage: await asBase64(f.uri), uri: f.uri };
  }
  const pages = isPdf ? await renderPdf(f.uri, 2) : [await normalizeImage(f.uri, 2400)];
  const texts: string[] = [];
  for (const p of pages) texts.push((await recognizeText(p.uri)).text);
  const mrz = mrzFromPages(texts);
  if (!mrz?.checksOk) throw Object.assign(new Error('no_mrz'), { code: 'no_mrz' });
  return { uris: pages.map((p) => p.uri), ocrText: texts.join('\n'), source: 'upload', mrz };
}

/**
 * Always-visible "Upload image" / "Upload PDF" buttons. After a file is chosen the pages are shown for review with
 * "Use this document" / "Choose another" (independent of the camera permission or the native capture module).
 */
export function UploadDocument({ onDone }: { onDone: (d: PickedDocument) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'image' | 'pdf' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedDocument | null>(null);

  const pick = async (kind: 'image' | 'pdf') => {
    setError(null); setBusy(kind);
    try { const d = await pickDocument(kind); if (d) setPicked(d); }
    catch (e: any) {
      const c = e?.code ?? e?.message;
      setError(c === 'no_mrz' ? t('w.cap.noMrz') : c === 'pdf_unsupported' ? t('w.cap.pdfUnsupported') : `${t('w.cap.fileError')} (${e?.message ?? ''})`);
    } finally { setBusy(null); }
  };

  if (picked) {
    const uris = 'uris' in picked ? picked.uris : [picked.uri];
    return (
      <Card>
        <H>{t('w.cap.review')}</H>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          {uris.map((u) => <Image key={u} source={{ uri: u }} resizeMode="contain" style={{ width: 150, height: 105, borderRadius: 8, backgroundColor: '#0001' }} />)}
        </View>
        {'mrz' in picked ? <P muted>{picked.mrz.givenNames} {picked.mrz.surname} · {picked.mrz.documentNumber}</P> : null}
        <Button label={t('w.cap.useThis')} onPress={() => onDone(picked)} />
        <Button kind="secondary" label={t('w.cap.another')} onPress={() => { setPicked(null); setError(null); }} />
      </Card>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      <P muted style={{ textAlign: 'center' }}>{t('w.cap.orUpload')}</P>
      <Button kind="secondary" label={busy === 'image' ? t('w.cap.uploading') : t('w.cap.uploadImage')} onPress={() => pick('image')} busy={busy === 'image'} disabled={!!busy} />
      <Button kind="secondary" label={busy === 'pdf' ? t('w.cap.uploading') : t('w.cap.uploadPdf')} onPress={() => pick('pdf')} busy={busy === 'pdf'} disabled={!!busy} />
      <ErrorBox message={error} />
    </View>
  );
}
