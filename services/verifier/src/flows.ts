import { DOCTYPE_ID, NS_ID, VCT_DEGREE, DEFAULT_BRANDING } from '@mosipid/core';

export type FlowId = 'electricity' | 'university';

export interface Flow {
  id: FlowId;
  tenant: string;
  format: 'mso_mdoc' | 'dc+sd-jwt';
  anchor: 'iaca' | 'edu';
  queryId: string;
  docType?: string;
  vct?: string;
  namespace?: string;
  claims: string[];
}

export const FLOWS: Record<FlowId, Flow> = {
  electricity: {
    id: 'electricity', tenant: 'verifier-electricity', format: 'mso_mdoc', anchor: 'iaca', queryId: 'identity',
    docType: DOCTYPE_ID, namespace: NS_ID, claims: ['family_name', 'given_name', 'document_number', 'birth_date', 'age_over_18', 'portrait'],
  },
  university: {
    id: 'university', tenant: 'verifier-university', format: 'dc+sd-jwt', anchor: 'edu', queryId: 'degree',
    vct: VCT_DEGREE, claims: ['student_id', 'given_name', 'family_name', 'degree', 'field_of_study', 'graduation_year', 'university'],
  },
};

export const isFlow = (s: unknown): s is FlowId => s === 'electricity' || s === 'university';

export function dcqlFor(f: Flow) {
  return {
    credentials: [{
      id: f.queryId, format: f.format,
      meta: f.format === 'mso_mdoc' ? { doctype_value: f.docType } : { vct_values: [f.vct] },
      claims: f.claims.map((c) => ({ path: f.format === 'mso_mdoc' ? [f.namespace, c] : [c] })),
    }],
  };
}

export function presentationDefinitionFor(f: Flow, id: string) {
  return {
    id, input_descriptors: [{
      id: f.format === 'mso_mdoc' ? f.docType : f.queryId,
      format: f.format === 'mso_mdoc' ? { mso_mdoc: { alg: ['ES256'] } } : { 'vc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'], 'kb-jwt_alg_values': ['ES256'] } },
      ...(f.vct ? { vct: f.vct } : {}),
      constraints: {
        limit_disclosure: 'required',
        fields: f.claims.map((c) => ({ path: [f.format === 'mso_mdoc' ? `$['${f.namespace}']['${c}']` : `$.${c}`], intent_to_retain: false })),
      },
    }],
  };
}
void DEFAULT_BRANDING;
