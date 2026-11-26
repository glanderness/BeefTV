// 官方 Chord SQLite Telemetry 接入：仅记录无正文内容的操作耗时与指标（不含提示词或密钥），
// 7 天自动清理；打开失败时降级为空，不阻塞助手启动。
import fs from 'node:fs';
import path from 'node:path';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { createSqliteTelemetry } from '@earendil-works/chord/telemetry-sqlite';

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function openHostTelemetry(dataDir, { retentionMs = DEFAULT_RETENTION_MS } = {}) {
  if (!dataDir) return { telemetry: undefined, close: async () => {} };
  const filePath = path.join(dataDir, 'telemetry.sqlite');
  let db = null;
  let telemetry = null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    db = await openNodeSqliteDatabase(filePath);
    telemetry = await createSqliteTelemetry(db, { retentionMs });
    return {
      telemetry,
      filePath,
      close: async () => {
        try { await telemetry?.close(); } catch { /* ignore shutdown flush error */ }
        try { await db?.close(); } catch { /* ignore shutdown close error */ }
      },
    };
  } catch (error) {
    try { await telemetry?.close(); } catch {}
    try { await db?.close(); } catch {}
    console.error(`agent-host: telemetry 初始化降级 ${error?.message || error}`);
    return { telemetry: undefined, close: async () => {} };
  }
}
