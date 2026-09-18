import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateStorageCost } from '../src/domain.js';

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function makeToken({ keyPair, kid, payload }) {
  const header = { alg: 'RS256', kid };
  const signedContent = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signedContent), keyPair.privateKey);
  return `${signedContent}.${b64url(signature)}`;
}

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneprep-server-test-'));
  const port = 34000 + Math.floor(Math.random() * 5000);
  const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  const kid = 'test-kid';
  const clientId = 'client-123', allowedEmail = 'you@example.com';

  const realFetch = global.fetch;
  global.fetch = async (url, ...rest) => {
    if (String(url).includes('googleapis.com')) return { ok: true, json: async () => ({ keys: [{ ...jwk, kid }] }) };
    return realFetch(url, ...rest);
  };

  process.env.DATA_DIR = dataDir;
  process.env.PORT = String(port);
  process.env.GOOGLE_CLIENT_ID = clientId;
  process.env.ALLOWED_EMAIL = allowedEmail;

  await import('../src/server.js');
  await new Promise(r => setTimeout(r, 100));

  const token = makeToken({ keyPair, kid, payload: { aud: clientId, iss: 'https://accounts.google.com', email: allowedEmail, email_verified: true, exp: 9_999_999_999, sub: 'abc' } });
  const base = `http://localhost:${port}`;
  const authed = (p, opts = {}) => fetch(`${base}${p}`, { ...opts, headers: { ...opts.headers, authorization: `Bearer ${token}` } });
  return { base, authed, dataDir };
}

test('upload accrues real storage cost, delete refunds it, and download sanitizes a hostile filename', async () => {
  const { authed } = await startServer();
  const bytes = Buffer.alloc(5_000_000, 7);

  const before = await (await authed('/api/cost')).json();
  assert.equal(before.projected, 0);

  const created = await (await authed('/api/uploads', { method: 'POST', body: JSON.stringify({ filename: 'clip.mp4', sizeBytes: bytes.length }) })).json();
  await authed(`/api/uploads/${created.id}?offset=0`, { method: 'PUT', body: bytes });

  const hostileFilename = 'evil".mp4\r\nX-Injected: yes';
  const completed = await (await authed(`/api/uploads/${created.id}/complete`, { method: 'POST', body: JSON.stringify({ filename: hostileFilename, durationSeconds: 15, width: 1080, height: 1920, mime: 'video/mp4' }) })).json();
  assert.equal(completed.state, 'queued');

  const expectedCost = estimateStorageCost(bytes.length);
  const after = await (await authed('/api/cost')).json();
  assert.ok(Math.abs(after.projected - expectedCost) < 1e-9, 'spend should accrue the estimated storage cost of the uploaded bytes');

  const download = await authed(`/api/projects/${completed.id}/download`);
  const disposition = download.headers.get('content-disposition');
  assert.ok(!/[\r\n]/.test(disposition), 'header must not carry a raw CRLF from the filename (header/response splitting)');
  const quotedFilename = disposition.match(/filename="([^]*?)";\s*filename\*=/)[1];
  assert.ok(!quotedFilename.includes('"'), 'an unescaped quote in the filename would let an attacker break out of the quoted parameter and inject new ones');
  assert.ok(quotedFilename.startsWith('evil_.mp4'), 'sanitized ascii filename should still be present');
  await download.arrayBuffer();

  await authed(`/api/projects/${completed.id}`, { method: 'DELETE' });
  const afterDelete = await (await authed('/api/cost')).json();
  assert.equal(afterDelete.projected, 0, 'deleting the project should refund its accrued storage cost');
});

after(() => { setImmediate(() => process.exit(0)); });
