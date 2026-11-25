package operations

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"encoding/hex"
	"io"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"
)

func extractPDFText(ctx context.Context, data []byte) (string, bool) {
	if bin, err := exec.LookPath("pdftotext"); err == nil && bin != "" {
		if ctx == nil {
			ctx = context.Background()
		}
		runCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(runCtx, bin, "-layout", "-nopgbrk", "-", "-")
		cmd.Stdin = bytes.NewReader(data)
		var out bytes.Buffer
		lb := &limitedBuffer{buf: &out, max: fileReadMaxExtractedBytes}
		cmd.Stdout = lb
		if err := cmd.Run(); err == nil && strings.TrimSpace(out.String()) != "" {
			return out.String(), lb.truncated
		}
	}
	return extractPDFTextPureGo(ctx, data, fileReadMaxUnzipBytes, fileReadMaxExtractedBytes)
}

type limitedBuffer struct {
	buf       *bytes.Buffer
	max       int
	truncated bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	remaining := l.max - l.buf.Len()
	if remaining <= 0 {
		l.truncated = true
		return len(p), nil
	}
	if len(p) > remaining {
		p = p[:remaining]
		l.truncated = true
	}
	_, err := l.buf.Write(p)
	return len(p), err
}

func extractPDFTextPureGo(ctx context.Context, data []byte, maxInflateBytes, maxTextBytes int64) (string, bool) {
	var out strings.Builder
	partCount := 0
	inflateRemaining := maxInflateBytes
	textRemaining := maxTextBytes
	truncated := false
	search := data
	for {
		if ctx != nil && ctx.Err() != nil {
			break
		}
		if textRemaining <= 0 {
			truncated = true
			break
		}
		idx := bytes.Index(search, []byte("stream"))
		if idx < 0 {
			break
		}
		rest := search[idx+6:]
		if bytes.HasPrefix(rest, []byte("\r\n")) {
			rest = rest[2:]
		} else if bytes.HasPrefix(rest, []byte("\n")) {
			rest = rest[1:]
		} else {
			search = rest
			continue
		}
		endIdx := bytes.Index(rest, []byte("endstream"))
		if endIdx < 0 {
			break
		}
		streamBytes := bytes.TrimRight(rest[:endIdx], "\r\n")
		search = rest[endIdx+9:]
		content := streamBytes
		if inflateRemaining > 0 {
			if inflated, err := inflatePDFStream(streamBytes, inflateRemaining); err == nil && len(inflated) > 0 {
				inflateRemaining -= int64(len(inflated))
				if inflateRemaining <= 0 {
					truncated = true
				}
				content = inflated
			}
		}
		if extracted := extractPDFContentStreamText(content); extracted != "" {
			if partCount > 0 {
				if textRemaining <= 1 {
					truncated = true
					break
				}
				out.WriteByte('\n')
				textRemaining--
			}
			if int64(len(extracted)) > textRemaining {
				cut := int(textRemaining)
				for cut > 0 && !utf8.RuneStart(extracted[cut]) {
					cut--
				}
				out.WriteString(extracted[:cut])
				textRemaining = 0
				truncated = true
				break
			}
			out.WriteString(extracted)
			textRemaining -= int64(len(extracted))
			partCount++
		}
	}
	return out.String(), truncated
}

func inflatePDFStream(raw []byte, limit int64) ([]byte, error) {
	if limit <= 0 {
		return nil, errFileReadExtractionLimit
	}
	zr, err := zlib.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(io.LimitReader(zr, limit))
}

