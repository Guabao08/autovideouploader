import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore } from '../src/store.js';
import { UploadManager } from '../src/uploads.js';

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneprep-uploads-'));
  const store = new JsonStore(path.join(dir, 'store.json'), {});
  return { manager: new UploadManager(path.join(dir, 'chunks'), store), dir, store };
}

test('supports resuming an upload across multiple chunks and hashes the assembled bytes', async () => {
  const { manager } = makeManager();
  const content = Buffer.from('hello world, this is a video file pretending to be bytes');
  const { id } = manager.create('session-1', content.length);
  const half = content.subarray(0, 20), rest = content.subarray(20);
  manager.appendChunk(id, 0, half);
  assert.equal(manager.status(id).receivedBytes, 20);
  manager.appendChunk(id, 20, rest);
  const result = await manager.complete(id);
  assert.equal(result.sha256, crypto.createHash('sha256').update(content).digest('hex'));
  assert.equal(result.sizeBytes, content.length);
});

test('rejects a chunk written at the wrong offset', () => {
  const { manager } = makeManager();
  manager.create('session-2', 10);
  manager.appendChunk('session-2', 0, Buffer.from('12345'));
  assert.throws(() => manager.appendChunk('session-2', 0, Buffer.from('67890')), /Expected offset 5/);
});

test('refuses to complete an upload short of its declared size', async () => {
  const { manager } = makeManager();
  manager.create('session-3', 10);
  manager.appendChunk('session-3', 0, Buffer.from('12345'));
  await assert.rejects(() => manager.complete('session-3'), /incomplete/);
});

test('upload session metadata survives a process restart via the durable store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneprep-store-'));
  const filePath = path.join(dir, 'store.json');
  const first = new JsonStore(filePath, { uploadSessions: {} });
  first.data.uploadSessions['abc'] = { expectedSize: 42 };
  first.save();
  const reopened = new JsonStore(filePath, { uploadSessions: {} });
  assert.equal(reopened.data.uploadSessions.abc.expectedSize, 42);
});
