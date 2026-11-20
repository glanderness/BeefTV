// LL2 (DMC) 预置模型清单、渠道构建与旧配置自动修复逻辑。

export const DEFAULT_BASE_URL = "https://api.ll2.cn";
export const LL2_CHANNEL_ID = "ll2";
export const LL2_CHANNEL_NAME = "LL2 (DMC)";

const DEFAULT_VIDEO_REFERENCES = {
  promptMaxChars: 2000,
  minImages: 0,
  maxImages: 9,
  maxImageBytes: 30 * 1024 * 1024,
  minImageWidth: 0,
  maxImageWidth: 0,
  minImageHeight: 0,
  maxImageHeight: 0,
  minImageAspectRatio: 0,
  maxImageAspectRatio: 0,
  minImagePixels: 0,
  maxImagePixels: 0,
  maxVideos: 3,
  maxVideoBytes: 200 * 1024 * 1024,
  minVideoDurationSeconds: 0,
  maxVideoDurationSeconds: 15,
  maxVideoTotalDurationSeconds: 0,
  minVideoWidth: 0,
  maxVideoWidth: 0,
  minVideoHeight: 0,
  maxVideoHeight: 0,
  minVideoAspectRatio: 0,
  maxVideoAspectRatio: 0,
  minVideoPixels: 0,
  maxVideoPixels: 0,
  minVideoFps: 0,
  maxVideoFps: 0,
  maxAudios: 3,
  maxAudioBytes: 15 * 1024 * 1024,
  minAudioDurationSeconds: 0,
  maxAudioDurationSeconds: 15,
  maxAudioTotalDurationSeconds: 0,
  maxTotalReferences: 0,
};

const WAN3_VIDEO_CAPABILITY = {
  version: 1,
  video: {
    references: {
      ...DEFAULT_VIDEO_REFERENCES,
      promptMaxChars: 20000,
      maxImages: 10,
      maxImageBytes: 20 * 1024 * 1024,
      maxVideos: 5,
      maxVideoBytes: 100 * 1024 * 1024,
      minVideoDurationSeconds: 1,
      maxVideoDurationSeconds: 15,
      maxVideoTotalDurationSeconds: 15,
      maxAudios: 5,
      maxAudioBytes: 15 * 1024 * 1024,
      minAudioDurationSeconds: 1,
      maxAudioDurationSeconds: 15,
      maxAudioTotalDurationSeconds: 15,
    },
    duration: { selection: "range", min: 2, max: 30, step: 1, default: 5 },
    ratios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"],
    defaultRatio: "16:9",
    resolutions: ["480P", "720P", "1080P"],
    defaultResolution: "720P",
    generateAudio: { supported: true, default: true },
    watermark: { supported: true, default: false },
    operations: ["text_to_video", "image_to_video", "reference_to_video"],
    defaultOperation: "text_to_video",
    operationReferences: {
      text_to_video: { maxImages: 0, maxVideos: 0, maxAudios: 0 },
      image_to_video: { minImages: 1, maxImages: 2, maxVideos: 0, maxAudios: 0 },
      reference_to_video: { maxImages: 10, maxVideos: 5, maxAudios: 5 },
    },
  },
};

const SUPER_VEGA_RESOLUTIONS = ["480P", "720P", "768P", "1080P", "2K", "4K"];

