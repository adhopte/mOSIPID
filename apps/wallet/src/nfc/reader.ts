import { Platform } from 'react-native';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import { readPassport, Transceive, PassportRead } from '@mosipid/core';

export async function nfcAvailable(): Promise<'ok' | 'disabled' | 'unsupported'> {
  try {
    if (!(await NfcManager.isSupported())) return 'unsupported';
    await NfcManager.start();
    return Platform.OS === 'android' && !(await NfcManager.isEnabled()) ? 'disabled' : 'ok';
  } catch { return 'unsupported'; }
}
export const openNfcSettings = () => NfcManager.goToNfcSetting().catch(() => {});

const yymmdd = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

/** Reads DG1, DG2 and EF.SOD from an ICAO 9303 eMRTD using BAC (MRZ-derived keys). */
export async function readChipWithMrz(
  mrz: { documentNumber: string; birthDate: string; expiryDate: string },
  onProgress: (stage: string, done?: number, total?: number) => void,
  alertMessage: string,
): Promise<PassportRead> {
  await NfcManager.start();
  try {
    await NfcManager.requestTechnology(NfcTech.IsoDep, { alertMessage });
    const tx: Transceive = async (apdu) => {
      if (Platform.OS === 'ios') {
        const r = await NfcManager.sendCommandAPDUIOS(Array.from(apdu));
        return Uint8Array.from([...r.response, r.sw1, r.sw2]);
      }
      return Uint8Array.from(await NfcManager.isoDepHandler.transceive(Array.from(apdu)));
    };
    return await readPassport(tx, { documentNumber: mrz.documentNumber, birthYYMMDD: yymmdd(mrz.birthDate), expiryYYMMDD: yymmdd(mrz.expiryDate) }, onProgress);
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}
