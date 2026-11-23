package asset

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"hash/crc32"
	"image"
	"io"
	"strings"
)

const (
	jpegICCMaxChunkPayload = 65533 - 14 // APP2 length(2) + "ICC_PROFILE\x00"(12) + seq(1) + total(1)
	maxICCProfileBytes     = 4 << 20    // 4 MiB safety cap for ICC metadata
	maxPreviewHeaderBytes  = 5 << 20    // 5 MiB bounded metadata prefix read (EXIF + ICC + APNG/WebP headers)
)

var (
	pngSignature = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	iccMarkerTag = []byte("ICC_PROFILE\x00")
)

// extractICCProfile returns raw uncompressed ICC bytes from JPEG APP2 or PNG iCCP.
func extractICCProfile(mimeType string, data []byte) []byte {
	lower := strings.ToLower(strings.TrimSpace(mimeType))
	switch {
	case lower == "image/jpeg" || lower == "image/jpg" || (len(data) >= 2 && data[0] == 0xFF && data[1] == 0xD8):
		return extractJPEGICC(data)
	case lower == "image/png" || bytes.HasPrefix(data, pngSignature):
		return extractPNGICC(data)
	default:
		return nil
	}
}

func extractJPEGICC(data []byte) []byte {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil
	}
	chunks := map[int][]byte{}
	totalChunks := 0
	pos := 2
	for pos+4 <= len(data) {
		if data[pos] != 0xFF {
			break
		}
		for pos < len(data) && data[pos] == 0xFF {
			pos++
		}
		if pos >= len(data) {
			break
		}
		marker := data[pos]
		pos++
		if marker == 0xD9 || marker == 0xDA { // EOI or SOS
			break
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			continue
		}
		if pos+2 > len(data) {
			break
		}
		segLen := int(binary.BigEndian.Uint16(data[pos : pos+2]))
		if segLen < 2 || pos+segLen > len(data) {
			break
		}
		payload := data[pos+2 : pos+segLen]
		pos += segLen
		if marker == 0xE2 && len(payload) > 14 && bytes.Equal(payload[:12], iccMarkerTag) {
			seq := int(payload[12])
			total := int(payload[13])
			if seq < 1 || total < 1 || seq > total || total > 64 {
				continue
			}
			totalChunks = total
			chunks[seq] = payload[14:]
		}
	}
	if totalChunks == 0 || len(chunks) != totalChunks {
		return nil
	}
	var out bytes.Buffer
	for seq := 1; seq <= totalChunks; seq++ {
		part, ok := chunks[seq]
		if !ok {
			return nil
		}
		if out.Len()+len(part) > maxICCProfileBytes {
			return nil
		}
		out.Write(part)
	}
	if out.Len() == 0 {
		return nil
	}
	return out.Bytes()
}

func injectJPEGICC(jpegData []byte, icc []byte) []byte {
	if len(icc) == 0 || len(icc) > maxICCProfileBytes || len(jpegData) < 4 || jpegData[0] != 0xFF || jpegData[1] != 0xD8 {
		return jpegData
	}
	total := (len(icc) + jpegICCMaxChunkPayload - 1) / jpegICCMaxChunkPayload
	if total > 255 {
		return jpegData
	}
	var out bytes.Buffer
	out.Grow(len(jpegData) + len(icc) + total*18)
	out.Write(jpegData[:2])
	for index := 0; index < total; index++ {
		start := index * jpegICCMaxChunkPayload
		end := min(start+jpegICCMaxChunkPayload, len(icc))
		chunk := icc[start:end]
		segLen := uint16(2 + len(iccMarkerTag) + 2 + len(chunk))
		out.Write([]byte{0xFF, 0xE2})
		_ = binary.Write(&out, binary.BigEndian, segLen)
		out.Write(iccMarkerTag)
		out.WriteByte(byte(index + 1))
		out.WriteByte(byte(total))
		out.Write(chunk)
	}
	out.Write(jpegData[2:])
	return out.Bytes()
}

func extractPNGICC(data []byte) []byte {
	if !bytes.HasPrefix(data, pngSignature) {
		return nil
	}
	pos := len(pngSignature)
	for pos+12 <= len(data) {
		chunkLen := int(binary.BigEndian.Uint32(data[pos : pos+4]))
		chunkType := string(data[pos+4 : pos+8])
		if chunkLen < 0 || pos+12+chunkLen > len(data) {
			break
		}
		chunkData := data[pos+8 : pos+8+chunkLen]
		pos += 12 + chunkLen
		if chunkType == "IDAT" {
			break
		}
		if chunkType != "iCCP" {
			continue
		}
		nul := bytes.IndexByte(chunkData, 0)
		if nul < 1 || nul+2 >= len(chunkData) || chunkData[nul+1] != 0 {
			return nil
		}
		zr, err := zlib.NewReader(bytes.NewReader(chunkData[nul+2:]))
		if err != nil {
			return nil
		}
		raw, readErr := io.ReadAll(io.LimitReader(zr, maxICCProfileBytes+1))
		_ = zr.Close()
		if readErr != nil || len(raw) == 0 || len(raw) > maxICCProfileBytes {
			return nil
		}
		return raw
	}
	return nil
}

