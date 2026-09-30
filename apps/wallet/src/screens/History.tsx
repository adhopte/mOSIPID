import React, { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Button, Card, H, P, Screen, useBrand, useI18n } from '@mosipid/mobile-kit';
import { HistoryEvent, HistoryType, clearHistory, loadHistory } from '../history';

const ICON: Record<HistoryType, string> = { issued: '📥', shared: '📤', declined: '🚫', deleted: '🗑', failed: '⚠️', security: '🔒' };
type Filter = 'all' | 'issued' | 'shared' | 'security';
const FILTERS: Filter[] = ['all', 'issued', 'shared', 'security'];
const matches = (f: Filter, e: HistoryEvent) => f === 'all' || (f === 'issued' ? e.type === 'issued' || e.type === 'deleted' : f === 'shared' ? e.type === 'shared' || e.type === 'declined' : e.type === 'security' || e.type === 'failed');

/** Everything the wallet did: credentials received and removed, data shared (who, what, how), refusals and security changes. */
export function HistoryScreen({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const { theme } = useBrand();
  const [list, setList] = useState<HistoryEvent[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { loadHistory().then(setList); }, []);

  const shown = (list ?? []).filter((e) => matches(filter, e));
  const title = (e: HistoryEvent) => (e.type === 'security' ? t('w.hist.sec.' + e.title) : e.title);
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = (iso: string) => new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const clear = () => Alert.alert(t('w.hist.clear'), t('w.hist.clearConfirm'), [{ text: t('w.cancel'), style: 'cancel' }, { text: t('w.hist.clear'), style: 'destructive', onPress: () => clearHistory().then(() => setList([])) }]);

  let lastDay = '';
  return (
    <Screen title={t('w.hist.title')} onBack={onClose}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => <Button key={f} kind={filter === f ? 'primary' : 'secondary'} label={t('w.hist.f.' + f)} onPress={() => setFilter(f)} />)}
      </View>
      {list && !shown.length ? <Card><H>{t('w.hist.emptyTitle')}</H><P muted>{t('w.hist.emptyText')}</P></Card> : null}
      {shown.map((e) => {
        const d = day(e.ts); const header = d !== lastDay; lastDay = d;
        const expanded = open === e.id;
        return (
          <View key={e.id} style={{ gap: 8 }}>
            {header ? <Text style={{ color: theme.muted, fontWeight: '700', marginTop: 6 }}>{d}</Text> : null}
            <Pressable onPress={() => setOpen(expanded ? null : e.id)} accessibilityRole="button">
              <Card>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 26 }}>{ICON[e.type]}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.text, fontWeight: '800', fontSize: 16 }}>{t('w.hist.t.' + e.type)}</Text>
                    <Text style={{ color: theme.muted }} numberOfLines={expanded ? undefined : 1}>{title(e)}{e.counterparty ? ` · ${e.counterparty}` : ''}</Text>
                  </View>
                  <Text style={{ color: theme.muted }}>{time(e.ts)}</Text>
                </View>
                {expanded ? (
                  <View style={{ gap: 4, marginTop: 6 }}>
                    {e.channel ? <P muted>{t('w.hist.channel')}: {t('w.hist.ch.' + e.channel)}</P> : null}
                    {e.claims?.length ? <><P muted>{t('w.hist.data')}</P>{e.claims.map((c) => <P key={c}>• {t('claim.' + c)}</P>)}</> : null}
                    {e.detail ? <P muted>{e.detail}</P> : null}
                  </View>
                ) : null}
              </Card>
            </Pressable>
          </View>
        );
      })}
      {list?.length ? <Button kind="danger" label={t('w.hist.clear')} onPress={clear} /> : null}
    </Screen>
  );
}
