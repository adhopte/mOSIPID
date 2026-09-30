import { issueMdoc, issueSdJwt, fullDate, Jwk, ageOver, sexToIso5218, alpha3to2, DOCTYPE_ID, NS_ID, VCT_DEGREE } from '@mosipid/core';
import { IssuerConfig } from './config';
import { Pki, toSigner } from './trust';
import { Student } from './students';
import { randomInt } from 'node:crypto';

export interface VerifiedIdentity {
  familyName: string; givenNames: string; birthDate: string; sex: 'M' | 'F' | 'X'; nationality: string;
  method: 'nfc' | 'ocr' | 'manual';
  /** where the evidence came from: NFC chip, live camera, an uploaded file, or typed in by the holder */
  source?: 'chip' | 'camera' | 'upload' | 'manual';
  ocrSource?: string;
  portrait?: string /* base64 jpeg */; demoAssurance: boolean; passiveAuth?: 'verified' | 'demo';
  /** number printed on the source travel document (kept only as evidence, not the credential's document_number) */
  sourceDocumentNumber?: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function buildIdMdoc(id: VerifiedIdentity, holder: Jwk, pki: Pki, cfg: IssuerConfig): Uint8Array {
  const now = new Date();
  const until = new Date(now.getTime() + cfg.idValidityDays * 86400_000);
  const expiry = new Date(now); expiry.setUTCFullYear(expiry.getUTCFullYear() + 5);
  // self_asserted: typed in by the holder, nothing verified · low: uploaded image · substantial: live camera + face match ·
  // high: chip read with passive authentication chained to a trusted CSCA · demo: some check was simulated
  const assurance = id.method === 'manual' ? 'self_asserted' : id.demoAssurance ? 'demo'
    : id.method === 'nfc' && id.passiveAuth === 'verified' ? 'high' : id.source === 'upload' ? 'low' : 'substantial';
  const ns: Record<string, unknown> = {
    family_name: id.familyName,
    given_name: id.givenNames,
    birth_date: fullDate(id.birthDate),
    sex: sexToIso5218(id.sex),
    nationality: alpha3to2(id.nationality),
    document_number: 'MID-' + String(randomInt(0, 1e10)).padStart(10, '0'),
    issue_date: fullDate(iso(now)),
    expiry_date: fullDate(iso(expiry)),
    issuing_country: cfg.issuingCountry,
    issuing_authority: cfg.issuingAuthority,
    age_over_18: ageOver(id.birthDate, 18),
    age_over_21: ageOver(id.birthDate, 21),
    verification_method: id.method === 'nfc' ? 'nfc_chip_passive_auth' : id.method === 'manual' ? 'manual_entry_unverified'
      : id.source === 'upload' ? 'uploaded_document_face_match' : 'optical_mrz_face_match',
    assurance_level: assurance,
  };
  if (id.portrait) ns.portrait = Buffer.from(id.portrait, 'base64');
  return issueMdoc({ docType: DOCTYPE_ID, namespaces: { [NS_ID]: ns }, deviceKey: holder, signer: toSigner(pki.idSigner), validFrom: now, validUntil: until });
}

export function buildDegreeSdJwt(s: Student, universityName: string, holder: Jwk, pki: Pki, cfg: IssuerConfig): string {
  return issueSdJwt({
    iss: cfg.publicUrl, vct: VCT_DEGREE, holderKey: holder, signer: toSigner(pki.eduSigner), validitySeconds: cfg.degreeValiditySeconds,
    claims: {
      student_id: s.studentId, given_name: s.givenName, family_name: s.familyName, degree: s.degree, field_of_study: s.field,
      university: universityName, graduation_year: s.graduationYear, cgpa: s.cgpa, class_of_degree: s.classOfDegree,
    },
  });
}
