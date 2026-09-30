import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, ViewStyle, TextInputProps, Image } from 'react-native';
import { useBrand } from './branding';
import { useI18n } from './i18n';

export function Screen({ title, onBack, children, scroll = true, right }: { title?: string; onBack?: () => void; children: React.ReactNode; scroll?: boolean; right?: React.ReactNode }) {
  const { theme, logo } = useBrand();
  const { t } = useI18n();
  const body = scroll ? <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">{children}</ScrollView> : <View style={{ flex: 1, padding: 16, gap: 12 }}>{children}</View>;
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[s.header, { backgroundColor: theme.secondary }]}>
        {onBack ? <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={t('w.back')} hitSlop={12}><Text style={s.back}>‹</Text></Pressable> : logo ? <Image source={{ uri: logo }} style={s.logo} resizeMode="contain" /> : null}
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        {right}
      </View>
      {body}
    </View>
  );
}

export function Button({ label, onPress, kind = 'primary', disabled, busy }: { label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean }) {
  const { theme } = useBrand();
  const bg = kind === 'primary' ? theme.primary : kind === 'danger' ? theme.danger : 'transparent';
  const fg = kind === 'secondary' ? theme.primary : '#fff';
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button" style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === 'secondary' ? theme.primary : 'transparent', opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '700', fontSize: 16 }}>{label}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { theme } = useBrand();
  return <View style={[s.card, { backgroundColor: theme.surface, borderColor: theme.border }, style]}>{children}</View>;
}

export function H({ children }: { children: React.ReactNode }) {
  const { theme } = useBrand();
  return <Text style={{ color: theme.text, fontSize: 20, fontWeight: '800' }}>{children}</Text>;
}
export function P({ children, muted, style }: { children: React.ReactNode; muted?: boolean; style?: any }) {
  const { theme } = useBrand();
  return <Text style={[{ color: muted ? theme.muted : theme.text, fontSize: 15, lineHeight: 21 }, style]}>{children}</Text>;
}

export function Field(props: TextInputProps & { label: string }) {
  const { theme } = useBrand();
  const { label, ...rest } = props;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.text, fontWeight: '600' }}>{label}</Text>
      <TextInput placeholderTextColor={theme.muted} {...rest} style={[{ borderWidth: 1, borderColor: theme.border, borderRadius: 10, padding: 12, fontSize: 16, color: theme.text, backgroundColor: theme.surface }, props.style]} />
    </View>
  );
}

export function ErrorBox({ message }: { message?: string | null }) {
  const { theme } = useBrand();
  if (!message) return null;
  return <View style={{ backgroundColor: theme.danger + '22', padding: 12, borderRadius: 10 }}><Text style={{ color: theme.danger }}>{message}</Text></View>;
}

const s = StyleSheet.create({
  header: { paddingTop: 48, paddingBottom: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { color: '#fff', fontSize: 18, fontWeight: '800', flex: 1 },
  back: { color: '#fff', fontSize: 34, lineHeight: 34, marginTop: -4 },
  logo: { width: 32, height: 32, borderRadius: 6, backgroundColor: '#fff' },
  btn: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderWidth: 1.5 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 8 },
});
