import React, { useEffect, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import {
  resolveOffer, fetchIssuerMetadata, receivePreAuthorized, receiveWithAuthorizationCode, CredentialOffer, IssuerMetadata, StoredCredential,
} from '@mosipid/core';
import { CLIENT_ID, OAUTH_REDIRECT } from '../config';
import { NfcProofing, OcrProofing } from './Proofing';
import { View, ActivityIndicator } from 'react-native';
import { useI18n, Button, Card, ErrorBox, Field, H, P, Screen } from '@mosipid/mobile-kit';

type Step = 'loading' | 'review' | 'pin' | 'proof' | 'working' | 'done' | 'error';
const PRE = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

export function OfferScreen({ uri, onClose, onIssued }: { uri: string; onClose: () => void; onIssued: (c: StoredCredential[]) => void }) {
  const { t, lang } = useI18n();
  const [step, setStep] = useState<Step>('loading');
  const [offer, setOffer] = useState<CredentialOffer | null>(null);
  const [meta, setMeta] = useState<IssuerMetadata | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [proofed, setProofed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const o = await resolveOffer(uri);
        setOffer(o); setMeta(await fetchIssuerMetadata(o.credential_issuer)); setStep('review');
      } catch (e: any) { setError(e.message); setStep('error'); }
    })();
  }, [uri]);

  const pre = offer?.grants?.[PRE];
  const names = (meta && offer?.credential_configuration_ids.map((id) => {
    const d = meta.credential_configurations_supported[id]?.display;
    return (d?.find((x) => x.locale?.startsWith(lang)) ?? d?.[0])?.name ?? id;
  })) ?? [];
  const issuerName = meta?.display?.find((d: any) => d.locale?.startsWith(lang))?.name ?? meta?.display?.[0]?.name ?? offer?.credential_issuer;

  const finish = (c: StoredCredential[]) => { onIssued(c); setStep('done'); };
  const runPre = async (txCode?: string) => {
    setStep('working'); setError(null);
    try { finish(await receivePreAuthorized({ offer: offer!, txCode, clientId: CLIENT_ID, timeoutMs: 180_000 })); }
    catch (e: any) { setError(e.code === 'invalid_grant' ? t('w.offer.badPin') : e.message); setStep(pre?.tx_code ? 'pin' : 'error'); }
  };
  const runAuth = async () => {
    setStep('working'); setError(null);
    try {
      finish(await receiveWithAuthorizationCode({
        offer: offer!, clientId: CLIENT_ID, redirectUri: OAUTH_REDIRECT, language: lang,
        authorize: async (url) => {
          const r = await WebBrowser.openAuthSessionAsync(url, OAUTH_REDIRECT);
          if (r.type !== 'success') throw Object.assign(new Error(t('w.offer.cancelled')), { code: 'cancelled' });
          return r.url;
        },
      }));
    } catch (e: any) { setError(e.message); setStep('error'); }
  };

  const accept = () => {
    if (offer?.x_proofing && !proofed) return setStep('proof');
    if (pre?.tx_code) return setStep('pin');
    if (pre) return void runPre();
    if (offer?.grants?.authorization_code) return void runAuth();
    setError('Unsupported offer'); setStep('error');
  };

  if (step === 'proof' && offer?.x_proofing) {
    const p = offer.x_proofing;
    const done = () => { setProofed(true); void runPre(); };
    return p.method === 'nfc'
      ? <NfcProofing sid={p.session_id} api={p.api} onVerified={done} onCancel={() => setStep('review')} />
      : <OcrProofing sid={p.session_id} api={p.api} onVerified={done} onCancel={() => setStep('review')} />;
  }

  return (
    <Screen title={t('w.offer.title')} onBack={onClose}>
      {step === 'loading' && <ActivityIndicator />}
      {step === 'review' && (
        <>
          <Card><P muted>{t('w.offer.from')}</P><H>{issuerName}</H>{names.map((n) => <P key={n}>• {n}</P>)}</Card>
          {offer?.x_proofing ? <P muted>{t(offer.x_proofing.method === 'nfc' ? 'w.offer.needsNfc' : 'w.offer.needsOcr')}</P> : null}
          <Button label={t('w.offer.accept')} onPress={accept} />
          <Button kind="secondary" label={t('w.offer.decline')} onPress={onClose} />
        </>
      )}
      {step === 'pin' && (
        <Card>
          <H>{t('w.offer.pin')}</H><P muted>{t('w.offer.pinHint')}</P>
          <Field label="PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" maxLength={pre?.tx_code?.length ?? 8} />
          <ErrorBox message={error} />
          <Button label={t('w.offer.continue')} onPress={() => runPre(pin)} disabled={!pin} />
        </Card>
      )}
      {step === 'working' && <Card><ActivityIndicator /><P style={{ textAlign: 'center' }}>{t('w.offer.working')}</P></Card>}
      {step === 'done' && <><Card><H>✓ {t('w.offer.done')}</H>{names.map((n) => <P key={n}>{n}</P>)}</Card><Button label={t('w.ok')} onPress={onClose} /></>}
      {step === 'error' && <><ErrorBox message={error} /><Button label={t('w.back')} onPress={onClose} /></>}
      <View />
    </Screen>
  );
}
