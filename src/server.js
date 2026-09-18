import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateUpload, transition, editTranscript, canApprove, retry, costStatus, duplicateKey, notificationFor, estimateStorageCost } from './domain.js';
import { verifyGoogleIdToken } from './auth.js';
import { JsonStore } from './store.js';
import { UploadManager } from './uploads.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const dataDir = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const store = new JsonStore(path.join(dataDir, 'store.json'), { projects: {}, uploadSessions: {}, spend: 0, notifications: [] });
const uploadSessionStore = { get data() { return store.data.uploadSessions; }, save: () => store.save() };
const uploads = new UploadManager(path.join(dataDir, 'uploads'), uploadSessionStore);
const mediaDir = path.join(dataDir, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const readBody = async req => { let body = ''; for await (const c of req) body += c; return body; };
const readRawBody = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };

async function auth(req, res) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { json(res, 401, { error: 'Missing bearer token' }); return null; }
  const clientId = process.env.GOOGLE_CLIENT_ID, allowedEmail = process.env.ALLOWED_EMAIL;
  if (!clientId || !allowedEmail) { json(res, 501, { error: 'Google auth is not configured on this server (set GOOGLE_CLIENT_ID and ALLOWED_EMAIL)' }); return null; }
  try { return await verifyGoogleIdToken(token, { clientId, allowedEmail }); }
  catch (e) { json(res, 403, { error: `Access denied: ${e.message}` }); return null; }
}

function notify(project) {
  const note = notificationFor(project);
  if (note) { store.data.notifications.push({ ...note, projectId: project.id, at: Date.now() }); store.save(); }
}

function loadProject(id, res) {
  const project = store.data.projects[id];
  if (!project) { json(res, 404, { error: 'Project not found' }); return null; }
  return project;
}

function saveProject(project) { store.data.projects[project.id] = project; store.save(); return project; }

