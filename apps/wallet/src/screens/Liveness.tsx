import React, { useState } from 'react';
import { View, Text } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import { useI18n, useBrand, Button, Card, ErrorBox, P } from '@mosipid/mobile-kit';
import { CaptureCameraView, LivenessResult, LivenessUi, captureAvailable, readBase64 } from '../../modules/mosipid-capture';
import { SelfieCapture } from './Capture';

/** What the issuer needs: base64 JPEGs of the frontal selfie and the two head-turn frames, plus the device report. */
export interface SelfieResult { selfie: string; turnLeft?: string; turnRight?: string; report: Record<string, unknown> }

const STEP_KEY: Record<string, string> = {
  center: 'w.live.center', blink: 'w.live.blink', turn: 'w.live.turn', turn_other: 'w.live.turn_other', done: 'w.live.done',
};

/** Active liveness (ML Kit face detection: blink + turn both ways + look straight). Falls back to 3 timed photos without the native module. */
export function LivenessCapture({ onDone }: { onDone: (r: SelfieResult) => void }) {
  const { t } = useI18n();
  const { theme } = useBrand();
  const [started, setStarted] = useState(false);
  const [ui, setUi] = useState<LivenessUi | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [perm, requestPerm] = useCameraPermissions();
  const [simple, setSimple] = useState(false);

  React.useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) requestPerm(); }, [perm?.granted]);

  if (!captureAvailable || simple) {
    return <SelfieCapture onDone={(r) => onDone({ selfie: r.selfie, turnLeft: r.frames[1], turnRight: r.frames[2], report: { method: 'timed_frames' } })} />;
  }

  const complete = async (r: LivenessResult) => {
    try {
      const [selfie, turnLeft, turnRight] = await Promise.all([readBase64(r.selfie), readBase64(r.turnLeft), readBase64(r.turnRight)]);
      onDone({ selfie, turnLeft, turnRight, report: r.report });
    } catch (e: any) { setError(e?.message ?? 'error'); setStarted(false); setAttempt((n) => n + 1); }
  };

  const done = ui?.step === 'done';
  const progress = ui ? ui.completed / ui.total : 0;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ height: 440, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' }}>
        <CaptureCameraView key={attempt} style={{ flex: 1 }} mode="liveness" active={started} onLiveness={setUi} onLivenessComplete={complete}
          onCaptureError={(m) => { setError(/^camera_/.test(m) ? `${t('w.live.cameraError')} (${m})` : m); setStarted(false); }} />
        <View pointerEvents="none" style={{ position: 'absolute', left: '14%', right: '14%', top: '9%', bottom: '15%', borderWidth: 4, borderRadius: 999, borderColor: started && ui?.faceOk ? theme.ok : theme.accent }} />
        {started ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, backgroundColor: '#fff3' }}>
            <View style={{ width: `${Math.round(progress * 100)}%`, height: 6, backgroundColor: theme.ok }} />
          </View>
        ) : null}
      </View>
      {started ? (
        <Card>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>{t(STEP_KEY[ui?.step ?? 'center'])}</Text>
          <P muted style={{ textAlign: 'center' }}>{ui?.hint ? t('w.live.hint.' + ui.hint) : ' '}</P>
        </Card>
      ) : (
        <>
          <P style={{ textAlign: 'center' }}>{t('w.live.intro')}</P>
          {perm?.granted
            ? <Button label={t('w.selfie.start')} onPress={() => { setError(null); setUi(null); setStarted(true); }} />
            : <><P muted style={{ textAlign: 'center' }}>{t('w.scan.permission')}</P><Button label={t('w.scan.grant')} onPress={requestPerm} /></>}
        </>
      )}
      <ErrorBox message={error} />
      {error && !started ? <Button kind="secondary" label={t('w.live.simple')} onPress={() => setSimple(true)} /> : null}
      {done ? <P muted style={{ textAlign: 'center' }}>{t('w.selfie.sending')}</P> : null}
    </View>
  );
}
