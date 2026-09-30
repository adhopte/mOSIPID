import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { HolderProximity, ProximityRequest, StoredCredential } from '@mosipid/core';
import { authenticate } from '../lock';
import { useI18n, useServers, Button, Card, ErrorBox, H, P, Screen, QrCode } from '@mosipid/mobile-kit';

/** Holder side of the ISO 18013-5 flow: show the device-engagement QR, get asked, approve, respond. */
export function ProximityScreen({ credentials, onClose }: { credentials: StoredCredential[]; onClose: () => void }) {
  const { t } = useI18n();
  const { verifierUrl } = useServers();
  const holder = useRef<HolderProximity | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [asked, setAsked] = useState<ProximityRequest | null>(null);
  const [state, setState] = useState<'starting' | 'waiting' | 'asked' | 'done' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const h = await HolderProximity.start(verifierUrl);
        holder.current = h; if (!alive) return;
        setQr(h.qr); setState('waiting');
        const req = await h.waitForRequest(240_000);
        if (alive) { setAsked(req); setState('asked'); }
      } catch (e: any) { if (alive) { setError(e.message); setState('error'); } }
    })();
    return () => { alive = false; };
  }, []);

  const approve = async () => {
    if (!asked || !holder.current) return;
    if (!(await authenticate(t('w.present.confirmAuth')))) return;
    try {
      if (asked.sdjwt) {
        const cred = credentials.find((c) => c.format === 'dc+sd-jwt' && c.vct === asked.sdjwt!.vct);
        if (!cred) { setError(t('w.present.noMatch')); setState('error'); return; }
        await holder.current.respondSdJwt(cred, asked.sdjwt);
      } else {
        const docs = Object.entries(asked.mdoc).map(([docType, nss]) => ({ credential: credentials.find((c) => c.docType === docType), requested: nss }))
          .filter((d): d is { credential: StoredCredential; requested: Record<string, string[]> } => !!d.credential);
        if (!docs.length) { setError(t('w.present.noMatch')); setState('error'); return; }
        await holder.current.respond(docs);
      }
      setState('done');
    } catch (e: any) { setError(e.message); setState('error'); }
  };
  const decline = async () => { try { await holder.current?.decline(); } catch { /* ignore */ } onClose(); };

  return (
    <Screen title={t('w.prox.title')} onBack={onClose}>
      {state === 'starting' && <ActivityIndicator />}
      {state === 'waiting' && qr && (<><P muted>{t('w.prox.show')}</P><QrCode value={qr} /><P muted style={{ textAlign: 'center' }}>{t('w.prox.waiting')}</P></>)}
      {state === 'asked' && asked && (
        <>
          <Card><H>{t('w.prox.request')}</H>
            {Object.entries(asked.mdoc).map(([doc, nss]) => Object.entries(nss).map(([ns, els]) => els.map((e) => <P key={doc + ns + e}>• {t('claim.' + e)}</P>)))}
            {asked.sdjwt ? asked.sdjwt.claims.map((c) => <P key={c}>• {t('claim.' + c)}</P>) : null}
          </Card>
          <Button label={t('w.present.share')} onPress={approve} />
          <Button kind="secondary" label={t('w.present.decline')} onPress={decline} />
        </>
      )}
      {state === 'done' && <><Card><H>✓ {t('w.present.sent')}</H></Card><Button label={t('w.ok')} onPress={onClose} /></>}
      {state === 'error' && <><ErrorBox message={error} /><Button label={t('w.back')} onPress={onClose} /></>}
    </Screen>
  );
}
