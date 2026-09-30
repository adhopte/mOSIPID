// JS surface of the Android-only native module (CameraX + ML Kit). On other platforms `captureAvailable` is false and
// the app falls back to the expo-camera + server-side OCR flow.
import React from 'react';
import { Platform, StyleProp, ViewStyle } from 'react-native';
import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type { FrameOcr } from '@mosipid/core';

const Native: any = Platform.OS === 'android' ? requireOptionalNativeModule('MosipidCapture') : null;
export const captureAvailable: boolean = !!Native;
const NativeView: React.ComponentType<any> | null = captureAvailable ? requireNativeViewManager('MosipidCapture') : null;

export interface ImageRef { uri: string; width: number; height: number }
export interface CapturedStill extends FrameOcr { uri: string }
export interface LivenessUi { step: 'center' | 'blink' | 'turn' | 'turn_other' | 'done'; hint: string | null; faceOk: boolean; completed: number; total: number }
export interface LivenessResult { selfie: string; turnLeft: string; turnRight: string; report: Record<string, unknown> }

export const recognizeText = (uri: string): Promise<FrameOcr> => Native.recognizeText(uri);
export const normalizeImage = (uri: string, maxSide = 2400): Promise<ImageRef> => Native.normalizeImage(uri, maxSide);
export const renderPdf = (uri: string, maxPages = 2): Promise<ImageRef[]> => Native.renderPdf(uri, maxPages);
export const readBase64 = (uri: string): Promise<string> => Native.readBase64(uri);

const parse = <T,>(e: { nativeEvent: { json: string } }): T => JSON.parse(e.nativeEvent.json);

interface Props {
  mode: 'mrz' | 'liveness';
  active: boolean;
  captureNonce?: number;
  style?: StyleProp<ViewStyle>;
  onFrameText?: (f: FrameOcr) => void;
  onCaptured?: (s: CapturedStill) => void;
  onLiveness?: (u: LivenessUi) => void;
  onLivenessComplete?: (r: LivenessResult) => void;
  onCaptureError?: (message: string) => void;
}

/** CameraX preview with ML Kit analysis (Android). */
export function CaptureCameraView(p: Props) {
  if (!NativeView) return null;
  const { onFrameText, onCaptured, onLiveness, onLivenessComplete, onCaptureError, ...rest } = p;
  return React.createElement(NativeView, {
    ...rest,
    onFrameText: onFrameText && ((e: any) => onFrameText(parse(e))),
    onCaptured: onCaptured && ((e: any) => onCaptured(parse(e))),
    onLiveness: onLiveness && ((e: any) => onLiveness(parse(e))),
    onLivenessComplete: onLivenessComplete && ((e: any) => onLivenessComplete(parse(e))),
    onCaptureError: onCaptureError && ((e: any) => onCaptureError(parse<{ message: string }>(e).message)),
  });
}

export interface FaceInfo { faces: number; rotation: number; frameWidth: number; boxWidth: number; yaw: number; roll: number; left: number; right: number }
export const analyseFace = (uri: string, rotation = 0): Promise<FaceInfo> => Native.analyseFace(uri, rotation);
export const frameToJpeg = (uri: string, rotation: number, maxSide = 720): Promise<string> => Native.frameToJpeg(uri, rotation, maxSide);
export const rotateImage = (uri: string, degrees: number): Promise<string> => Native.rotateImage(uri, degrees);
export const cropImage = (uri: string, x: number, y: number, w: number, h: number, maxSide = 2400): Promise<ImageRef> => Native.cropImage(uri, x, y, w, h, maxSide);
