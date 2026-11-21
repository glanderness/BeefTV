import { audioMimeType } from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}