function deleteProjectFiles(project) {
  for (const filePath of [project.sourcePath, project.outputPath]) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && !url.pathname.startsWith('/api') && url.pathname !== '/health') {
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const safe = path.join(root, path.normalize(file));
      if (safe.startsWith(root) && fs.existsSync(safe) && fs.statSync(safe).isFile()) { res.writeHead(200); return res.end(fs.readFileSync(safe)); }
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/config') return json(res, 200, { googleClientId: process.env.GOOGLE_CLIENT_ID || null });

    const identity = await auth(req, res);
    if (!identity) return;

    if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, Object.values(store.data.projects));
    if (req.method === 'GET' && url.pathname === '/api/cost') return json(res, 200, costStatus(store.data.spend));
    if (req.method === 'GET' && url.pathname === '/api/notifications') return json(res, 200, store.data.notifications);

    if (req.method === 'POST' && url.pathname === '/api/uploads') {
      const { filename, sizeBytes } = JSON.parse(await readBody(req));
      if (!filename || !Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 1_000_000_000) return json(res, 422, { errors: ['Invalid filename or size'] });
      const id = crypto.randomUUID();
      return json(res, 201, uploads.create(id, sizeBytes));
    }
    const uploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)(\/complete)?$/);
    if (uploadMatch) {
      const [, id, complete] = uploadMatch;
      if (!complete && req.method === 'GET') {
        try { return json(res, 200, uploads.status(id)); } catch (e) { return json(res, 404, { error: e.message }); }
      }
      if (!complete && req.method === 'PUT') {
        const offset = Number(url.searchParams.get('offset') || '0');
        try { return json(res, 200, uploads.appendChunk(id, offset, await readRawBody(req))); }
        catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (complete && req.method === 'POST') {
        const meta = JSON.parse(await readBody(req));
        let completed;
        try { completed = await uploads.complete(id); } catch (e) { return json(res, 409, { error: e.message }); }
        const errors = validateUpload({ sizeBytes: completed.sizeBytes, durationSeconds: meta.durationSeconds, width: meta.width, height: meta.height, mime: meta.mime });
        if (errors.length) { uploads.discard(id); return json(res, 422, { errors }); }
        const storageCost = estimateStorageCost(completed.sizeBytes);
        const cost = costStatus(store.data.spend, storageCost);
        if (!cost.allowed) { uploads.discard(id); return json(res, 402, { error: 'Cost ceiling reached; new uploads are blocked until spend is reviewed', cost }); }
        const mediaPath = path.join(mediaDir, id);
        fs.renameSync(completed.filePath, mediaPath);
        delete store.data.uploadSessions[id];
        store.data.spend = cost.projected;
        store.save();
        const sourceKey = duplicateKey({ sha256: completed.sha256, sizeBytes: completed.sizeBytes });
        const duplicate = Object.values(store.data.projects).find(p => p.sourceKey === sourceKey);
        const project = { id: crypto.randomUUID(), state: 'queued', sourceKey, sha256: completed.sha256, sizeBytes: completed.sizeBytes, storageCost, filename: meta.filename || 'upload', sourcePath: mediaPath, outputPath: null, renderStatus: 'none', outputKey: null, attempts: 0, segments: [], duplicateOf: duplicate?.id ?? null };
        saveProject(project);
        notify(project);
        return json(res, 201, project);
      }
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(transcribe|transcript|render|approve|retry|download))?$/);
    if (projectMatch) {
      const [, id, action] = projectMatch;
      if (req.method === 'DELETE' && !action) {
        const project = loadProject(id, res); if (!project) return;
        deleteProjectFiles(project);
        delete store.data.projects[id];
        if (project.storageCost) store.data.spend = Math.max(0, store.data.spend - project.storageCost);
        store.save();
        return json(res, 200, { deleted: true });
      }
      if (action === 'transcribe' && req.method === 'POST') {
        const project = loadProject(id, res); if (!project) return;
        let updated;
        try { updated = transition(project, 'processing'); } catch (e) { return json(res, 400, { error: e.message }); }
        saveProject(updated);
        if (!process.env.TRANSCRIPTION_API_KEY) return json(res, 501, { error: 'Transcription provider not configured (set TRANSCRIPTION_API_KEY)', manual: true, project: updated });
        return json(res, 501, { error: 'Transcription provider adapter not yet implemented', manual: true, project: updated });
      }
      if (action === 'transcript' && req.method === 'POST') {
        const project = loadProject(id, res); if (!project) return;
        const { segments } = JSON.parse(await readBody(req));
        const updated = editTranscript(project, segments || []);
        saveProject(updated);
        return json(res, 200, updated);
      }
      if (action === 'render' && req.method === 'POST') {
        const project = loadProject(id, res); if (!project) return;
        if (process.env.RENDER_ENABLED !== 'true') return json(res, 501, { error: 'Render worker not configured (set RENDER_ENABLED=true with an FFmpeg worker deployed)', manual: true, project });
        return json(res, 501, { error: 'Render worker adapter not yet implemented', manual: true, project });
      }
      if (action === 'approve' && req.method === 'POST') {
        const project = loadProject(id, res); if (!project) return;
        if (!canApprove(project)) return json(res, 409, { error: 'Project is not ready for approval (needs a current render)' });
        const cost = costStatus(store.data.spend);
        if (!cost.allowed) return json(res, 402, { error: 'Cost ceiling reached; approve blocked until reviewed', cost });
        let updated;
        try { updated = transition(project, 'awaiting approval'); } catch (e) { return json(res, 400, { error: e.message }); }
        saveProject(updated);
        if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_CHANNEL_ID) {
          return json(res, 501, { error: 'Slack is not configured (set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID); use manual download instead', manual: true, downloadUrl: `/api/projects/${id}/download`, project: updated });
        }
        return json(res, 501, { error: 'Slack send adapter not yet implemented', manual: true, downloadUrl: `/api/projects/${id}/download`, project: updated });
      }
      if (action === 'retry' && req.method === 'POST') {
        const project = loadProject(id, res); if (!project) return;
        const updated = retry(project);
        saveProject(updated);
        notify(updated);
        return json(res, 200, updated);
      }
      if (action === 'download' && req.method === 'GET') {
        const project = loadProject(id, res); if (!project) return;
        const filePath = project.outputPath || project.sourcePath;
        if (!filePath || !fs.existsSync(filePath)) return json(res, 404, { error: 'No file available yet' });
        const safeName = project.filename.replace(/[\\"\r\n\x00-\x1f]/g, '_');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(project.filename)}` });
        return fs.createReadStream(filePath).pipe(res);
      }
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});
server.listen(process.env.PORT || 3000);
