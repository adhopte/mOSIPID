import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useI18n, useBrand, Button, QrCode } from '@mosipid/mobile-kit';

/** One looping 0→1 driver per illustration; every animation below is an interpolation of it (native-driven, cheap). */
function useLoop(ms: number) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [ms]);
  return v;
}
const kf = (v: Animated.Value, input: number[], output: number[]) => v.interpolate({ inputRange: input, outputRange: output, extrapolate: 'clamp' });

function Phone({ children, w = 118, h = 200, tint }: { children?: React.ReactNode; w?: number; h?: number; tint?: string }) {
  const { theme } = useBrand();
  return (
    <View style={{ width: w, height: h, borderRadius: 24, borderWidth: 5, borderColor: theme.dark ? '#cbd5e1' : '#1e293b', backgroundColor: tint ?? theme.surface, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', top: 6, width: 34, height: 5, borderRadius: 3, backgroundColor: theme.dark ? '#cbd5e1' : '#1e293b' }} />
      {children}
    </View>
  );
}

function Passport({ scale = 1 }: { scale?: number }) {
  return (
    <View style={{ width: 150 * scale, height: 104 * scale, borderRadius: 10, backgroundColor: '#14306b', padding: 8 * scale, justifyContent: 'space-between', borderWidth: 2, borderColor: '#e0b34a' }}>
      <View style={{ flexDirection: 'row', gap: 8 * scale }}>
        <View style={{ width: 34 * scale, height: 44 * scale, borderRadius: 4, backgroundColor: '#93c5fd' }} />
        <View style={{ flex: 1, gap: 5 * scale, paddingTop: 4 * scale }}>
          <View style={{ height: 6 * scale, borderRadius: 3, backgroundColor: '#ffffff99', width: '85%' }} />
          <View style={{ height: 6 * scale, borderRadius: 3, backgroundColor: '#ffffff55', width: '60%' }} />
          <View style={{ height: 6 * scale, borderRadius: 3, backgroundColor: '#ffffff55', width: '70%' }} />
        </View>
      </View>
      <View style={{ gap: 3 * scale }}>
        <View style={{ height: 5 * scale, backgroundColor: '#fff', opacity: 0.85, borderRadius: 2 }} />
        <View style={{ height: 5 * scale, backgroundColor: '#fff', opacity: 0.85, borderRadius: 2 }} />
      </View>
    </View>
  );
}

function Badge({ opacity, scale, icon = '✓' }: { opacity: Animated.AnimatedInterpolation<number>; scale: Animated.AnimatedInterpolation<number>; icon?: string }) {
  const { theme } = useBrand();
  return <Animated.View style={{ position: 'absolute', opacity, transform: [{ scale }], width: 54, height: 54, borderRadius: 27, backgroundColor: theme.ok, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 30, fontWeight: '900' }}>{icon}</Text></Animated.View>;
}

// 1 ─ welcome: logo with a soft pulse
function WelcomeArt() {
  const { theme } = useBrand();
  const v = useLoop(2600);
  return (
    <View style={{ height: 230, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: 210, height: 210, borderRadius: 105, backgroundColor: theme.primary, opacity: kf(v, [0, 0.5, 1], [0.12, 0.28, 0.12]), transform: [{ scale: kf(v, [0, 0.5, 1], [0.85, 1.05, 0.85]) }] }} />
      <Animated.Image source={require('../../assets/logo.png')} style={{ width: 170, height: 170, transform: [{ scale: kf(v, [0, 0.5, 1], [1, 1.06, 1]) }] }} resizeMode="contain" />
    </View>
  );
}

// 2 ─ auto-capture: the passport slides into the frame, a scan line sweeps, the app captures by itself
function ScanArt() {
  const v = useLoop(4200);
  return (
    <View style={{ height: 230, alignItems: 'center', justifyContent: 'center' }}>
      <Phone tint="#0b1220">
        <Animated.View style={{ transform: [{ translateX: kf(v, [0, 0.22, 1], [120, 0, 0]) }, { scale: 0.62 }], opacity: kf(v, [0.9, 1], [1, 0]) }}><Passport /></Animated.View>
        <Animated.View style={{ position: 'absolute', left: 8, right: 8, height: 3, backgroundColor: '#22c55e', borderRadius: 2, opacity: kf(v, [0.22, 0.26, 0.6, 0.64], [0, 1, 1, 0]), transform: [{ translateY: kf(v, [0.26, 0.6], [-50, 50]) }] }} />
        <View style={{ position: 'absolute', left: 10, right: 10, top: 34, bottom: 34, borderRadius: 10, borderWidth: 2, borderColor: '#fff6', borderStyle: 'dashed' }} />
        <Badge opacity={kf(v, [0.62, 0.7, 0.9, 0.95], [0, 1, 1, 0])} scale={kf(v, [0.62, 0.72], [0.3, 1])} />
      </Phone>
      <Animated.View style={{ position: 'absolute', right: 26, top: 10, opacity: kf(v, [0, 0.2, 0.9, 1], [0, 1, 1, 0]) }}>
        <View style={{ backgroundColor: '#0008', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 }}><Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>PDF · JPG</Text></View>
      </Animated.View>
    </View>
  );
}

// 3 ─ NFC: rings radiate from the phone towards the passport chip
function NfcArt() {
  const { theme } = useBrand();
  const a = useLoop(2400);
  const ring = (delay: number) => {
    const phase = (x: Animated.Value) => x.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
    void phase;
    return { opacity: kf(a, [delay, delay + 0.35, delay + 0.36, 1], [0.7, 0, 0, 0]), transform: [{ scale: kf(a, [delay, delay + 0.35], [0.4, 1.7]) }] };
  };
  return (
    <View style={{ height: 230, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 }}>
      <View style={{ width: 130, alignItems: 'center', justifyContent: 'center' }}>
        {[0, 0.2, 0.4].map((d) => <Animated.View key={d} style={[{ position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 3, borderColor: theme.primary }, ring(d)]} />)}
        <Phone w={92} h={170} tint={theme.primary + '22'}><Text style={{ fontSize: 34 }}>📶</Text></Phone>
      </View>
      <View style={{ transform: [{ rotate: '-8deg' }] }}>
        <Passport scale={0.95} />
        <View style={{ position: 'absolute', right: 14, bottom: 34, width: 22, height: 22, borderRadius: 4, backgroundColor: '#e0b34a', borderWidth: 2, borderColor: '#fff' }} />
      </View>
    </View>
  );
}

// 4 ─ liveness: blink, turn to both sides, look straight
function FaceArt() {
  const { theme } = useBrand();
  const v = useLoop(6000);
  const x = kf(v, [0, 0.3, 0.42, 0.55, 0.68, 0.8, 0.92, 1], [0, 0, -34, -34, 34, 34, 0, 0]);
  const squash = kf(v, [0, 0.3, 0.42, 0.55, 0.68, 0.8, 0.92, 1], [1, 1, 0.82, 0.82, 0.82, 0.82, 1, 1]);
  const eye = kf(v, [0.12, 0.16, 0.2, 0.22], [1, 0.08, 1, 1]);
  const okOp = kf(v, [0.9, 0.94, 1], [0, 1, 1]);
  const Eye = () => <Animated.View style={{ width: 13, height: 13, borderRadius: 7, backgroundColor: '#0b1220', transform: [{ scaleY: eye }] }} />;
  return (
    <View style={{ height: 230, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 150, height: 196, borderRadius: 75, borderWidth: 5, borderColor: theme.accent, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: theme.surface }}>
        <Animated.View style={{ width: 92, height: 120, borderRadius: 50, backgroundColor: '#f2c7a0', alignItems: 'center', justifyContent: 'center', gap: 18, transform: [{ translateX: x }, { scaleX: squash }] }}>
          <View style={{ flexDirection: 'row', gap: 26 }}><Eye /><Eye /></View>
          <View style={{ width: 30, height: 10, borderBottomWidth: 4, borderColor: '#a24b3b', borderRadius: 12 }} />
        </Animated.View>
        <Animated.View style={{ position: 'absolute', opacity: okOp }}><View style={{ backgroundColor: theme.ok, borderRadius: 22, paddingHorizontal: 12, paddingVertical: 4 }}><Text style={{ color: '#fff', fontWeight: '800' }}>✓</Text></View></Animated.View>
      </View>
      <View style={{ flexDirection: 'row', gap: 70, position: 'absolute', bottom: 2 }}>
        <Animated.Text style={{ fontSize: 26, color: theme.primary, opacity: kf(v, [0.3, 0.42, 0.55], [0.2, 1, 0.2]) }}>⟵</Animated.Text>
        <Animated.Text style={{ fontSize: 26, color: theme.primary, opacity: kf(v, [0.55, 0.68, 0.8], [0.2, 1, 0.2]) }}>⟶</Animated.Text>
      </View>
    </View>
  );
}

// 5 ─ pre-authorised offer: scan the QR, type the PIN
function QrArt() {
  const { theme } = useBrand();
  const v = useLoop(4400);
  const dot = (i: number) => ({ opacity: kf(v, [0.45 + i * 0.1, 0.5 + i * 0.1], [0.15, 1]) });
  return (
    <View style={{ height: 230, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 14 }}>
      <View style={{ padding: 6, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: theme.border }}>
        <QrCode value="openid-credential-offer://?credential_offer_uri=https://bluetiger-inji-issuer.onrender.com/offers/demo" size={120} />
        <Animated.View style={{ position: 'absolute', left: 6, right: 6, height: 3, backgroundColor: theme.primary, transform: [{ translateY: kf(v, [0, 0.4, 1], [6, 120, 120]) }], opacity: kf(v, [0, 0.05, 0.4, 0.45], [0, 1, 1, 0]) }} />
      </View>
      <Phone w={96} h={170} tint={theme.surface}>
        <Text style={{ fontSize: 11, fontWeight: '800', color: theme.text, marginBottom: 10 }}>PIN</Text>
        <View style={{ flexDirection: 'row', gap: 7 }}>{[0, 1, 2, 3].map((i) => <Animated.View key={i} style={[{ width: 13, height: 13, borderRadius: 7, backgroundColor: theme.primary }, dot(i)]} />)}</View>
        <Badge opacity={kf(v, [0.88, 0.93, 1], [0, 1, 1])} scale={kf(v, [0.88, 0.95], [0.3, 0.8])} />
      </Phone>
    </View>
  );
}

// 6 ─ sharing: online (QR / link) or in person (two phones)
function ShareArt() {
  const { theme } = useBrand();
  const v = useLoop(3200);
  return (
    <View style={{ height: 230, alignItems: 'center', justifyContent: 'space-around' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 118, height: 76, borderRadius: 8, borderWidth: 4, borderColor: theme.dark ? '#cbd5e1' : '#1e293b', backgroundColor: theme.surface, alignItems: 'center', justifyContent: 'center' }}><QrCode value="openid4vp://authorize?demo" size={56} /></View>
        <Animated.Text style={{ fontSize: 22, color: theme.primary, transform: [{ translateX: kf(v, [0, 0.5, 1], [-4, 6, -4]) }] }}>⟶</Animated.Text>
        <Phone w={52} h={88}><Text style={{ fontSize: 18 }}>🔗</Text></Phone>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Phone w={62} h={104}><Text style={{ fontSize: 18 }}>🪪</Text></Phone>
        <View style={{ width: 70, alignItems: 'center', justifyContent: 'center' }}>
          {[0, 0.3, 0.6].map((d) => <Animated.View key={d} style={{ position: 'absolute', width: 36, height: 36, borderRadius: 18, borderWidth: 2.5, borderColor: theme.accent, opacity: kf(v, [d, d + 0.3, d + 0.31], [0.9, 0, 0]), transform: [{ scale: kf(v, [d, d + 0.3], [0.3, 1.8]) }] }} />)}
        </View>
        <Phone w={62} h={104}><Text style={{ fontSize: 18 }}>✅</Text></Phone>
      </View>
    </View>
  );
}

// 7 ─ control: choose what to share
function PrivacyArt() {
  const { theme } = useBrand();
  const v = useLoop(5000);
  const row = (label: string, on: [number, number]) => {
    const pos = kf(v, [on[0], on[0] + 0.05, on[1], on[1] + 0.05], [0, 1, 1, 0]);
    return (
      <View key={label} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: 210, paddingVertical: 7 }}>
        <Text style={{ color: theme.text, fontWeight: '600' }}>{label}</Text>
        <Animated.View style={{ width: 44, height: 24, borderRadius: 12, backgroundColor: pos.interpolate({ inputRange: [0, 1], outputRange: [theme.border, theme.ok] }) as any, justifyContent: 'center' }}>
          <Animated.View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff', transform: [{ translateX: pos.interpolate({ inputRange: [0, 1], outputRange: [3, 23] }) }] }} />
        </Animated.View>
      </View>
    );
  };
  return (
    <View style={{ height: 230, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: 44 }}>🛡️</Text>
      <View style={{ marginTop: 8, padding: 10, borderRadius: 14, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border }}>
        {row('Age 18+', [0.05, 0.95])}{row('Name', [0.25, 0.8])}{row('Address', [2, 3])}
      </View>
    </View>
  );
}

