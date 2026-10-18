import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

export function createSessionPersistence(file, sessions, { now = () => Date.now(), ttlMs = 48 * 60 * 60_000, maxSessions = 120 } = {}) {
  let queue = Promise.resolve();
  const ready = file ? (async () => {
    let raw;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw new AppError('SESSION_STORAGE', 'Saved briefs could not be read. Check the local session store.', 503); }
    if (raw.length > 12_000_000) throw new AppError('SESSION_STORAGE', 'The local brief store exceeds its size limit.', 503);
    let data;
    try { data = JSON.parse(raw); } catch { throw new AppError('SESSION_STORAGE', 'The local brief store could not be parsed. Its file has been preserved.', 503); }
    if (data.schemaVersion !== 'fieldwork.sessions.v1' || !Array.isArray(data.sessions)) throw new AppError('SESSION_STORAGE', 'The local brief store has an unsupported format.', 503);
    for (const item of data.sessions.slice(-maxSessions)) {
      const state = item?.state;
      if (state?.schemaVersion !== 'fieldwork.run.v1' || typeof state.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(state.runId) || !Number.isInteger(state.revision) || !['fixture', 'live'].includes(state.dataMode) || !Number.isFinite(item.touched) || now() - item.touched > ttlMs) continue;
      sessions.set(state.runId, item);
    }
  })() : Promise.resolve();

  async function save() {
    if (!file) return;
    const data = JSON.stringify({ schemaVersion: 'fieldwork.sessions.v1', savedAt: new Date(now()).toISOString(), sessions: [...sessions.values()].slice(-maxSessions) });
    queue = queue.catch(() => {}).then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, file);
      } catch { throw new AppError('SESSION_STORAGE', 'The brief could not be saved to the local session store. The previous file is preserved.', 503); }
    });
    await queue;
  }
  return { ready, save, ttlMs };
}
