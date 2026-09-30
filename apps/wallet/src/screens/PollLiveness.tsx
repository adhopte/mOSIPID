import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { CameraView } from 'expo-camera';
import { useBrand, useI18n, Card, P } from '@mosipid/mobile-kit';
import { analyseFace, frameToJpeg, readBase64 } from '../../modules/mosipid-capture';
import type { SelfieResult } from './Liveness';

type Step = 'turn' | 'turn_other' | 'center';
const STEP_KEY: Record<string, string> = { turn: 'w.live.turn', turn_other: 'w.live.turn_other', center: 'w.live.center', done: 'w.live.done' };
const TURN_DEGREES = 20;

/**
 * Live challenge built on expo-camera's preview (known to open on every phone) plus on-device ML Kit face analysis of rapid stills.
 * Same challenge as the streaming analyzer – turn to both sides, then look straight – with the same hints; a blink cannot be caught
 * reliably at still-photo speed, so it is left out here. The issuer re-checks the frames (same person, real head turn).
 */
export function PollLiveness({ onDone, onFail }: { onDone: (r: SelfieResult) => void; onFail: (m: string) => void }) {
  const { t } = useI18n();
  const { theme } = useBrand();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<Step | 'done'>('turn');
  const [hint, setHint] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    (async () => {
      const started = Date.now();
      let rot = 0, stable = 0, index = 0, firstYaw = 0, errors = 0;
      const order: Step[] = ['turn', 'turn_other', 'center'];
      let turnA: { yaw: number; uri: string } | null = null, turnB: { yaw: number; uri: string } | null = null;
      const show = (h: string | null, good: boolean) => { if (alive) { setHint(h); setOk(good); } };
      while (alive) {
        if (Date.now() - started > 120_000) return onFail('timeout');
        let pic;
        try { pic = await cam.current?.takePictureAsync({ quality: 0.5, skipProcessing: true, shutterSound: false }); }
        catch { if (++errors > 5) return onFail('camera'); continue; }
        if (!pic?.uri || !alive) continue;
        let f;
        try { f = await analyseFace(pic.uri, rot); } catch { if (++errors > 5) return onFail('analysis'); continue; }
        rot = f.rotation;
        const cur = order[index];
        if (f.faces === 0) { stable = 0; show('no_face', false); continue; }
        if (f.faces > 1) { stable = 0; show('multiple_faces', false); continue; }
        if (f.boxWidth < 0.28 * f.frameWidth) { stable = 0; show('closer', false); continue; }
        if (cur === 'center') {
          if (Math.abs(f.yaw) > 10 || Math.abs(f.roll) > 12) { stable = 0; show('straight', false); continue; }
          if (f.left < 0.6 || f.right < 0.6) { stable = 0; show('eyes_open', false); continue; }
          if (++stable < 2) { show('hold', true); continue; }
          if (!turnA || !turnB) continue;
          const [pos, neg] = turnA.yaw > 0 ? [turnA, turnB] : [turnB, turnA];
          if (alive) { setStep('done'); setProgress(1); }
          try {
            const [selfie, turnLeft, turnRight] = await Promise.all([pic.uri, pos.uri, neg.uri].map(async (u) => readBase64(await frameToJpeg(u, rot, 720))));
            alive = false;
            return onDone({ selfie, turnLeft, turnRight, report: {
              method: 'mlkit_face_active_challenge_stills', challenges: order, blink_detected: false,
              yaw_turn_left_deg: pos.yaw, yaw_turn_right_deg: neg.yaw, duration_ms: Date.now() - started,
            } });
          } catch (e: any) { return onFail(e?.message ?? 'error'); }
        }
        if (cur === 'turn') {
          if (Math.abs(f.yaw) < TURN_DEGREES) { stable = 0; show(null, true); continue; }
          if (++stable < 2) { show('hold_there', true); continue; }
          firstYaw = f.yaw; turnA = { yaw: f.yaw, uri: pic.uri };
        } else {
          if (Math.abs(f.yaw) < TURN_DEGREES || f.yaw * firstYaw > 0) { stable = 0; show(null, true); continue; }
          if (++stable < 2) { show('hold_there', true); continue; }
          turnB = { yaw: f.yaw, uri: pic.uri };
        }
        stable = 0; index++; setStep(order[index]); setProgress(index / order.length); show(null, true);
      }
    })();
    return () => { alive = false; };
  }, [ready]);

  return (
    <View style={{ gap: 12 }}>
      <View style={{ height: 440, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' }}>
        <CameraView ref={cam} style={{ flex: 1 }} facing="front" animateShutter={false} onCameraReady={() => setReady(true)} />
        <View pointerEvents="none" style={{ position: 'absolute', left: '14%', right: '14%', top: '9%', bottom: '15%', borderWidth: 4, borderRadius: 999, borderColor: ok ? theme.ok : theme.accent }} />
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, backgroundColor: '#fff3' }}>
          <View style={{ width: `${Math.round(progress * 100)}%`, height: 6, backgroundColor: theme.ok }} />
        </View>
      </View>
      <Card>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>{ready ? t(STEP_KEY[step]) : t('w.live.starting')}</Text>
        <P muted style={{ textAlign: 'center' }}>{hint ? t('w.live.hint.' + hint) : ' '}</P>
      </Card>
    </View>
  );
}