func extractPDFContentStreamText(stream []byte) string {
	var lines []string
	var cur strings.Builder
	inBT := false
	i := 0
	for i < len(stream) {
		if !inBT {
			if i+2 <= len(stream) && stream[i] == 'B' && stream[i+1] == 'T' &&
				(i == 0 || isPDFDelim(stream[i-1])) &&
				(i+2 == len(stream) || isPDFDelim(stream[i+2])) {
				inBT = true
				cur.Reset()
				i += 2
				continue
			}
			i++
			continue
		}
		if i+2 <= len(stream) && stream[i] == 'E' && stream[i+1] == 'T' &&
			(i == 0 || isPDFDelim(stream[i-1])) &&
			(i+2 == len(stream) || isPDFDelim(stream[i+2])) {
			inBT = false
			if s := strings.TrimSpace(cur.String()); s != "" {
				lines = append(lines, s)
			}
			i += 2
			continue
		}
		if stream[i] == '(' {
			str, next := readPDFLiteralString(stream, i)
			cur.WriteString(str)
			i = next
			continue
		}
		if stream[i] == '<' && (i+1 >= len(stream) || stream[i+1] != '<') {
			str, next := readPDFHexString(stream, i)
			cur.WriteString(str)
			i = next
			continue
		}
		if i+2 <= len(stream) && (stream[i] == 'T' && (stream[i+1] == 'd' || stream[i+1] == 'D' || stream[i+1] == '*')) &&
			(i == 0 || isPDFDelim(stream[i-1])) &&
			(i+2 == len(stream) || isPDFDelim(stream[i+2])) {
			if cur.Len() > 0 && !strings.HasSuffix(cur.String(), "\n") {
				cur.WriteByte('\n')
			}
			i += 2
			continue
		}
		i++
	}
	return strings.Join(lines, "\n")
}

func isPDFDelim(b byte) bool {
	return b == ' ' || b == '\t' || b == '\r' || b == '\n' || b == '(' || b == ')' || b == '<' || b == '>' || b == '[' || b == ']' || b == '/'
}

func readPDFLiteralString(data []byte, start int) (string, int) {
	var raw []byte
	depth := 0
	i := start
	for i < len(data) {
		ch := data[i]
		if ch == '\\' && i+1 < len(data) {
			next := data[i+1]
			switch next {
			case 'n':
				raw = append(raw, '\n')
				i += 2
			case 'r':
				raw = append(raw, '\r')
				i += 2
			case 't':
				raw = append(raw, '\t')
				i += 2
			case '(', ')', '\\':
				raw = append(raw, next)
				i += 2
			default:
				if next >= '0' && next <= '7' {
					val := int(next - '0')
					consumed := 2
					for k := 0; k < 2 && i+consumed < len(data); k++ {
						d := data[i+consumed]
						if d < '0' || d > '7' {
							break
						}
						val = val*8 + int(d-'0')
						consumed++
					}
					raw = append(raw, byte(val))
					i += consumed
				} else {
					raw = append(raw, next)
					i += 2
				}
			}
			continue
		}
		if ch == '(' {
			if depth > 0 {
				raw = append(raw, ch)
			}
			depth++
			i++
			continue
		}
		if ch == ')' {
			depth--
			i++
			if depth == 0 {
				break
			}
			raw = append(raw, ch)
			continue
		}
		raw = append(raw, ch)
		i++
	}
	return decodePDFStringBytes(raw), i
}

func readPDFHexString(data []byte, start int) (string, int) {
	end := bytes.IndexByte(data[start+1:], '>')
	if end < 0 {
		return "", start + 1
	}
	hexClean := strings.Map(func(r rune) rune {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') {
			return r
		}
		return -1
	}, string(data[start+1:start+1+end]))
	if len(hexClean)%2 == 1 {
		hexClean += "0"
	}
	decoded, err := hex.DecodeString(hexClean)
	if err != nil {
		return "", start + end + 2
	}
	return decodePDFStringBytes(decoded), start + end + 2
}

func decodePDFStringBytes(raw []byte) string {
	if len(raw) >= 2 && raw[0] == 0xFE && raw[1] == 0xFF {
		return decodeUTF16(raw[2:], binary.BigEndian)
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	runes := make([]rune, len(raw))
	for i, b := range raw {
		runes[i] = rune(b)
	}
	return string(runes)
}
