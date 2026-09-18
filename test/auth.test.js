import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyGoogleIdToken } from '../src/auth.js';

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function makeToken({ keyPair, kid, payload }) {
  const header = { alg: 'RS256', kid };
  const signedContent = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signedContent), keyPair.privateKey);
  return `${signedContent}.${b64url(signature)}`;
}

function fixture() {
  const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  const kid = 'test-kid';
  const fetchJwks = async () => [{ ...jwk, kid }];
  const basePayload = { aud: 'client-123', iss: 'https://accounts.google.com', email: 'you@example.com', email_verified: true, exp: 9_999_999_999, sub: 'abc' };
  return { keyPair, kid, fetchJwks, basePayload };
}

test('verifies a correctly signed, matching Google id token', async () => {
  const { keyPair, kid, fetchJwks, basePayload } = fixture();
  const token = makeToken({ keyPair, kid, payload: basePayload });
  const identity = await verifyGoogleIdToken(token, { clientId: 'client-123', allowedEmail: 'you@example.com', fetchJwks });
  assert.equal(identity.email, 'you@example.com');
});

test('rejects a token signed by a key not present in the JWKS', async () => {
  const { keyPair, fetchJwks, basePayload } = fixture();
  const token = makeToken({ keyPair, kid: 'other-kid', payload: basePayload });
  await assert.rejects(() => verifyGoogleIdToken(token, { clientId: 'client-123', allowedEmail: 'you@example.com', fetchJwks }), /Unknown signing key/);
});

test('rejects a token whose signature does not match its payload', async () => {
  const { keyPair, kid, fetchJwks, basePayload } = fixture();
  const token = makeToken({ keyPair, kid, payload: basePayload });
  const tampered = token.split('.'); tampered[1] = Buffer.from(JSON.stringify({ ...basePayload, email: 'attacker@example.com' })).toString('base64url');
  await assert.rejects(() => verifyGoogleIdToken(tampered.join('.'), { clientId: 'client-123', allowedEmail: 'you@example.com', fetchJwks }), /Invalid token signature/);
});

test('rejects a token issued for a different audience', async () => {
  const { keyPair, kid, fetchJwks, basePayload } = fixture();
  const token = makeToken({ keyPair, kid, payload: { ...basePayload, aud: 'someone-elses-client' } });
  await assert.rejects(() => verifyGoogleIdToken(token, { clientId: 'client-123', allowedEmail: 'you@example.com', fetchJwks }), /Invalid audience/);
});

test('rejects an expired token', async () => {
  const { keyPair, kid, fetchJwks, basePayload } = fixture();
  const token = makeToken({ keyPair, kid, payload: { ...basePayload, exp: 1 } });
  await assert.rejects(() => verifyGoogleIdToken(token, { clientId: 'client-123', allowedEmail: 'you@example.com', fetchJwks }), /expired/);
});

test('rejects a token for an email other than the allow-listed one', async () => {
  const { keyPair, kid, fetchJwks, basePayload } = fixture();
  const token = makeToken({ keyPair, kid, payload: { ...basePayload, email: 'someone-else@example.com' } });
  await assert.rejects(() => verifyGoogleIdToken(token, { clientId: 'client-123', allowedEmail: 'you@example.com', fetchJwks }), /Email not allowed/);
});

test('rejects an unverified email even if it matches', async () => {
  const { keyPair, kid, fetchJwks, basePayload } = fixture();
  const token = makeToken({ keyPair, kid, payload: { ...basePayload, email_verified: false } });
  await assert.rejects(() => verifyGoogleIdToken(token, { clientId: 'client-123', allowedEmail: 'you@example.com', fetchJwks }), /not verified/);
});