func injectPNGICC(pngData []byte, icc []byte) []byte {
	if len(icc) == 0 || len(icc) > maxICCProfileBytes || !bytes.HasPrefix(pngData, pngSignature) {
		return pngData
	}
	if len(pngData) < len(pngSignature)+12 {
		return pngData
	}
	ihdrLen := int(binary.BigEndian.Uint32(pngData[8:12]))
	ihdrEnd := 8 + 12 + ihdrLen
	if ihdrLen < 0 || ihdrEnd > len(pngData) || string(pngData[12:16]) != "IHDR" {
		return pngData
	}
	var compressed bytes.Buffer
	zw := zlib.NewWriter(&compressed)
	if _, err := zw.Write(icc); err != nil {
		_ = zw.Close()
		return pngData
	}
	if err := zw.Close(); err != nil {
		return pngData
	}
	var chunkBody bytes.Buffer
	chunkBody.WriteString("ICC")
	chunkBody.WriteByte(0) // NUL separator
	chunkBody.WriteByte(0) // deflate compression method
	chunkBody.Write(compressed.Bytes())

	var out bytes.Buffer
	out.Grow(len(pngData) + chunkBody.Len() + 12)
	out.Write(pngData[:ihdrEnd])
	_ = binary.Write(&out, binary.BigEndian, uint32(chunkBody.Len()))
	out.WriteString("iCCP")
	out.Write(chunkBody.Bytes())
	crc := crc32.NewIEEE()
	_, _ = crc.Write([]byte("iCCP"))
	_, _ = crc.Write(chunkBody.Bytes())
	_ = binary.Write(&out, binary.BigEndian, crc.Sum32())
	out.Write(pngData[ihdrEnd:])
	return out.Bytes()
}

// extractJPEGEXIFOrientation reads TIFF tag 0x0112 (Orientation 1..8) from JPEG APP1.
func extractJPEGEXIFOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	pos := 2
	for pos+4 <= len(data) {
		if data[pos] != 0xFF {
			break
		}
		for pos < len(data) && data[pos] == 0xFF {
			pos++
		}
		if pos >= len(data) {
			break
		}
		marker := data[pos]
		pos++
		if marker == 0xD9 || marker == 0xDA {
			break
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			continue
		}
		if pos+2 > len(data) {
			break
		}
		segLen := int(binary.BigEndian.Uint16(data[pos : pos+2]))
		if segLen < 2 || pos+segLen > len(data) {
			break
		}
		payload := data[pos+2 : pos+segLen]
		pos += segLen
		if marker == 0xE1 && len(payload) >= 14 && bytes.Equal(payload[:6], []byte("Exif\x00\x00")) {
			if orient := parseTIFFOrientation(payload[6:]); orient >= 1 && orient <= 8 {
				return orient
			}
		}
	}
	return 1
}

func parseTIFFOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	if bo.Uint16(tiff[2:4]) != 42 {
		return 1
	}
	ifdOffset := int(bo.Uint32(tiff[4:8]))
	if ifdOffset < 8 || ifdOffset+2 > len(tiff) {
		return 1
	}
	entryCount := int(bo.Uint16(tiff[ifdOffset : ifdOffset+2]))
	for i := 0; i < entryCount; i++ {
		off := ifdOffset + 2 + i*12
		if off+12 > len(tiff) {
			break
		}
		tag := bo.Uint16(tiff[off : off+2])
		if tag != 0x0112 {
			continue
		}
		fieldType := bo.Uint16(tiff[off+2 : off+4])
		count := bo.Uint32(tiff[off+4 : off+8])
		if fieldType == 3 && count == 1 {
			val := int(bo.Uint16(tiff[off+8 : off+10]))
			if val >= 1 && val <= 8 {
				return val
			}
		}
	}
	return 1
}

// NormalizeEXIFOrientation applies JPEG EXIF orientation (tag 0x0112) when present
// so decoded pixel dimensions match browser-oriented image rendering.
func NormalizeEXIFOrientation(data []byte, img image.Image) image.Image {
	return applyOrientation(img, extractJPEGEXIFOrientation(data))
}

func applyOrientation(src image.Image, orientation int) image.Image {
	if src == nil || orientation <= 1 || orientation > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	var dst *image.NRGBA
	if orientation >= 5 {
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
	} else {
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := src.At(b.Min.X+x, b.Min.Y+y)
			switch orientation {
			case 2: // flip horizontal
				dst.Set(w-1-x, y, c)
			case 3: // rotate 180
				dst.Set(w-1-x, h-1-y, c)
			case 4: // flip vertical
				dst.Set(x, h-1-y, c)
			case 5: // transpose
				dst.Set(y, x, c)
			case 6: // rotate 90 CW
				dst.Set(h-1-y, x, c)
			case 7: // transverse
				dst.Set(h-1-y, w-1-x, c)
			case 8: // rotate 270 CW (90 CCW)
				dst.Set(y, w-1-x, c)
			}
		}
	}
	return dst
}