function superVegaVideoCapability({
  maxDuration = 15,
  audioSupported = true,
  defaultResolution = "720P",
  promptMaxChars = 2000,
  maxImages = 9,
  maxVideos = 3,
  maxVideoBytes = 50 * 1024 * 1024,
  maxAudios = 3,
  maxTotalReferences = 12,
} = {}) {
  return {
    version: 1,
    video: {
      references: {
        ...DEFAULT_VIDEO_REFERENCES,
        promptMaxChars,
        maxImages,
        maxVideos,
        maxVideoBytes,
        minVideoDurationSeconds: 2,
        maxVideoDurationSeconds: maxDuration,
        maxVideoTotalDurationSeconds: maxDuration,
        maxAudios,
        minAudioDurationSeconds: 2,
        maxAudioDurationSeconds: maxDuration,
        maxAudioTotalDurationSeconds: maxDuration,
        maxTotalReferences,
      },
      duration: { selection: "range", min: 4, max: maxDuration, step: 1, default: 5 },
      ratios: ["adaptive", "16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
      defaultRatio: "16:9",
      resolutions: SUPER_VEGA_RESOLUTIONS,
      defaultResolution,
      generateAudio: { supported: audioSupported, default: audioSupported },
      watermark: { supported: false, default: false },
      operations: ["text_to_video", "image_to_video", "reference_to_video"],
      defaultOperation: "text_to_video",
    },
  };
}

export const LL2_PRESET_MODELS = [
  {
    model: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: {
      version: 1,
      text: {
        references: { promptMaxChars: 12000, maxImages: 0, maxImageBytes: 0 },
        streaming: true,
        thinking: true,
      },
    },
  },
  {
    model: "wan3.0-video",
    displayName: "Wan 3.0 Video",
    family: "Wan 3.0",
    capability: "video",
    protocol: "ll2-wan3-video",
    endpoint: "POST /ali/api/v1/services/aigc/video-generation/video-synthesis",
    capabilityConfig: WAN3_VIDEO_CAPABILITY,
  },
  {
    model: "wan3.0-video-prime",
    displayName: "Wan 3.0 Video Prime",
    family: "Wan 3.0",
    capability: "video",
    protocol: "ll2-wan3-video",
    endpoint: "POST /ali/api/v1/services/aigc/video-generation/video-synthesis",
    capabilityConfig: WAN3_VIDEO_CAPABILITY,
  },
  {
    model: "doubao-seedance-2-0-fast",
    displayName: "Seedance 2.0 Fast",
    family: "Seedance 2.0",
    capability: "video",
    protocol: "ll2-seedance-video",
    endpoint: "POST /seedance/api/v3/contents/generations/tasks",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480p", "720p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "doubao-seedance-2-0-mini",
    displayName: "Seedance 2.0 Mini",
    family: "Seedance 2.0",
    capability: "video",
    protocol: "ll2-seedance-video",
    endpoint: "POST /seedance/api/v3/contents/generations/tasks",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480p", "720p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "doubao-seedance-2-0",
    displayName: "Seedance 2.0",
    family: "Seedance 2.0",
    capability: "video",
    protocol: "ll2-seedance-video",
    endpoint: "POST /seedance/api/v3/contents/generations/tasks",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480p", "720p", "1080p", "4k"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "doubao-seedance-2-5",
    displayName: "Seedance 2.5",
    family: "Seedance 2.5",
    capability: "video",
    protocol: "ll2-seedance-video",
    endpoint: "POST /seedance/api/v3/contents/generations/tasks",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 30,
          maxVideos: 10,
          minVideoDurationSeconds: 2,
          maxVideoDurationSeconds: 30,
          maxVideoTotalDurationSeconds: 30,
          maxAudios: 10,
          minAudioDurationSeconds: 2,
          maxAudioDurationSeconds: 30,
          maxAudioTotalDurationSeconds: 30,
        },
        duration: { selection: "range", min: 4, max: 30, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480p", "720p", "1080p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        taskTypeConstraints: true,
        operations: ["text_to_video", "image_to_video", "reference_to_video", "audio_to_video", "inpaint", "extend"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "viduq3-turbo",
    displayName: "Vidu Q3 Turbo",
    family: "Vidu Q3",
    capability: "video",
    protocol: "ll2-vidu-video",
    endpoint: "POST /vidu/ent/v2/text2video",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 2,
          maxVideos: 0,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 1, max: 16, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
        defaultRatio: "16:9",
        resolutions: ["540p", "720p", "1080p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "viduq3-pro",
    displayName: "Vidu Q3 Pro",
    family: "Vidu Q3",
    capability: "video",
    protocol: "ll2-vidu-video",
    endpoint: "POST /vidu/ent/v2/text2video",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 2,
          maxVideos: 0,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 1, max: 16, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
        defaultRatio: "16:9",
        resolutions: ["540p", "720p", "1080p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "MiniMax-H3",
    displayName: "MiniMax H3",
    family: "MiniMax H3",
    capability: "video",
    protocol: "ll2-minimax-video",
    endpoint: "POST /v2/video_generation",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxVideoBytes: 50 * 1024 * 1024,
        },
        duration: {
          selection: "enum",
          values: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          default: 5,
        },
        ratios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        defaultRatio: "16:9",
        resolutions: ["768P"],
        defaultResolution: "768P",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "Super Vega 1.0-pro-mini",
    displayName: "Super Vega 1.0 Pro Mini",
    family: "Super Vega",
    capability: "video",
    protocol: "ll2-super-vega-video",
    endpoint: "POST /super-vega/tasks",
    capabilityConfig: superVegaVideoCapability({ maxDuration: 15, audioSupported: true }),
  },
  {
    model: "Super Vega 1.0-pro-fast",
    displayName: "Super Vega 1.0 Pro Fast",
    family: "Super Vega",
    capability: "video",
    protocol: "ll2-super-vega-video",
    endpoint: "POST /super-vega/tasks",
    capabilityConfig: superVegaVideoCapability({ maxDuration: 15, audioSupported: true }),
  },
  {
    model: "Super Vega 1.0-pro",
    displayName: "Super Vega 1.0 Pro",
    family: "Super Vega",
    capability: "video",
    protocol: "ll2-super-vega-video",
    endpoint: "POST /super-vega/tasks",
    capabilityConfig: superVegaVideoCapability({ maxDuration: 15, audioSupported: true }),
  },
  {
    model: "Super Vega 1.5-pro",
    displayName: "Super Vega 1.5 Pro",
    family: "Super Vega",
    capability: "video",
    protocol: "ll2-super-vega-video",
    endpoint: "POST /super-vega/tasks",
    capabilityConfig: superVegaVideoCapability({
      maxDuration: 30,
      audioSupported: true,
      maxImages: 30,
      maxVideos: 10,
      maxVideoBytes: 200 * 1024 * 1024,
      maxAudios: 10,
      maxTotalReferences: 50,
    }),
  },
  {
    model: "Super Vega 1.0-lite",
    displayName: "Super Vega 1.0 Lite",
    family: "Super Vega",
    capability: "video",
    protocol: "ll2-super-vega-video",
    endpoint: "POST /super-vega/tasks",
    capabilityConfig: superVegaVideoCapability({ maxDuration: 15, audioSupported: true, defaultResolution: "768P", promptMaxChars: 7000 }),
  },
  {
    model: "auto-hd",
    displayName: "Auto HD 视频超分",
    family: "Auto HD 超分",
    capability: "video",
    protocol: "ll2-auto-hd-video",
    endpoint: "POST /hd/tasks",
    defaultOptions: {
      testVideoUrl:
        "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241115/cqqkru/1.mp4",
    },
    capabilityConfig: {
      version: 1,
      video: {
        durationSupported: false,
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 0,
          maxVideos: 1,
          maxVideoBytes: 500 * 1024 * 1024,
          maxVideoDurationSeconds: 300,
          maxAudios: 0,
        },
        duration: { selection: "enum", values: [5], default: 5 },
        ratios: [],
        defaultRatio: "",
        resolutions: ["1080p", "2k", "4k"],
        defaultResolution: "1080p",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["reference_to_video"],
        defaultOperation: "reference_to_video",
      },
    },
  },
];

function isLL2ChannelLike(channel) {
  if (!channel || typeof channel !== "object") return false;
  if (channel.id === LL2_CHANNEL_ID) return true;
  try {
    const host = new URL(String(channel.baseUrl || "").trim()).hostname.toLowerCase();
    return host === "api.ll2.cn" || host.endsWith(".ll2.cn");
  } catch {
    return false;
  }
}

function alignResolutionsToPreset(currentRes, presetRes, currentDefault, presetDefault) {
  if (!Array.isArray(presetRes) || !Array.isArray(currentRes)) return null;
  const canonicalByUpper = new Map(presetRes.map((item) => [String(item).trim().toUpperCase(), item]));
  const lookupCanonical = (rawVal) => {
    const key = String(rawVal || "").trim().toUpperCase();
    if (!key) return undefined;
    const direct = canonicalByUpper.get(key) || canonicalByUpper.get(`${key}P`);
    if (direct) return direct;
    if (key === "1440" || key === "1440P") return canonicalByUpper.get("2K");
    if (key === "2160" || key === "2160P") return canonicalByUpper.get("4K");
    return undefined;
  };
  const mapped = [];
  let changed = false;
  for (const raw of currentRes) {
    const canonical = lookupCanonical(raw);
    if (!canonical) {
      changed = true;
      continue;
    }
    if (canonical !== raw) changed = true;
    if (!mapped.includes(canonical)) mapped.push(canonical);
  }
  const resolutions = !changed && mapped.length === currentRes.length
    ? currentRes
    : mapped.length > 0
      ? mapped
      : [...presetRes];
  const defaultKey = String(currentDefault || "").trim().toUpperCase();
  const mappedDefault =
    lookupCanonical(currentDefault) ||
    (["1440", "1440P", "2K", "2160", "2160P", "4K"].includes(defaultKey) ? canonicalByUpper.get("1080P") : undefined);
  const defaultResolution = mappedDefault && resolutions.includes(mappedDefault)
    ? mappedDefault
    : resolutions.includes(presetDefault)
      ? presetDefault
      : resolutions[0];
  if (!changed && mapped.length === currentRes.length && defaultResolution === currentDefault) {
    return null;
  }
  return { resolutions, defaultResolution };
}

function stableJson(value) {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

export function upgradeLL2ModelProfile(profile, channel, presetModels = LL2_PRESET_MODELS) {
  if (!profile || typeof profile !== "object") return profile;
  const isLL2Protocol = String(profile.protocol || "").startsWith("ll2-");
  if (!isLL2Protocol && !isLL2ChannelLike(channel)) return profile;
  if (
    (typeof profile.imageCapabilitiesVersion === "string" && profile.imageCapabilitiesVersion.trim()) ||
    (typeof profile.videoCapabilitiesVersion === "string" && profile.videoCapabilitiesVersion.trim())
  ) {
    return profile;
  }
  const preset = presetModels.find((item) => item.model === profile.model);
  if (!preset) return profile;

  let next = profile;
  if (preset.defaultOptions?.testVideoUrl) {
    const currentUrl = String(next.defaultOptions?.testVideoUrl || "");
    if (!currentUrl || currentUrl.includes("cos.ap-guangzhou.myqcloud.com")) {
      next = {
        ...next,
        defaultOptions: {
          ...(next.defaultOptions || {}),
          ...preset.defaultOptions,
        },
      };
    }
  }

  // 用户此前通过「读取模型」勾选但当时尚未纳入预置的模型（如 wan3.0-video 落到了通用 newapi），
  // 在插件升级后自动切回对应的 LL2 专属协议与参数规格。
  if (next.protocol !== preset.protocol || next.capability !== preset.capability) {
    next = {
      ...next,
      displayName: next.displayName || preset.displayName,
      capability: preset.capability,
      protocol: preset.protocol,
      authType: "bearer",
    };
    if (next.capabilitySource !== "user") {
      return {
        ...next,
        capabilityConfig: structuredClone(preset.capabilityConfig),
      };
    }
  }

  if (next.capabilitySource !== "user") {
    if (stableJson(next.capabilityConfig) !== stableJson(preset.capabilityConfig)) {
      return {
        ...next,
        capabilityConfig: structuredClone(preset.capabilityConfig),
      };
    }
    return next;
  }

  const presetVideo = preset.capabilityConfig?.video;
  const currentVideo = next.capabilityConfig?.video;
  if (presetVideo && currentVideo) {
    const resPatch = alignResolutionsToPreset(
      currentVideo.resolutions,
      presetVideo.resolutions,
      currentVideo.defaultResolution,
      presetVideo.defaultResolution,
    );
    let ratiosPatch = null;
    if (Array.isArray(presetVideo.ratios) && Array.isArray(currentVideo.ratios) && presetVideo.ratios.length > 0) {
      const validRatios = new Set(presetVideo.ratios);
      if (currentVideo.ratios.some((r) => !validRatios.has(r))) {
        const filtered = currentVideo.ratios.filter((r) => validRatios.has(r));
        const ratios = filtered.length > 0 ? filtered : [...presetVideo.ratios];
        const defaultRatio = ratios.includes(currentVideo.defaultRatio)
          ? currentVideo.defaultRatio
          : presetVideo.defaultRatio;
        ratiosPatch = { ratios, defaultRatio };
      }
    }
    if (resPatch || ratiosPatch) {
      next = {
        ...next,
        capabilityConfig: {
          ...next.capabilityConfig,
          video: {
            ...currentVideo,
            ...(resPatch || {}),
            ...(ratiosPatch || {}),
          },
        },
      };
    }
  }
  return next;
}

export function buildLL2ModelChannel({ apiKey, baseUrl, selectedModels, existingChannel, presetModels: sourcePresets = LL2_PRESET_MODELS }) {
  const cleanUrl = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const cleanKey = String(apiKey || "").trim();
  const presetById = new Map(sourcePresets.map((item) => [item.model, item]));
  const chosenList =
    Array.isArray(selectedModels) && selectedModels.length
      ? selectedModels
      : sourcePresets.map((item) => item.model);
  const chosenSet = new Set(chosenList);

  const activePresets = sourcePresets.filter((item) => chosenSet.has(item.model));
  const presetModels = activePresets.map((item) => item.model);
  const presetProfiles = activePresets.map((item) => ({
    model: item.model,
    displayName: item.displayName,
    capability: item.capability,
    protocol: item.protocol,
    authType: "bearer",
    ...(item.defaultOptions ? { defaultOptions: item.defaultOptions } : {}),
    capabilityConfig: structuredClone(item.capabilityConfig),
  }));

  const existingCustomModels = Array.isArray(existingChannel?.models)
    ? existingChannel.models.filter(
        (modelId) => typeof modelId === "string" && modelId.trim() && !presetById.has(modelId) && chosenSet.has(modelId),
      )
    : [];
  const existingCustomProfiles = Array.isArray(existingChannel?.modelProfiles)
    ? existingChannel.modelProfiles.filter(
        (profile) => profile && typeof profile.model === "string" && !presetById.has(profile.model) && chosenSet.has(profile.model),
      )
    : [];

  return {
    id: LL2_CHANNEL_ID,
    name: LL2_CHANNEL_NAME,
    scope: "user",
    baseUrl: cleanUrl,
    apiKey: cleanKey,
    hasApiKey: Boolean(cleanKey),
    apiFormat: "openai",
    models: [...presetModels, ...existingCustomModels],
    modelProfiles: [...presetProfiles, ...existingCustomProfiles],
  };
}

export const BUILTIN_SERVICE_PRESET = {
  id: LL2_CHANNEL_ID,
  name: LL2_CHANNEL_NAME,
  subtitle: "文本 · 多款主流视频 · 视频超分",
  icon: "OpenAI",
  baseUrl: DEFAULT_BASE_URL,
  partner: true,
  keysUrl: "https://hub.ll2.cn?p=rw6t",
  websiteUrl: "https://hub.ll2.cn?p=rw6t",
  protocolPrefixes: ["ll2-"],
  hosts: ["api.ll2.cn"],
  hostSuffixes: [".ll2.cn"],
  candidates: { text: "chat-completion", image: "openai-image", audio: "openai-audio" },
  models: LL2_PRESET_MODELS,
  presetDescription: "文本、视频与超分",
  declaresReferenceMediaTransport: false,
  buildChannel(args) {
    return buildLL2ModelChannel({
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      selectedModels: args.selectedModels,
      existingChannel: args.existingChannel,
      presetModels: this.models,
    });
  },
  upgradeProfile(profile, channel) {
    return upgradeLL2ModelProfile(profile, channel, this.models);
  },
};
