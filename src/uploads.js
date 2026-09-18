import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class UploadManager {
  constructor(dir, sessionStore) {
    this.dir = dir;
    this.sessionStore = sessionStore;
    fs.mkdirSync(dir, { recursive: true });
  }
  filePath(id) { return path.join(this.dir, id); }
  create(id, expectedSize) {
    fs.writeFileSync(this.filePath(id), Buffer.alloc(0));
    this.sessionStore.data[id] = { expectedSize };
    this.sessionStore.save();
    return { id, receivedBytes: 0, expectedSize };
  }
  status(id) {
    const session = this.sessionStore.data[id];
    if (!session) throw new Error('Unknown upload session');
    return { receivedBytes: fs.statSync(this.filePath(id)).size, expectedSize: session.expectedSize };
  }
  appendChunk(id, offset, buffer) {
    const session = this.sessionStore.data[id];
    if (!session) throw new Error('Unknown upload session');
    const current = fs.statSync(this.filePath(id)).size;
    if (offset !== current) throw new Error(`Expected offset ${current}, got ${offset}`);
    if (current + buffer.length > session.expectedSize) throw new Error('Upload exceeds declared size');
    fs.appendFileSync(this.filePath(id), buffer);
    return { receivedBytes: current + buffer.length };
  }
  async complete(id) {
    const session = this.sessionStore.data[id];
    if (!session) throw new Error('Unknown upload session');
    const filePath = this.filePath(id);
    const size = fs.statSync(filePath).size;
    if (size !== session.expectedSize) throw new Error(`Upload incomplete: expected ${session.expectedSize} bytes, received ${size}`);
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', d => hash.update(d));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return { sha256: hash.digest('hex'), sizeBytes: size, filePath };
  }
  discard(id) {
    const filePath = this.filePath(id);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    delete this.sessionStore.data[id];
    this.sessionStore.save();
  }
}
