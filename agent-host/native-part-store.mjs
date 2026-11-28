import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^[a-f0-9]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_STORE_BYTES = 512 * 1024 * 1024;
const MIME = new Set(['audio/wav', 'video/mp4']);
const error = (reason) => new Error(reason);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function sourceKey(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.resourceId !== 'string' || !source.resourceId || typeof source.version !== 'string' || !source.version
      || JSON.stringify(source).length > 4096) {
    throw error('missing_media_source');
  }
  return JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))));
}

function normalizeRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const canvasId = typeof ref.canvasId === 'string' ? ref.canvasId.trim() : '';
  const sessionId = typeof ref.sessionId === 'string' ? ref.sessionId.trim() : '';
  if (!canvasId || !sessionId || canvasId.length > 256 || sessionId.length > 256) return null;
  return { canvasId, sessionId };
}

function refKey(ref) {
  return `${ref.canvasId}\0${ref.sessionId}`;
}

function validateRefs(refs) {
  if (refs === undefined) return;
  if (!Array.isArray(refs) || refs.length > 4096) throw error('native_part_manifest_changed');
  for (const item of refs) {
    if (!normalizeRef(item)) throw error('native_part_manifest_changed');
  }
}

function atomic(directory, file, bytes) {
  const temporary = path.join(directory, `.part-${crypto.randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  catch (cause) { fs.closeSync(fd); fs.rmSync(temporary, { force: true }); throw cause; }
  fs.closeSync(fd);
  try { fs.renameSync(temporary, file); } catch (cause) { fs.rmSync(temporary, { force: true }); throw cause; }
  // Directory fsync makes the rename durable on supported local filesystems.
  // Windows cannot open directories with this POSIX mode.
  if (process.platform !== 'win32') {
    const handle = fs.openSync(directory, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  }
}

// These files are formal session media references, not disposable temp cache.
// Only a validated backend tool result is admitted; reads never create files.
// Eviction only removes parts with zero active/existing session references.
export function createNativePartStore({ directory }) {
  if (!directory) throw error('native_part_directory_required');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  function manifest(id) {
    if (!ID.test(id)) throw error('invalid_native_part_reference');
    const file = path.join(directory, `${id}.json`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw error('invalid_native_part_reference');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.id !== id || value.sha256 !== id || !MIME.has(value.mimeType)
        || !Number.isInteger(value.size) || value.size <= 0 || value.size > MAX_BYTES
        || !Array.isArray(value.sources) || !value.sources.length) {
      throw error('native_part_manifest_changed');
    }
    for (const source of value.sources) sourceKey(source);
    validateRefs(value.refs);
    return value;
  }

  function read(reference) {
    const id = typeof reference === 'string' ? reference : reference?.id;
    const stored = manifest(id);
    const source = typeof reference === 'string' ? stored.sources[0] : reference.source;
    if (typeof reference !== 'string' && (reference.sha256 !== id || reference.mimeType !== stored.mimeType)) {
      throw error('native_part_manifest_changed');
    }
    if (!stored.sources.some((candidate) => sourceKey(candidate) === sourceKey(source))) {
      throw error('native_part_source_changed');
    }
    const file = path.join(directory, `${id}.bin`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw error('invalid_native_part_reference');
    if (stat.size !== stored.size || stat.size > MAX_BYTES) throw error('media_content_changed');
    const bytes = fs.readFileSync(file);
    if (sha(bytes) !== id) throw error('media_content_changed');
    return { type: 'media', mimeType: stored.mimeType, data: bytes.toString('base64'), sha256: id, source };
  }

  function statSize(id) {
    if (!ID.test(String(id || ''))) return 0;
    try {
      const stored = manifest(id);
      return stored.size;
    } catch {
      return 0;
    }
  }

  function write(part, refContext = null) {
    if (part?.type !== 'media' || !MIME.has(part.mimeType) || typeof part.data !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data) || part.data.length > MAX_BYTES * 4 / 3 + 4 || !ID.test(part.sha256)) {
      throw error('invalid_media_content');
    }
    const bytes = Buffer.from(part.data, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== part.data) {
      throw error('invalid_media_content');
    }
    if (sha(bytes) !== part.sha256) throw error('media_content_changed');
    const key = sourceKey(part.source);
    const id = part.sha256;
    const file = path.join(directory, `${id}.json`);
    const sessionRef = normalizeRef(refContext || {
      canvasId: part.source?.canvasId,
      sessionId: refContext?.sessionId,
    });
    let value = {
      version: 1,
      id,
      sha256: id,
      mimeType: part.mimeType,
      size: bytes.length,
      sources: [part.source],
      ...(sessionRef ? { refs: [sessionRef] } : {}),
    };
    if (fs.existsSync(file)) {
      const previous = manifest(id);
      read(id); // Never repair over a tampered or missing formal reference.
      if (previous.mimeType !== part.mimeType) throw error('native_part_manifest_changed');
      value = previous;
      if (!value.sources.some((source) => sourceKey(source) === key)) value.sources.push(part.source);
      if (sessionRef) {
        const refs = Array.isArray(value.refs) ? value.refs : [];
        if (!refs.some((item) => refKey(item) === refKey(sessionRef))) {
          refs.push(sessionRef);
        }
        value.refs = refs;
      }
    } else {
      atomic(directory, path.join(directory, `${id}.bin`), bytes);
    }
    atomic(directory, file, JSON.stringify(value));
    return { id, sha256: id, mimeType: part.mimeType, source: part.source };
  }

  function listManifestIds() {
    let entries;
    try { entries = fs.readdirSync(directory); } catch { return []; }
    const ids = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (ID.test(id)) ids.push(id);
    }
    return ids;
  }

  function releaseSession(canvasId, sessionId) {
    const target = normalizeRef({ canvasId, sessionId });
    if (!target) return { updated: 0, unreferencedIds: [] };
    const targetKey = refKey(target);
    let updated = 0;
    const unreferencedIds = [];
    for (const id of listManifestIds()) {
      let stored;
      try { stored = manifest(id); } catch { continue; }
      if (!Array.isArray(stored.refs)) continue;
      const nextRefs = stored.refs.filter((item) => refKey(item) !== targetKey);
      if (nextRefs.length === stored.refs.length) continue;
      stored.refs = nextRefs;
      atomic(directory, path.join(directory, `${id}.json`), JSON.stringify(stored));
      updated += 1;
      if (nextRefs.length === 0) unreferencedIds.push(id);
    }
    return { updated, unreferencedIds };
  }

  function copySessionRefs(canvasId, fromSessionId, toSessionId) {
    const fromRef = normalizeRef({ canvasId, sessionId: fromSessionId });
    const toRef = normalizeRef({ canvasId, sessionId: toSessionId });
    if (!fromRef || !toRef || refKey(fromRef) === refKey(toRef)) return { copied: 0 };
    const fromKey = refKey(fromRef);
    const toKey = refKey(toRef);
    let copied = 0;
    for (const id of listManifestIds()) {
      let stored;
      try { stored = manifest(id); } catch { continue; }
      if (!Array.isArray(stored.refs)) continue;
      if (!stored.refs.some((item) => refKey(item) === fromKey)) continue;
      if (stored.refs.some((item) => refKey(item) === toKey)) continue;
      stored.refs = [...stored.refs, toRef];
      atomic(directory, path.join(directory, `${id}.json`), JSON.stringify(stored));
      copied += 1;
    }
    return { copied };
  }

  // Reference-aware eviction: NEVER evicts any part with >=1 live session reference
  // regardless of mtime or total store bytes. Only parts with zero live references
  // are eligible for deletion when totalBytes exceeds maxTotalBytes.
  function pruneUnreferenced({ maxTotalBytes = DEFAULT_MAX_STORE_BYTES, isSessionAlive = null } = {}) {
    const limit = Number.isFinite(maxTotalBytes) && maxTotalBytes >= 0 ? maxTotalBytes : DEFAULT_MAX_STORE_BYTES;
    const records = [];
    let totalBytes = 0;

    for (const id of listManifestIds()) {
      let stored;
      try { stored = manifest(id); } catch { continue; }
      const binFile = path.join(directory, `${id}.bin`);
      const jsonFile = path.join(directory, `${id}.json`);
      let binSize = 0;
      let mtimeMs = 0;
      try {
        const stat = fs.lstatSync(binFile);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          binSize = stat.size;
          mtimeMs = stat.mtimeMs;
        }
      } catch { /* missing bin */ }
      totalBytes += binSize;

      let liveRefs = stored.refs;
      if (Array.isArray(stored.refs) && typeof isSessionAlive === 'function') {
        liveRefs = stored.refs.filter((ref) => {
          try { return Boolean(isSessionAlive(ref.canvasId, ref.sessionId)); }
          catch { return true; }
        });
        if (liveRefs.length !== stored.refs.length) {
          stored.refs = liveRefs;
          atomic(directory, jsonFile, JSON.stringify(stored));
        }
      }
      const unreferenced = Array.isArray(liveRefs) && liveRefs.length === 0;
      records.push({ id, binFile, jsonFile, binSize, mtimeMs, unreferenced });
    }

    const deleted = [];
    let reclaimedBytes = 0;
    if (totalBytes > limit) {
      const candidates = records
        .filter((item) => item.unreferenced)
        .sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
      for (const item of candidates) {
        if (totalBytes <= limit) break;
        fs.rmSync(item.binFile, { force: true });
        fs.rmSync(item.jsonFile, { force: true });
        totalBytes = Math.max(0, totalBytes - item.binSize);
        reclaimedBytes += item.binSize;
        deleted.push(item.id);
      }
    }

    return {
      deleted,
      kept: records.length - deleted.length,
      totalBytes,
      reclaimedBytes,
    };
  }

  return {
    write,
    read,
    statSize,
    releaseSession,
    copySessionRefs,
    pruneUnreferenced,
  };
}
