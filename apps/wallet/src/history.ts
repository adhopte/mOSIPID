import { randomBytes } from '@mosipid/core';
import { loadSealed, saveSealed } from './vault';

export type HistoryType = 'issued' | 'shared' | 'declined' | 'deleted' | 'failed' | 'security';
export interface HistoryEvent {
  id: string;
  ts: string;
  type: HistoryType;
  /** what happened, e.g. the credential name or the security action key */
  title: string;
  /** issuer or verifier name */
  counterparty?: string;
  /** the data items that left the phone (claim names) */
  claims?: string[];
  /** online | proximity | nfc | ocr | manual … */
  channel?: string;
  /** free-form detail (error text, action key) */
  detail?: string;
}

const NAME = 'history.v1';
const MAX = 500;
let queue: Promise<unknown> = Promise.resolve();

export const loadHistory = () => loadSealed<HistoryEvent[]>(NAME, []);

/** Append an event (newest first, capped). Never throws – logging must not break a flow. */
export function logEvent(e: Omit<HistoryEvent, 'id' | 'ts'>): Promise<void> {
  const next = queue.then(async () => {
    const list = await loadHistory();
    const ev: HistoryEvent = { id: Array.from(randomBytes(6)).map((b) => b.toString(16).padStart(2, '0')).join(''), ts: new Date().toISOString(), ...e };
    await saveSealed(NAME, [ev, ...list].slice(0, MAX));
  }).catch(() => {});
  queue = next;
  return next as Promise<void>;
}

export const clearHistory = () => { queue = queue.then(() => saveSealed(NAME, [])).catch(() => {}); return queue as Promise<void>; };
