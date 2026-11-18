#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: package-media-runtime-macos.sh darwin/arm64|darwin/amd64 destination [source-archive] [source-packet-output]}"
destination="${2:?destination is required}"
archive="${3:-}"
source_output="${4:-}"
[[ "$(uname -s)" == Darwin ]] || { echo "Native macOS build required" >&2; exit 1; }
case "$target" in
  darwin/arm64) apple_arch=arm64; ffmpeg_arch=aarch64 ;;
  darwin/amd64) apple_arch=x86_64; ffmpeg_arch=x86_64 ;;
  *) echo "Unsupported target: $target" >&2; exit 1 ;;
esac
[[ ! -e "$destination" ]] || { echo "Refusing to overwrite media runtime: $destination" >&2; exit 1; }
source_commit=894da5ca7d
source_url="https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/$source_commit"
source_sha=06cd2ab358134bd99e6f43b1792143e153a5b409ff1c0c88a1cf5ff9b1ea52f8
scratch="$(mktemp -d "${TMPDIR:-/tmp}/beeftv-media.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
if [[ -z "$archive" ]]; then
  archive="$scratch/source.tar.gz"
  curl --fail --location --retry 2 "$source_url" -o "$archive"
fi
[[ "$(shasum -a 256 "$archive" | cut -d ' ' -f 1)" == "$source_sha" ]] || { echo "FFmpeg source checksum mismatch" >&2; exit 1; }
mkdir "$scratch/source"
tar -xzf "$archive" --strip-components=1 -C "$scratch/source"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
flags=(--cc="$(xcrun --find clang) -arch $apple_arch" --arch="$ffmpeg_arch" --target-os=darwin
  --host-cc="$(xcrun --find clang)" --host-cflags="-isysroot $sdk" --host-ldflags="-isysroot $sdk"
  --disable-autodetect --disable-everything --disable-programs --enable-ffprobe --enable-ffmpeg
  --disable-network --enable-protocol=file,pipe
  --enable-demuxer=mov,matroska,mpegts,mpegps,m4v,mp3,wav,ogg,aac,ac3,eac3,dts,flac,avi,image2,image2pipe,image_png_pipe,image_jpeg_pipe,image_webp_pipe,image_bmp_pipe,gif,srt
  --enable-decoder=aac,ac3,eac3,dca,alac,mp3,mp3float,flac,h264,hevc,mpeg1video,mpeg2video,mpeg4,av1,vp8,vp9,opus,vorbis,prores,mjpeg,png,webp,gif,bmp,rawvideo,wrapped_avframe,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f64le,pcm_u8,pcm_mulaw,pcm_alaw,subrip,srt
  --enable-encoder=h264_videotoolbox,aac,ac3,rawvideo,wrapped_avframe,pcm_s16le,pcm_s16be,pcm_s24le,pcm_f32le,pcm_u8,png,mjpeg
  --enable-muxer=mov,mp4,null,image2,image2pipe,wav,adts,rawvideo,srt --enable-bsf=aac_adtstoasc,vp9_superframe,h264_mp4toannexb
  --enable-filter=aformat,afade,adelay,amix,anull,anullsrc,apad,aresample,asetpts,atrim,blackdetect,color,concat,crop,format,fps,hflip,null,overlay,pad,rotate,scale,select,setpts,setsar,showinfo,silencedetect,sine,testsrc,testsrc2,tpad,transpose,trim,vflip,volume,volumedetect
  --enable-parser=aac,ac3,dca,h264,hevc,mpegvideo,mpeg4video,mpegaudio,opus,vorbis,av1,vp9,vp8,png,mjpeg,webp,bmp
  --disable-x86asm --disable-shared --enable-static --disable-doc --disable-debug
  --enable-avdevice --enable-indev=lavfi --enable-avfilter --enable-swresample --enable-swscale
  --disable-iconv --enable-zlib --disable-bzlib --disable-lzma
  --disable-securetransport --enable-videotoolbox --disable-audiotoolbox
  --extra-cflags="-arch $apple_arch -isysroot $sdk -mmacosx-version-min=11.0"
  --extra-ldflags="-arch $apple_arch -isysroot $sdk -mmacosx-version-min=11.0")
if [[ "$apple_arch" == x86_64 ]]; then flags+=(--disable-inline-asm); fi
if [[ "$(uname -m)" != "$apple_arch" ]]; then flags+=(--enable-cross-compile); fi
(
  cd "$scratch/source"
  ./configure "${flags[@]}" > "$scratch/configure.log" 2>&1 || { cat "$scratch/configure.log"; tail -50 ffbuild/config.log; exit 1; }
  make -j "$(sysctl -n hw.ncpu)" ffprobe ffmpeg > "$scratch/build.log" 2>&1 || { tail -80 "$scratch/build.log"; exit 1; }
)
stage="$scratch/media-runtime"
mkdir "$stage"
cp "$scratch/source/ffprobe" "$scratch/source/ffmpeg" "$stage/"
cp "$scratch/source/COPYING.LGPLv2.1" "$stage/LICENSE"
chmod 755 "$stage/ffprobe" "$stage/ffmpeg"
file "$stage/ffmpeg" | grep -q "$apple_arch" || { echo "Wrong ffmpeg architecture" >&2; exit 1; }
file "$stage/ffprobe" | grep -q "$apple_arch" || { echo "Wrong ffprobe architecture" >&2; exit 1; }
# A release must not retain Homebrew or build-host dylib paths.
otool -L "$stage/ffprobe" "$stage/ffmpeg" | awk '/^\t/ { print $1 }' | while read -r dylib _; do
  case "$dylib" in /usr/lib/*|/System/Library/*) ;; *) echo "Non-system dependency: $dylib" >&2; exit 1 ;; esac
done
# Sign before recording SHA-256 so final distributed binaries match manifest.json and sources.json.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$stage/ffprobe" "$stage/ffmpeg"
  codesign --verify --strict "$stage/ffprobe" "$stage/ffmpeg"
fi
if [[ "$(uname -m)" == "$apple_arch" ]]; then
  "$stage/ffprobe" -version | sed -n '1p'
  "$stage/ffmpeg" -version | sed -n '1p'
fi
printf 'FFmpeg source: %s\nSource SHA256: %s\nConfigure:' "$source_url" "$source_sha" > "$stage/README.txt"
printf ' %q' "${flags[@]}" >> "$stage/README.txt"
printf '\nBuild: make ffprobe ffmpeg\nLicense: LGPL-2.1-or-later\nNetwork protocols disabled; local file and pipe only.\n' >> "$stage/README.txt"
binary_sha="$(shasum -a 256 "$stage/ffprobe" | cut -d ' ' -f 1)"
encoder_sha="$(shasum -a 256 "$stage/ffmpeg" | cut -d ' ' -f 1)"
printf '{"sourceCommit":"%s","sourceURL":"%s","sourceSHA256":"%s","probeSHA256":"%s","encoderSHA256":"%s","target":"%s","license":"LGPL-2.1-or-later"}\n' "$source_commit" "$source_url" "$source_sha" "$binary_sha" "$encoder_sha" "$target" > "$stage/manifest.json"
mkdir -p "$(dirname "$destination")"
cp -R "$stage" "$destination"
if [[ -n "$source_output" ]]; then
  python3 "$(dirname "$0")/package-macos-media-source.py" \
    --source "$archive" --runtime "$destination" --target "$target" --output "$source_output"
fi
echo "Packaged local FFmpeg and ffprobe for $target: $destination"