// isAnimatedImage detects GIF (>1 frame), APNG (acTL chunk), and animated WebP (VP8X/ANIM).
func isAnimatedImage(mimeType string, data []byte) bool {
	lower := strings.ToLower(strings.TrimSpace(mimeType))
	switch {
	case lower == "image/png" || bytes.HasPrefix(data, pngSignature):
		return isAPNG(data)
	case lower == "image/webp" || (len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP"):
		return isAnimatedWebP(data)
	case lower == "image/gif" || bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a")):
		return isAnimatedGIF(data)
	default:
		return false
	}
}

func isAPNG(data []byte) bool {
	if !bytes.HasPrefix(data, pngSignature) {
		return false
	}
	pos := len(pngSignature)
	for pos+12 <= len(data) {
		chunkLen := int(binary.BigEndian.Uint32(data[pos : pos+4]))
		chunkType := string(data[pos+4 : pos+8])
		if chunkType == "acTL" {
			return true
		}
		if chunkType == "IDAT" || chunkLen < 0 || pos+12+chunkLen > len(data) {
			return false
		}
		pos += 12 + chunkLen
	}
	return false
}

func isAnimatedWebP(data []byte) bool {
	if len(data) < 20 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return false
	}
	pos := 12
	for pos+8 <= len(data) {
		tag := string(data[pos : pos+4])
		size := int(binary.LittleEndian.Uint32(data[pos+4 : pos+8]))
		if tag == "ANIM" {
			return true
		}
		if tag == "VP8X" && pos+9 <= len(data) && (data[pos+8]&0x02) != 0 {
			return true
		}
		advance := 8 + size + (size & 1)
		if size < 0 || pos+advance > len(data) {
			break
		}
		pos += advance
	}
	return false
}

func isAnimatedGIF(data []byte) bool {
	if len(data) < 13 || (!bytes.HasPrefix(data, []byte("GIF87a")) && !bytes.HasPrefix(data, []byte("GIF89a"))) {
		return false
	}
	packed := data[10]
	pos := 13
	if packed&0x80 != 0 {
		gctSize := 3 * (1 << ((packed & 0x07) + 1))
		pos += gctSize
	}
	frames := 0
	for pos < len(data) {
		block := data[pos]
		pos++
		switch block {
		case 0x3B: // Trailer
			return frames > 1
		case 0x2C: // Image descriptor
			frames++
			if frames > 1 {
				return true
			}
			if pos+9 > len(data) {
				return false
			}
			imgPacked := data[pos+8]
			pos += 9
			if imgPacked&0x80 != 0 {
				pos += 3 * (1 << ((imgPacked & 0x07) + 1))
			}
			if pos >= len(data) {
				return false
			}
			pos++ // LZW minimum code size
			pos = skipGIFSubBlocks(data, pos)
		case 0x21: // Extension
			if pos >= len(data) {
				return false
			}
			pos++ // label
			pos = skipGIFSubBlocks(data, pos)
		default:
			return frames > 1
		}
	}
	return frames > 1
}

func skipGIFSubBlocks(data []byte, pos int) int {
	for pos < len(data) {
		size := int(data[pos])
		pos++
		if size == 0 {
			return pos
		}
		pos += size
	}
	return len(data)
}

func imageHasAlpha(img image.Image) bool {
	if img == nil {
		return false
	}
	if opaque, ok := img.(interface{ Opaque() bool }); ok {
		return !opaque.Opaque()
	}
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a < 0xFFFF {
				return true
			}
		}
	}
	return false
}

// readPreviewMetadataHeader reads only the leading metadata prefix needed for
// EXIF orientation, ICC profile, and APNG/WebP animation inspection without
// buffering multi-tens-of-megabytes pixel payloads into Go heap.
func readPreviewMetadataHeader(r io.Reader) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r, maxPreviewHeaderBytes))
}

// pngHeaderMayHaveAlpha inspects PNG IHDR color type and pre-IDAT tRNS chunk
// from header bytes without decoding pixels.
func pngHeaderMayHaveAlpha(data []byte) bool {
	if !bytes.HasPrefix(data, pngSignature) || len(data) < len(pngSignature)+25 {
		return false
	}
	// IHDR starts at byte 8: length(4) + "IHDR"(4) + width(4) + height(4) + bitDepth(1) + colorType(1)
	if string(data[12:16]) == "IHDR" {
		colorType := data[25]
		if colorType == 4 || colorType == 6 {
			return true
		}
	}
	pos := len(pngSignature)
	for pos+12 <= len(data) {
		chunkLen := int(binary.BigEndian.Uint32(data[pos : pos+4]))
		chunkType := string(data[pos+4 : pos+8])
		if chunkType == "tRNS" {
			return true
		}
		if chunkType == "IDAT" || chunkLen < 0 || pos+12+chunkLen > len(data) {
			return false
		}
		pos += 12 + chunkLen
	}
	return false
}
