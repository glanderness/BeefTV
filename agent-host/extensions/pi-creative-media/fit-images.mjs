// Managed pre-commit image fitting lifecycle built directly on Pi 1.6.0's
// public createFitImagesExtension and createNodePhotonImages exports.
import { createFitImagesExtension } from '@earendil-works/pi-durable/images/fit';
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';

export function createPhotonImageManager({ idleMs = 30_000 } = {}) {
  let processorPromise = null;
  let processorInstance = null;

  async function getProcessor() {
    if (!processorPromise) {
      processorPromise = createNodePhotonImages({ idleMs })
        .then((processor) => {
          processorInstance = processor;
          return processor;
        })
        .catch((error) => {
          processorPromise = null;
          throw error;
        });
    }
    return processorPromise;
  }

  async function createExtension(fitOptions) {
    const processor = await getProcessor();
    return fitOptions ? createFitImagesExtension(processor, fitOptions) : createFitImagesExtension(processor);
  }

  async function close() {
    const instance = processorInstance;
    processorInstance = null;
    processorPromise = null;
    if (instance && typeof instance.close === 'function') {
      await instance.close().catch(() => {});
    }
  }

  return {
    getProcessor,
    createExtension,
    close,
  };
}
