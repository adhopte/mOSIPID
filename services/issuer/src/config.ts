import { baseUrl } from '@mosipid/server-kit';

export interface IssuerConfig {
  publicUrl: string;
  adminUrl?: string;
  verifierUrl?: string;
  /** auto = opencv when the model files are present, otherwise mock */
  faceProvider: 'auto' | 'opencv' | 'http' | 'mock';
  faceRequireLiveness: boolean;
  allowManualPid: boolean;
  /** cross-check the phone's ML Kit MRZ text against server-side Tesseract OCR (slower, needs more RAM) */
  ocrVerifyClient: boolean;
  faceApiUrl?: string;
  faceApiKey?: string;
  faceThreshold: number;
  ocrProvider: 'tesseract' | 'mock';
  passiveAuth: 'demo' | 'strict';
  cscaPems: string[];
  requireSelfie: boolean;
  allowedRedirects: string[];
  issuingCountry: string;
  issuingAuthority: string;
  idValidityDays: number;
  degreeValiditySeconds: number;
}

export function loadConfig(env = process.env, overrides: Partial<IssuerConfig> = {}): IssuerConfig {
  const csca = (env.CSCA_PEM ?? '').split(/(?=-----BEGIN CERTIFICATE-----)/).map((s) => s.trim()).filter(Boolean);
  const cfg: IssuerConfig = {
    publicUrl: (env.PUBLIC_URL || baseUrl()).replace(/\/$/, ''),
    adminUrl: env.ADMIN_URL?.replace(/\/$/, ''),
    verifierUrl: env.VERIFIER_URL?.replace(/\/$/, ''),
    faceProvider: (['opencv', 'http', 'mock'].includes(env.FACE_PROVIDER ?? '') ? env.FACE_PROVIDER : 'auto') as IssuerConfig['faceProvider'],
    faceRequireLiveness: env.FACE_REQUIRE_LIVENESS !== 'false',
    allowManualPid: env.ALLOW_MANUAL_PID !== 'false',
    ocrVerifyClient: env.OCR_VERIFY_CLIENT === 'true',
    faceApiUrl: env.FACE_API_URL,
    faceApiKey: env.FACE_API_KEY,
    faceThreshold: Number(env.FACE_THRESHOLD ?? 0.8),
    ocrProvider: env.OCR_PROVIDER === 'mock' ? 'mock' : 'tesseract',
    passiveAuth: env.PASSIVE_AUTH === 'strict' ? 'strict' : 'demo',
    cscaPems: csca,
    requireSelfie: env.REQUIRE_SELFIE !== 'false',
    allowedRedirects: (env.ALLOWED_REDIRECTS ?? 'mosipidwallet://,exp://,exp+mosipid-wallet://,http://localhost,https://localhost').split(',').map((s) => s.trim()).filter(Boolean),
    issuingCountry: env.ISSUING_COUNTRY ?? 'FR',
    issuingAuthority: env.ISSUING_AUTHORITY ?? 'IN Groupe (Mock IACA)',
    idValidityDays: Number(env.ID_VALIDITY_DAYS ?? 180),
    degreeValiditySeconds: Number(env.DEGREE_VALIDITY_DAYS ?? 3650) * 86400,
  };
  return { ...cfg, ...overrides };
}
