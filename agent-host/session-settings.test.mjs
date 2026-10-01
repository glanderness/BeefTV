import { describe, expect, test } from 'bun:test';
import { createHostSettingsManager, HOST_SESSION_SETTINGS } from './session-settings.mjs';

describe('官方 SettingsManager 显式值（真实 SDK）', () => {
  test('压缩与重试钉在 0.87.1 默认值，不提高次数或保留量', () => {
    const settings = createHostSettingsManager();
    expect(settings.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      maxAgentDelayMs: 60000,
    });
    expect(settings.getProviderRetrySettings().maxRetries).toBe(0);
    expect(settings.getCacheWarmingMode()).toBe('off');
    expect(HOST_SESSION_SETTINGS.retry.maxRetries).toBe(3);
    expect(HOST_SESSION_SETTINGS.compaction.keepRecentTokens).toBe(20000);
  });
});