const SLIDES = [WelcomeArt, ScanArt, NfcArt, FaceArt, QrArt, ShareArt, PrivacyArt];

export function Tutorial({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { theme } = useBrand();
  const { width } = useWindowDimensions();
  const pager = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const last = index === SLIDES.length - 1;
  const go = (i: number) => { setIndex(i); pager.current?.scrollTo({ x: i * width, animated: true }); };
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: 52 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20 }}>
        <Image source={require('../../assets/logo.png')} style={{ width: 34, height: 34 }} resizeMode="contain" />
        <Pressable onPress={onClose} accessibilityRole="button" hitSlop={12}><Text style={{ color: theme.muted, fontWeight: '700', fontSize: 16 }}>{t('w.tut.skip')}</Text></Pressable>
      </View>
      <ScrollView ref={pager} horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={{ flex: 1 }}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}>
        {SLIDES.map((Art, i) => (
          <View key={i} style={{ width, paddingHorizontal: 24, justifyContent: 'center', gap: 14 }}>
            {Math.abs(i - index) <= 1 ? <Art /> : <View style={{ height: 230 }} />}
            <Text style={{ color: theme.text, fontSize: 24, fontWeight: '800', textAlign: 'center' }}>{t(`w.tut.${i + 1}.title`)}</Text>
            <Text style={{ color: theme.muted, fontSize: 16, lineHeight: 23, textAlign: 'center' }}>{t(`w.tut.${i + 1}.text`)}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 14 }}>
        {SLIDES.map((_, i) => <Pressable key={i} onPress={() => go(i)} hitSlop={8}><View style={{ width: i === index ? 22 : 8, height: 8, borderRadius: 4, backgroundColor: i === index ? theme.primary : theme.border }} /></Pressable>)}
      </View>
      <View style={{ paddingHorizontal: 20, paddingBottom: 28, flexDirection: 'row', gap: 10 }}>
        {index > 0 ? <View style={{ flex: 1 }}><Button kind="secondary" label={t('w.back')} onPress={() => go(index - 1)} /></View> : null}
        <View style={{ flex: 2 }}><Button label={last ? t('w.tut.done') : t('w.tut.next')} onPress={() => (last ? onClose() : go(index + 1))} /></View>
      </View>
    </View>
  );
}
