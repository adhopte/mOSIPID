import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { AuthRequest, Match, StoredCredential, claimsToShare, matchCredentials, resolveAuthorizationRequest, submitResponse, toBase64 } from '@mosipid/core';
import { useSecurity } from '../SecurityContext';
import { logEvent } from '../history';
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
  const { confirm } = useSecurity();
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
    if (!(await confirm(t('w.present.confirmAuth')))) return;
    setState('sending');
    const who = req.verifierName ?? req.clientId.replace(/^redirect_uri:/, '');
    const claims = [...new Set(matches.filter((m) => m.available).flatMap((m) => claimsToShare(m).map((c) => c.name)))];
    const titles = matches.filter((m) => m.available).map((m) => m.credential.title).join(', ');
    try { const r = await submitResponse(req, matches); setRedirect(r.redirect_uri); setState('done'); void logEvent({ type: 'shared', title: titles, counterparty: who, claims, channel: 'online' }); }
    catch (e: any) { setError(e.message); setState('error'); void logEvent({ type: 'failed', title: titles, counterparty: who, channel: 'online', detail: String(e.message).slice(0, 200) }); }
  };
  const decline = () => { if (req) void logEvent({ type: 'declined', title: matches.map((m) => m.credential?.title).filter(Boolean).join(', '), counterparty: req.verifierName ?? req.clientId.replace(/^redirect_uri:/, ''), channel: 'online' }); onClose(); };
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
          <Button kind="secondary" label={t('w.present.decline')} onPress={decline} />
        </>
      )}
      {state === 'sending' && <ActivityIndicator />}
      {state === 'done' && <><Card><H>✓ {t('w.present.sent')}</H></Card><Button label={t('w.ok')} onPress={onClose} />{redirect ? null : null}</>}
      {state === 'error' && <><ErrorBox message={error} /><Button label={t('w.back')} onPress={onClose} /></>}
    </Screen>
  );
}
