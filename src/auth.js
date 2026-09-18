import crypto from 'node:crypto';

function b64urlToBuffer(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function decodeSegment(s) { return JSON.parse(b64urlToBuffer(s).toString('utf8')); }

export function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, s] = parts;
  return { header: decodeSegment(h), payload: decodeSegment(p), signature: b64urlToBuffer(s), signedContent: `${h}.${p}` };
}

function jwkToPublicKey(jwk) {
  return crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
}

export async function fetchGoogleJwks() {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error('Failed to fetch Google JWKS');
  const { keys } = await res.json();
  return keys;
}

const jwksCache = new WeakMap();
async function getJwks(fetchJwks) {
  const now = Date.now();
  const cached = jwksCache.get(fetchJwks);
  if (cached && now - cached.at < 3_600_000) return cached.keys;
  const keys = await fetchJwks();
  jwksCache.set(fetchJwks, { keys, at: now });
  return keys;
}

export const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export async function verifyGoogleIdToken(token, { clientId, allowedEmail, now = () => Date.now() / 1000, fetchJwks = fetchGoogleJwks }) {
  if (!clientId || !allowedEmail) throw new Error('Google auth not configured');
  const { header, payload, signature, signedContent } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new Error('Unsupported token algorithm');
  const keys = await getJwks(fetchJwks);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(signedContent), jwkToPublicKey(jwk), signature);
  if (!ok) throw new Error('Invalid token signature');
  if (payload.aud !== clientId) throw new Error('Invalid audience');
  if (!GOOGLE_ISSUERS.has(payload.iss)) throw new Error('Invalid issuer');
  if (typeof payload.exp !== 'number' || payload.exp < now()) throw new Error('Token expired');
  if (!payload.email_verified) throw new Error('Email not verified by Google');
  if (payload.email !== allowedEmail) throw new Error('Email not allowed');
  return { email: payload.email, sub: payload.sub };
}
