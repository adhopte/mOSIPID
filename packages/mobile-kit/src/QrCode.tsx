import React, { useMemo } from 'react';
import { View } from 'react-native';
// qrcode-generator is dependency-free pure JS, so no native SVG module is needed
import qrcode from 'qrcode-generator';

export function QrCode({ value, size = 260 }: { value: string; size?: number }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M'); qr.addData(value); qr.make();
    const n = qr.getModuleCount();
    return { n, rows: Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c))) };
  }, [value]);
  const cell = Math.floor(size / (cells.n + 2));
  const dim = cell * (cells.n + 2);
  return (
    <View style={{ width: dim, height: dim, backgroundColor: '#fff', padding: cell, alignSelf: 'center', borderRadius: 8 }} accessibilityLabel="QR code">
      {cells.rows.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', height: cell }}>
          {row.map((dark, c) => <View key={c} style={{ width: cell, height: cell, backgroundColor: dark ? '#000' : '#fff' }} />)}
        </View>
      ))}
    </View>
  );
}
