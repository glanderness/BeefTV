// 升级 1.0.4 后保留宿主原有的压缩与重试上限。
// cacheWarming 显式关闭：官方默认 streaming 会额外打模型请求，不能叠在本宿主的单轮/总预算之上。
import { SettingsManager } from '@earendil-works/pi-coding-agent';

export const HOST_SESSION_SETTINGS = {
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  retry: {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2000,
    maxAgentDelayMs: 60000,
    provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
  },
  cacheWarming: 'off',
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
};

export function createHostSettingsManager() {
  return SettingsManager.inMemory(HOST_SESSION_SETTINGS);
}
