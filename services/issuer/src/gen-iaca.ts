// Prints env-var lines so the mock IACA / education CA can be pinned in Render (optional; the issuer
// otherwise generates and stores them in Postgres on first boot).
import { MemoryStore } from '@mosipid/server-kit';
import { loadPki } from './trust';
import { privateKeyHex } from '@mosipid/core';

(async () => {
  const p = await loadPki(new MemoryStore(), 'http://localhost');
  const line = (k: string, v: string) => console.log(`${k}=${v.replace(/\n/g, '\\n')}`);
  line('IACA_CA_PEM', p.iaca.pem); line('IACA_CA_KEY', privateKeyHex(p.iaca.key)); line('IACA_DS_PEM', p.idSigner.pem); line('IACA_DS_KEY', privateKeyHex(p.idSigner.key));
  line('EDU_CA_PEM', p.edu.pem); line('EDU_CA_KEY', privateKeyHex(p.edu.key)); line('EDU_DS_PEM', p.eduSigner.pem); line('EDU_DS_KEY', privateKeyHex(p.eduSigner.key));
})();
