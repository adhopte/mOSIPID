// Mailbox relay for the proximity flow. Carries only end-to-end encrypted ISO 18013-5 session messages.
// In-memory by design (single instance): mailboxes live a few minutes.
import { Router } from 'express';
import { randomId } from '@mosipid/core';
import { wrap, HttpError, rateLimit } from '@mosipid/server-kit';

type Queue = 'toDevice' | 'toReader';
interface Mailbox { exp: number; q: Record<Queue, string[]>; waiters: Record<Queue, ((v: string | undefined) => void)[]> }

const TTL = 5 * 60_000;
const MAX_MAILBOXES = 5000;

export function relayRouter(): Router {
  const boxes = new Map<string, Mailbox>();
  setInterval(() => { const now = Date.now(); for (const [k, b] of boxes) if (b.exp < now) boxes.delete(k); }, 30_000).unref();
  const r = Router();

  r.post('/', rateLimit(30, 60_000), (_req, res) => {
    if (boxes.size >= MAX_MAILBOXES) throw new HttpError(503, 'relay_full');
    const id = randomId(16);
    boxes.set(id, { exp: Date.now() + TTL, q: { toDevice: [], toReader: [] }, waiters: { toDevice: [], toReader: [] } });
    res.json({ id, expires_in: TTL / 1000 });
  });

  const get = (id: string) => { const b = boxes.get(id); if (!b || b.exp < Date.now()) throw new HttpError(404, 'mailbox_not_found'); return b; };
  const isQueue = (q: string): q is Queue => q === 'toDevice' || q === 'toReader';

  r.post('/:id/:queue', rateLimit(120, 60_000), wrap(async (req, res) => {
    const b = get(req.params.id);
    if (!isQueue(req.params.queue)) throw new HttpError(400, 'invalid_queue');
    const data = req.body?.data;
    if (typeof data !== 'string' || data.length > 512 * 1024) throw new HttpError(400, 'invalid_message');
    const waiter = b.waiters[req.params.queue].shift();
    if (waiter) waiter(data);
    else if (b.q[req.params.queue].length < 20) b.q[req.params.queue].push(data);
    else throw new HttpError(429, 'queue_full');
    res.json({ ok: true });
  }));

  r.get('/:id/:queue', wrap(async (req, res) => {
    const b = get(req.params.id);
    if (!isQueue(req.params.queue)) throw new HttpError(400, 'invalid_queue');
    const queue = req.params.queue;
    const ready = b.q[queue].shift();
    if (ready) return void res.json({ data: ready });
    const wait = Math.min(25, Number(req.query.wait ?? 0)) * 1000;
    if (!wait) return void res.json({});
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { const i = b.waiters[queue].indexOf(cb); if (i >= 0) b.waiters[queue].splice(i, 1); res.json({}); resolve(); }, wait);
      const cb = (v: string | undefined) => { clearTimeout(t); res.json({ data: v }); resolve(); };
      b.waiters[queue].push(cb);
      req.on('close', () => { clearTimeout(t); const i = b.waiters[queue].indexOf(cb); if (i >= 0) b.waiters[queue].splice(i, 1); resolve(); });
    });
  }));
  return r;
}
