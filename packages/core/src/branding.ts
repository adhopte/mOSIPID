export type Theme = 'light' | 'dark' | 'auto';
export interface Branding {
  tenant: string;
  kind: 'wallet' | 'issuer' | 'verifier';
  /** display name per language; falls back to `en` */
  names: Record<string, string>;
  logoUrl?: string;
  /** true = show the built-in Blue Tiger logo until an administrator uploads one */
  defaultLogo?: boolean;
  colors: { primary: string; secondary: string; background: string; surface: string; text: string; accent: string };
  theme: Theme;
  updatedAt?: string;
}

export const DEFAULT_BRANDING: Record<string, Branding> = {
  wallet: { tenant: 'wallet', kind: 'wallet', defaultLogo: true, names: { en: 'Blue Tiger Wallet', fr: 'Portefeuille Blue Tiger', es: 'Cartera Blue Tiger' }, colors: { primary: '#0E7AE6', secondary: '#0A1230', background: '#F3F7FC', surface: '#FFFFFF', text: '#0B1220', accent: '#F59E0B' }, theme: 'auto' },
  'issuer-id': { tenant: 'issuer-id', kind: 'issuer', defaultLogo: true, names: { en: 'Blue Tiger ID · IN Groupe (Mock) Issuer', fr: "Blue Tiger ID · Émetteur IN Groupe (fictif)", es: 'Blue Tiger ID · Emisor IN Groupe (simulado)' }, colors: { primary: '#0E7490', secondary: '#083344', background: '#F0F9FF', surface: '#FFFFFF', text: '#0F172A', accent: '#F97316' }, theme: 'light' },
  'issuer-university': { tenant: 'issuer-university', kind: 'issuer', names: { en: 'Bharat Institute of Technology', fr: 'Institut de technologie Bharat', es: 'Instituto de Tecnología Bharat' }, colors: { primary: '#7C2D12', secondary: '#431407', background: '#FFF7ED', surface: '#FFFFFF', text: '#1C1917', accent: '#CA8A04' }, theme: 'light' },
  'verifier-electricity': { tenant: 'verifier-electricity', kind: 'verifier', names: { en: 'VoltEdge Electricity', fr: 'VoltEdge Électricité', es: 'VoltEdge Electricidad' }, colors: { primary: '#CA8A04', secondary: '#422006', background: '#FEFCE8', surface: '#FFFFFF', text: '#1C1917', accent: '#0EA5E9' }, theme: 'light' },
  'verifier-university': { tenant: 'verifier-university', kind: 'verifier', names: { en: 'Bharat Institute of Technology', fr: 'Institut de technologie Bharat', es: 'Instituto de Tecnología Bharat' }, colors: { primary: '#7C2D12', secondary: '#431407', background: '#FFF7ED', surface: '#FFFFFF', text: '#1C1917', accent: '#CA8A04' }, theme: 'light' },
  'verifier-proximity': { tenant: 'verifier-proximity', kind: 'verifier', defaultLogo: true, names: { en: 'Blue Tiger Verifier', fr: 'Vérificateur Blue Tiger', es: 'Verificador Blue Tiger' }, colors: { primary: '#047857', secondary: '#022C22', background: '#ECFDF5', surface: '#FFFFFF', text: '#0F172A', accent: '#F59E0B' }, theme: 'auto' },
};

export const brandName = (b: Branding, lang: string) => b.names[lang] ?? b.names.en ?? b.tenant;
