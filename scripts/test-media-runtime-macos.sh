#!/usr/bin/env bash
set -euo pipefail
runtime="${1:?usage: test-media-runtime-macos.sh media-runtime-directory}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/beeftv-probe-test.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
# Relocate the real runtime beside test binaries at both GUI and CLI positions.
bundle="$scratch/中文 bundle fixture/Contents"
mkdir -p "$bundle/MacOS/cli" "$bundle/Resources/agent-host"
cp -R "$runtime" "$bundle/Resources/agent-host/media-runtime"
bundled_ffmpeg="$bundle/Resources/agent-host/media-runtime/ffmpeg"
bundled_ffprobe="$bundle/Resources/agent-host/media-runtime/ffprobe"
[[ -x "$bundled_ffmpeg" && -x "$bundled_ffprobe" ]] || { echo "Bundled macOS media runtime is missing ffmpeg or ffprobe" >&2; exit 1; }

# Verify binary SHA-256 and ad-hoc code signatures match manifest.json.
python3 - "$bundle/Resources/agent-host/media-runtime" <<'PY'
import hashlib, json, pathlib, sys
rt = pathlib.Path(sys.argv[1])
manifest = json.loads((rt / "manifest.json").read_text())
assert manifest.get("probeSHA256") and hashlib.sha256((rt / "ffprobe").read_bytes()).hexdigest() == manifest["probeSHA256"], "ffprobe hash mismatch"
assert manifest.get("encoderSHA256") and hashlib.sha256((rt / "ffmpeg").read_bytes()).hexdigest() == manifest["encoderSHA256"], "ffmpeg hash mismatch"
PY
if command -v codesign >/dev/null 2>&1; then
  codesign --verify --strict "$bundled_ffprobe" "$bundled_ffmpeg"
fi

# Verify bundled encoders, decoders, transcode, AC-3 decode, and clean PATH isolation.
encoders_out="$(PATH=/usr/bin:/bin:/usr/sbin:/sbin "$bundled_ffmpeg" -hide_banner -encoders)"
grep -q " h264_videotoolbox " <<< "$encoders_out" || { echo "Missing h264_videotoolbox encoder" >&2; exit 1; }
grep -q " aac " <<< "$encoders_out" || { echo "Missing aac encoder" >&2; exit 1; }
decoders_out="$(PATH=/usr/bin:/bin:/usr/sbin:/sbin "$bundled_ffmpeg" -hide_banner -decoders)"
for dec in ac3 eac3 dca mpeg2video pcm_s16be; do
  grep -q " ${dec} " <<< "$decoders_out" || { echo "Missing ${dec} decoder" >&2; exit 1; }
done

PATH=/usr/bin:/bin:/usr/sbin:/sbin "$bundled_ffmpeg" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x180:rate=24" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 0.5 -c:v h264_videotoolbox -allow_sw 1 -b:v 2M -pix_fmt yuv420p -c:a aac "$scratch/vt-smoke.mp4"
PATH=/usr/bin:/bin:/usr/sbin:/sbin "$bundled_ffprobe" -v error -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$scratch/vt-smoke.mp4" | grep -q '^h264$'

# Verify real AC-3 audio encode + decode to WAV without system tools.
PATH=/usr/bin:/bin:/usr/sbin:/sbin "$bundled_ffmpeg" -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.25" -c:a ac3 -b:a 192k "$scratch/sample-ac3.mov"
PATH=/usr/bin:/bin:/usr/sbin:/sbin "$bundled_ffmpeg" -hide_banner -loglevel error -y \
  -i "$scratch/sample-ac3.mov" -vn -c:a pcm_s16le "$scratch/extracted.wav"
[[ -s "$scratch/extracted.wav" ]] || { echo "Extracted AC-3 WAV is empty" >&2; exit 1; }

(
  cd "$root/backend"
  go test -c ./internal/asset -o "$bundle/MacOS/BeefTV"
  go test -c ./internal/mediatools -o "$bundle/MacOS/MediaProbe"
  go test -c ./internal/editing -o "$bundle/MacOS/MediaEditing"
)
for executable in "$bundle/MacOS/BeefTV" "$bundle/MacOS/cli/beeftv"; do
  if [[ "$executable" == */cli/beeftv ]]; then cp "$bundle/MacOS/BeefTV" "$executable"; fi
  env -u CANVAS_FFPROBE_PATH -u CANVAS_FFMPEG_PATH PATH=/usr/bin:/bin:/usr/sbin:/sbin BEEFTV_TEST_BUNDLED_MEDIA=1 \
    "$executable" -test.run '^TestBundledMediaMetadataWithoutSystemFFprobe$' -test.v
done
env -u CANVAS_FFPROBE_PATH -u CANVAS_FFMPEG_PATH PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$bundle/MacOS/MediaProbe" -test.run '^TestProbeLocalDoesNotFetchPlaylistURLs$' -test.v
env -u CANVAS_FFPROBE_PATH -u CANVAS_FFMPEG_PATH PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$bundle/MacOS/MediaEditing" -test.run '^TestPortraitSubtitleStaysInsideFrame$' -test.v
