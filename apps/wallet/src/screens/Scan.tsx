import React, { useRef } from 'react';
import { View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useI18n, Button, P, Screen } from '@mosipid/mobile-kit';

export function ScanScreen({ onData, onClose }: { onData: (data: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [perm, request] = useCameraPermissions();
  const handled = useRef(false);
  return (
    <Screen title={t('w.scan.title')} onBack={onClose} scroll={false}>
      {!perm?.granted ? (<><P>{t('w.scan.permission')}</P><Button label={t('w.scan.grant')} onPress={request} /></>) : (
        <View style={{ flex: 1, borderRadius: 16, overflow: 'hidden' }}>
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => { if (!handled.current) { handled.current = true; onData(data); } }} />
        </View>
      )}
      <P muted style={{ textAlign: 'center' }}>{t('w.scan.hint')}</P>
    </Screen>
  );
}
