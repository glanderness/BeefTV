// pi-creative-media: Pure, BeefTV-agnostic Pi 1.6.0 creative-media extension pack.
// Composes multimodal payload adaptation, pre-commit Photon image fitting,
// configurable beforeCompact checkpointing, and content-progress SSE idle watchdogs.
export {
  createConfigurableCompactionExtension,
  extractBlockText,
  recordUsageToUsageDoc,
  serializeConversationTranscript,
} from './compaction.mjs';
export { createPhotonImageManager } from './fit-images.mjs';
export {
  DEFAULT_MAX_PART_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MEDIA_MIME_TYPES,
  adaptAnthropicUnpinnedRequest,
  adaptMultimodalRequest,
  collectTrustedMediaSources,
  createMediaPayloadExtension,
  defaultSupportsNativeMedia,
  downgradeUnpinnedAssistantMessages,
  formatDegradedMediaPlaceholder,
  isGeminiModelId,
  validateMediaPart,
} from './media-payload.mjs';
export {
  DEFAULT_STREAM_IDLE_MS,
  createScopedStreamIdleFetch,
  fetchWithContentProgressIdle,
} from './stream-idle.mjs';

import { createConfigurableCompactionExtension } from './compaction.mjs';
import { createPhotonImageManager } from './fit-images.mjs';
import { createMediaPayloadExtension } from './media-payload.mjs';

export async function createCreativeMediaExtensions({
  compaction = null,
  fitImages = null,
  mediaPayload = null,
} = {}) {
  const extensions = [];
  if (mediaPayload !== false) {
    extensions.push(createMediaPayloadExtension(mediaPayload || {}));
  }
  if (compaction !== false && compaction) {
    extensions.push(createConfigurableCompactionExtension(compaction));
  }
  if (fitImages !== false && fitImages) {
    const manager = fitImages.manager || createPhotonImageManager(fitImages.photonOptions);
    extensions.push(await manager.createExtension(fitImages.fitOptions));
  }
  return extensions;
}
