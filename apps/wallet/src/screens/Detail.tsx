import React from 'react';
import { Alert } from 'react-native';
import { StoredCredential, listIssuerSignedClaims, listSdJwtClaims, b64u } from '@mosipid/core';
import { ClaimRow } from './Present';
import { useI18n, Button, Card, H, P, Screen } from '@mosipid/mobile-kit';

export function claimsOf(c: StoredCredential): { name: string; value: unknown }[] {
  try {
    if (c.format === 'mso_mdoc') return Object.values(listIssuerSignedClaims(b64u.decode(c.raw))).flatMap((ns) => Object.entries(ns).map(([name, value]) => ({ name, value })));
    const { visible, disclosable } = listSdJwtClaims(c.raw);
    return Object.entries({ ...disclosable, ...(visible.exp ? { valid_until: new Date((visible.exp as number) * 1000).toISOString().slice(0, 10) } : {}) }).map(([name, value]) => ({ name, value }));
  } catch { return []; }
}

export function DetailScreen({ credential, onClose, onDelete }: { credential: StoredCredential; onClose: () => void; onDelete: () => void }) {
  const { t } = useI18n();
  const confirm = () => Alert.alert(t('w.detail.delete'), t('w.detail.confirmDelete'), [{ text: t('w.cancel'), style: 'cancel' }, { text: t('w.detail.delete'), style: 'destructive', onPress: onDelete }]);
  return (
    <Screen title={credential.title} onBack={onClose}>
      <Card>
        <P muted>{t('w.detail.issuer')}</P><P>{credential.issuerName ?? credential.issuer}</P>
        <P muted>{t('w.detail.format')}</P><P>{credential.format === 'mso_mdoc' ? 'ISO 18013-5 mdoc' : 'SD-JWT VC'}</P>
        {credential.expiresAt ? (<><P muted>{t('w.detail.expires')}</P><P>{credential.expiresAt.slice(0, 10)}</P></>) : null}
      </Card>
      <Card><H>{t('w.detail.claims')}</H>{claimsOf(credential).map((c) => <ClaimRow key={c.name} name={c.name} value={c.value} />)}</Card>
      <Button kind="danger" label={t('w.detail.delete')} onPress={confirm} />
    </Screen>
  );
}
