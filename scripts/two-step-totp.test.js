/**
 * Two-step sign-in codes (#222): server/lib/totp.js against the RFCs' own
 * test vectors, copied from the RFC texts (rfc-editor.org): RFC 4226
 * Appendix D (HOTP) and RFC 6238 Appendix B (TOTP, all three hashes, with
 * the seeds from its Appendix A reference code). Then the window, replay and
 * the encoding authenticator apps read.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hotp, totp, verifyTotp, base32Encode, base32Decode, otpauthUri, timeStep, newSecret,
} from '../server/lib/totp.js';

// RFC 4226 Appendix D: secret "12345678901234567890", counts 0 to 9.
const RFC4226_SECRET = Buffer.from('3132333435363738393031323334353637383930', 'hex');
const RFC4226_HOTP = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

test('HOTP matches RFC 4226 Appendix D', () => {
  RFC4226_HOTP.forEach((want, count) => assert.equal(hotp(RFC4226_SECRET, count), want, `count ${count}`));
});

// RFC 6238 Appendix A seeds (seed, seed32, seed64) and Appendix B table.
const SEEDS = {
  sha1: Buffer.from('3132333435363738393031323334353637383930', 'hex'),
  sha256: Buffer.from('3132333435363738393031323334353637383930' + '313233343536373839303132', 'hex'),
  sha512: Buffer.from('3132333435363738393031323334353637383930'.repeat(3) + '31323334', 'hex'),
};
const RFC6238 = [
  [59, '0000000000000001', { sha1: '94287082', sha256: '46119246', sha512: '90693936' }],
  [1111111109, '00000000023523EC', { sha1: '07081804', sha256: '68084774', sha512: '25091201' }],
  [1111111111, '00000000023523ED', { sha1: '14050471', sha256: '67062674', sha512: '99943326' }],
  [1234567890, '000000000273EF07', { sha1: '89005924', sha256: '91819424', sha512: '93441116' }],
  [2000000000, '0000000003F940AA', { sha1: '69279037', sha256: '90698825', sha512: '38618901' }],
  [20000000000, '0000000027BC86AA', { sha1: '65353130', sha256: '77737706', sha512: '47863826' }],
];

test('TOTP matches RFC 6238 Appendix B (SHA-1, SHA-256, SHA-512, 8 digits)', () => {
  for (const [sec, tHex, codes] of RFC6238) {
    assert.equal(timeStep(sec * 1000), parseInt(tHex, 16), `T for ${sec}`);
    for (const [alg, want] of Object.entries(codes)) {
      assert.equal(totp(SEEDS[alg], sec * 1000, { digits: 8, algorithm: alg }), want, `${alg} at ${sec}`);
    }
  }
});

test('the 6-digit code is the last six of the RFC value (what apps show)', () => {
  assert.equal(totp(SEEDS.sha1, 59 * 1000), '287082');
  assert.equal(totp(SEEDS.sha1, 1111111109 * 1000), '081804');
});

test('one step either side of now is accepted, two is not', () => {
  const key = SEEDS.sha1;
  const now = 1111111109 * 1000;
  const step = timeStep(now);
  for (const d of [-1, 0, 1]) assert.equal(verifyTotp(key, hotp(key, step + d), { nowMs: now }), step + d, `offset ${d}`);
  for (const d of [-2, 2]) assert.equal(verifyTotp(key, hotp(key, step + d), { nowMs: now }), null, `offset ${d}`);
});

test('a used step, and anything older, is refused', () => {
  const key = SEEDS.sha1;
  const now = 1111111109 * 1000;
  const step = timeStep(now);
  const code = hotp(key, step);
  assert.equal(verifyTotp(key, code, { nowMs: now, lastStep: step }), null, 'same code again');
  assert.equal(verifyTotp(key, hotp(key, step - 1), { nowMs: now, lastStep: step }), null, 'an older code');
  assert.equal(verifyTotp(key, hotp(key, step + 1), { nowMs: now, lastStep: step }), step + 1, 'the next code still works');
});

test('codes are read as typed: spaces and a dash ignored, anything else refused', () => {
  const key = SEEDS.sha1;
  const now = 59 * 1000;
  assert.equal(verifyTotp(key, '287 082', { nowMs: now }), 1);
  assert.equal(verifyTotp(key, '287-082', { nowMs: now }), 1);
  for (const bad of ['', '28708', '2870822', 'abcdef', null, undefined, 287082.5]) {
    assert.equal(verifyTotp(key, bad, { nowMs: now }), null, String(bad));
  }
});

test('base32 round trip, and the RFC 4648 test vectors', () => {
  const vectors = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [plain, enc] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), enc);
    if (enc) assert.equal(base32Decode(enc).toString(), plain);
  }
  const s = newSecret();
  assert.equal(s.length, 20);
  assert.deepEqual(base32Decode(base32Encode(s).toLowerCase().replace(/(.{4})/g, '$1 ')), s);
  assert.equal(base32Decode('not base32!'), null);
});

test('the otpauth link names the app and the account', () => {
  const uri = otpauthUri({ issuer: 'NutriTrace', account: 'alice', secret: 'JBSWY3DPEHPK3PXP' });
  assert.match(uri, /^otpauth:\/\/totp\/NutriTrace%3Aalice\?/);
  const q = new URL(uri.replace('otpauth://totp/', 'https://x/')).searchParams;
  assert.equal(q.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(q.get('issuer'), 'NutriTrace');
  assert.equal(q.get('digits'), '6');
  assert.equal(q.get('period'), '30');
});

test('traced request bodies never show a code, a password, a pending token or a recovery token', async () => {
  const { formatTraceBody } = await import('../server/middleware/request-logging.js');
  const out = formatTraceBody({ code: '123456', password: 'pw', pending_token: 'eyJ', token: 'owner', username: 'alice', barcode: '0099887700554', nested: { code: 654321 } });
  for (const secret of ['123456', '654321', '"pw"', 'eyJ', 'owner']) assert.equal(out.includes(secret), false, `${secret} in ${out}`);
  assert.match(out, /alice/);
  assert.match(out, /0099887700554/, 'barcode still shows');
});
