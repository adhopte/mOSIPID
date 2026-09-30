import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { AuthRequest, Match, StoredCredential, claimsToShare, matchCredentials, resolveAuthorizationRequest, submitResponse, toBase64 } from '@mosipid/core';
import { authenticate } from '../lock';
import { useI18n, Button, Card, ErrorBox, H, P, Screen } from '@mosipid/mobile-kit';

export function fmtValue(v: unknown): string | null {
  if (v instanceof Uint8Array) return null;
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  return String(v);
}
export function ClaimRow({ name, value }: { name: string; value: unknown }) {
  const { t } = useI18n();
  const label = t('claim.' + name);
  if (value instanceof Uint8Array) return <View style={{ gap: 4 }}><P muted>{label}</P><Image source={{ uri: 'data:image/jpeg;base64,' + toBase64(value) }} style={{ width: 72, height: 96, borderRadius: 8 }} /></View>;
  return <View><P muted>{label}</P><P>{fmtValue(value)}</P></View>;
}

export function PresentScreen({ uri, credentials, onClose }: { uri: string; credentials: StoredCredential[]; onClose: () => void }) {
  const { t } = useI18n();
  const [req, setReq] = useState<AuthRequest | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'sending' | 'done' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [redirect, setRedirect] = useState<string | undefined>();

  useEffect(() => {
    (async () => {
      try { const r = await resolveAuthorizationRequest(uri); setReq(r); setMatches(matchCredentials(r, credentials)); setState('ready'); }
      catch (e: any) { setError(e.message); setState('error'); }
    })();
  }, [uri]);

  const share = async () => {
    if (!req) return;
    if (!(await authenticate(t('w.present.confirmAuth')))) return;
    setState('sending');
    try { const r = await submitResponse(req, matches); setRedirect(r.redirect_uri); setState('done'); }
    catch (e: any) { setError(e.message); setState('error'); }
  };
  const anyMissing = matches.some((m) => !m.available);

  return (
    <Screen title={t('w.present.title')} onBack={onClose}>
      {state === 'loading' && <ActivityIndicator />}
      {state === 'ready' && req && (
        <>
          <Card><P muted>{t('w.present.wants')}</P><H>{req.verifierName ?? req.clientId.replace(/^redirect_uri:/, '')}</H></Card>
          {matches.map((m) => (
            <Card key={m.item.id}>
              {m.available ? (<><P muted>{m.credential.title}</P>{claimsToShare(m).map((c) => <ClaimRow key={c.name} name={c.name} value={c.value} />)}</>)
                : <ErrorBox message={t('w.present.noMatch')} />}
            </Card>
          ))}
          <P muted>{t('w.present.consent')}</P>
          <Button label={t('w.present.share')} onPress={share} disabled={anyMissing} />
          <Button kind="secondary" label={t('w.present.decline')} onPress={onClose} />
        </>
      )}
      {state === 'sending' && <ActivityIndicator />}
      {state === 'done' && <><Card><H>✓ {t('w.present.sent')}</H></Card><Button label={t('w.ok')} onPress={onClose} />{redirect ? null : null}</>}
      {state === 'error' && <><ErrorBox message={error} /><Button label={t('w.back')} onPress={onClose} /></>}
    </Screen>
  );
}
