// BeefTV scoped SSE content-progress idle watchdog — delegates directly to pi-creative-media.
export {
  DEFAULT_STREAM_IDLE_MS as DEFAULT_MODEL_STREAM_IDLE_MS,
  createScopedStreamIdleFetch,
  fetchWithContentProgressIdle as fetchModelWithProgressIdle,
} from './extensions/pi-creative-media/stream-idle.mjs';
