import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { fromHex, toHex, concat } from '../src/bytes';
import { TripleDes, desBlock } from '../src/icao/des';
import { bacKeySeed, deriveBacKeys, completeBac, SecureMessaging, tlv, pad, retailMac } from '../src/icao/bac';

test('DES matches FIPS test vector', () => {
  const out = desBlock(fromHex('133457799BBCDFF1'), fromHex('0123456789ABCDEF'));
  assert.equal(toHex(out).toUpperCase(), '85E813540F0AB405');
  assert.equal(toHex(desBlock(fromHex('133457799BBCDFF1'), out, true)).toUpperCase(), '0123456789ABCDEF');
});

test('3DES-CBC agrees with node crypto', () => {
  const key = fromHex('0123456789abcdeffedcba9876543210');
  const iv = fromHex('0011223344556677');
  const data = new Uint8Array(48).map((_, i) => i * 7);
  const c = createCipheriv('des-ede-cbc', Buffer.from(key), Buffer.from(iv)); c.setAutoPadding(false);
  const ref = Buffer.concat([c.update(data), c.final()]);
  assert.equal(toHex(new TripleDes(key).cbcEncrypt(data, iv)), ref.toString('hex'));
});

// ICAO 9303 part 11, appendix D.3 worked example
test('BAC key derivation matches ICAO worked example', () => {
  const seed = bacKeySeed('L898902C<', '690806', '940623');
  assert.equal(toHex(seed).toUpperCase(), '239AB9CB282DAF66231DC5A4DF6BFBAE');
  const k = deriveBacKeys(seed);
  assert.equal(toHex(k.kEnc).toUpperCase(), 'AB94FDECF2674FDFB9B391F85D7F76F2');
  assert.equal(toHex(k.kMac).toUpperCase(), '7962D9ECE03D1ACD4C76089DCE131543');
});

test('BAC mutual authentication matches ICAO worked example and yields session keys', async () => {
  const keys = deriveBacKeys(bacKeySeed('L898902C<', '690806', '940623'));
  const rndIcc = fromHex('4608F91988702212'), rndIfd = fromHex('781723860C06C226'), kIfd = fromHex('0B795240CB7049B01C19B33E32804F0B');
  // Emulate chip: expected EIFD from the spec; reply with spec's EICC||MICC
  const expectedCmd = '72C29C2371CC9BDB65B779B8E8D37B29ECC154AA56A8799FAE2F498F76ED92F25F1448EEA8AD90A7';
  const reply = fromHex('46B9342A41396CD7386BF5803104D7CEDC122B9132139BAF2EEDC94EE178534F2F2D235D074D7449' + '9000');
  let seen = '';
  const sm = await completeBac(async (apdu) => { seen = toHex(apdu.subarray(5, 45)).toUpperCase(); return reply; }, keys, rndIcc, rndIfd, kIfd);
  assert.equal(seen, expectedCmd);
  assert.ok(sm instanceof SecureMessaging);
});

test('session encryption key and SSC match the ICAO example', async () => {
  const keys = deriveBacKeys(bacKeySeed('L898902C<', '690806', '940623'));
  const reply = fromHex('46B9342A41396CD7386BF5803104D7CEDC122B9132139BAF2EEDC94EE178534F2F2D235D074D7449' + '9000');
  const sm: any = await completeBac(async () => reply, keys, fromHex('4608F91988702212'), fromHex('781723860C06C226'), fromHex('0B795240CB7049B01C19B33E32804F0B'));
  assert.equal(toHex(sm.ksEnc).toUpperCase(), '979EC13B1CBFE9DCD01AB0FED307EAE5');
  assert.equal(toHex(sm.ssc).toUpperCase(), '887022120C06C226');
});

test('secure messaging: SELECT command DO87 matches spec; response round-trips with an emulated chip', () => {
  const kEnc = fromHex('979EC13B1CBFE9DCD01AB0FED307EAE5'), kMac = fromHex('F1CB1F1FB5ADF208806B89DC579DC1F8');
  const reader = new SecureMessaging(kEnc, kMac, fromHex('887022120C06C226'));
  const apdu = reader.protect(0x00, 0xa4, 0x02, 0x0c, fromHex('011E'));
  assert.equal(toHex(apdu.subarray(5, 16)).toUpperCase(), '8709016375432908C044F6');

  // chip side: SSC advances once for the command and once for the response
  const ssc = fromHex('887022120C06C228');
  const payload = new Uint8Array(20).map((_, i) => i + 1);
  const do87 = tlv(0x87, concat(Uint8Array.of(1), new TripleDes(kEnc).cbcEncrypt(pad(payload))));
  const do99 = tlv(0x99, fromHex('9000'));
  const cc = retailMac(kMac, pad(concat(ssc, do87, do99)));
  const resp = concat(do87, do99, tlv(0x8e, cc), fromHex('9000'));
  const out = reader.unprotect(resp);
  assert.deepEqual([...out.data], [...payload]);
  assert.equal(out.sw, 0x9000);
  // tampering is detected
  const bad = resp.slice(); bad[3] ^= 1;
  assert.throws(() => new SecureMessaging(kEnc, kMac, fromHex('887022120C06C226')).unprotect(bad));
});
