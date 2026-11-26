package operations

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

const (
	fileReadMaxSourceBytes    = 32 << 20 // 32 MiB bounded read for document extraction
	fileReadMaxUnzipBytes     = 32 << 20 // 32 MiB zip-bomb guard for OOXML / PDF streams
	fileReadMaxExtractedBytes = 32 << 20 // 32 MiB aggregate extracted text budget
	fileReadDefaultMaxLines   = 2000
	fileReadDefaultMaxBytes   = 50 * 1024
)

type fileReadArgs struct {
	ResourceID string `json:"resourceId"`
	Name       string `json:"name,omitempty"`
	Offset     int    `json:"offset,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	ByteOffset int    `json:"byteOffset,omitempty"`
}

type fileReadPagination struct {
	StartLine             int  `json:"startLine"`
	EndLine               int  `json:"endLine"`
	TotalLines            int  `json:"totalLines"`
	Truncated             bool `json:"truncated"`
	FirstLineExceedsLimit bool `json:"firstLineExceedsLimit,omitempty"`
	FirstLineBytes        int  `json:"firstLineBytes,omitempty"`
	ByteOffset            int  `json:"byteOffset,omitempty"`
	NextByteOffset        int  `json:"nextByteOffset,omitempty"`
}

type fileReadImage struct {
	Page     int    `json:"page"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
}

type fileReadResult struct {
	ResourceID string              `json:"resourceId"`
	Format     string              `json:"format"`
	MimeType   string              `json:"mimeType"`
	Bytes      int64               `json:"bytes"`
	Readable   bool                `json:"readable"`
	Content    string              `json:"content"`
	Pagination *fileReadPagination `json:"pagination,omitempty"`
	Images     []fileReadImage     `json:"images,omitempty"`
	Note       string              `json:"note,omitempty"`
}

func registerFileReadOp(r *Registry) {
	r.Register(Op{
		AssistantCanvas: true,
		ID:              "file.read",
		Summary:         "分页读取用户上传的文档或文本内容（支持纯文本/Markdown/CSV/JSON/SRT/代码/DOCX/XLSX/PPTX/PDF）",
		ReadOnly:        true,
		Scope:           ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{` +
			`"resourceId":{"type":"string","description":"已上传文件的资源 ID"},` +
			`"name":{"type":"string","description":"可选原始文件名，用于识别格式"},` +
			`"offset":{"type":"integer","minimum":1,"description":"起始行号（从 1 开始）"},` +
			`"limit":{"type":"integer","minimum":1,"maximum":2000,"description":"读取行数（单次最多 2000 行、50KB）"},` +
			`"byteOffset":{"type":"integer","minimum":0,"description":"超长单行续读字节偏移"}` +
			`},"required":["resourceId"]}`),
		Handler: opFileRead,
	})
}

func opFileRead(ctx *Context, raw json.RawMessage) (any, error) {
	var args fileReadArgs
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	resourceID := strings.TrimSpace(args.ResourceID)
	if resourceID == "" {
		return nil, InvalidArg("invalid_params", "resourceId 必填")
	}
	if args.Offset < 0 || args.Limit < 0 || args.ByteOffset < 0 {
		return nil, InvalidArg("invalid_file_read_range", "文件读取分页参数无效")
	}
	resource, err := ctx.Domain.OwnedReadyResource(ctx.UserID, resourceID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if resource == nil {
		return nil, NotFound("resource_not_found", "文件不存在或尚未保存完成")
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(resource.MimeType, ";")[0]))
	if strings.HasPrefix(mimeType, "image/") || strings.HasPrefix(mimeType, "video/") || strings.HasPrefix(mimeType, "audio/") {
		return nil, InvalidArg("media_use_media_tools", "这是图片或音视频素材，请使用 media_overview 或 media_inspect 检查画面与声音")
	}
	opener, ok := ctx.Domain.(MediaSourceOpener)
	if !ok {
		return nil, Unsupported("file_read_unavailable", "当前工作区无法读取本地文件内容")
	}
	reader, err := opener.OpenMediaResource(ctx.Context, ctx.UserID, resource.ID)
	if err != nil {
		return nil, AsError(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, fileReadMaxSourceBytes+1))
	if err != nil {
		return nil, PreconditionFailed("file_read_failed", "文件内容读取失败", nil)
	}
	if len(data) > fileReadMaxSourceBytes {
		return fileReadResult{
			ResourceID: resource.ID,
			Format:     "oversized",
			MimeType:   resource.MimeType,
			Bytes:      resource.Size,
			Readable:   false,
			Note:       fmt.Sprintf("文件大小超过单次文本解析上限（%d MB），请先拆分文件或借助技能脚本处理。", fileReadMaxSourceBytes>>20),
		}, nil
	}

	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(args.Name)))
	if ext == "" {
		ext = strings.ToLower(filepath.Ext(strings.TrimSpace(resource.ObjectKey)))
	}
	extracted, format, readable, note := extractDocumentText(ctx.Context, data, ext, mimeType)
	if !readable {
		if format == "pdf" {
			if imgs, morePages := extractScannedPDFImages(ctx.Context, data, pdfScannedMaxPages, pdfScannedMaxTotalBytes); len(imgs) > 0 {
				imgNote := fmt.Sprintf("该 PDF 为扫描件或纯图片，已提取前 %d 页画面供直接审看。", len(imgs))
				if morePages {
					imgNote += " 后续页面已省略。"
				}
				return fileReadResult{
					ResourceID: resource.ID,
					Format:     "pdf-images",
					MimeType:   resource.MimeType,
					Bytes:      resource.Size,
					Readable:   true,
					Images:     imgs,
					Note:       imgNote,
				}, nil
			}
		}
		return fileReadResult{
			ResourceID: resource.ID,
			Format:     format,
			MimeType:   resource.MimeType,
			Bytes:      resource.Size,
			Readable:   false,
			Note:       note,
		}, nil
	}
	paged, pagination := paginateDocumentText(extracted, args.Offset, args.Limit, args.ByteOffset, fileReadDefaultMaxLines, fileReadDefaultMaxBytes)
	return fileReadResult{
		ResourceID: resource.ID,
		Format:     format,
		MimeType:   resource.MimeType,
		Bytes:      resource.Size,
		Readable:   true,
		Content:    paged,
		Pagination: &pagination,
		Note:       note,
	}, nil
}

func extractDocumentText(ctx context.Context, data []byte, ext, mimeType string) (text, format string, readable bool, note string) {
	if len(data) == 0 {
		return "", "text", true, "文件为空"
	}
	isZip := len(data) >= 4 && data[0] == 'P' && data[1] == 'K' && data[2] == 0x03 && data[3] == 0x04
	if isZip || ext == ".docx" || ext == ".xlsx" || ext == ".pptx" ||
		strings.Contains(mimeType, "wordprocessingml") ||
		strings.Contains(mimeType, "spreadsheetml") ||
		strings.Contains(mimeType, "presentationml") {
		if officeText, officeFmt, ok, err := extractOOXMLText(ctx, data, ext); ok && err == nil {
			return normalizeLineEndings(officeText), officeFmt, true, ""
		} else if err != nil && strings.Contains(err.Error(), "extraction limit") {
			return "", strings.TrimPrefix(ext, "."), false, "文档展开后文本超过单次解析上限，请拆分后重新上传。"
		} else if ext == ".docx" || ext == ".xlsx" || ext == ".pptx" {
			return "", strings.TrimPrefix(ext, "."), false, "文档结构损坏或已加密，无法解析正文"
		}
	}
	if ext == ".pdf" || mimeType == "application/pdf" || bytes.HasPrefix(data, []byte("%PDF-")) {
		pdfText, truncatedByBudget := extractPDFText(ctx, data)
		if strings.TrimSpace(pdfText) == "" {
			return "", "pdf", false, "该 PDF 未提取到可选中文本，可能是扫描件、纯图片或加密 PDF；如需查看画面内容，可转为图片后发送。"
		}
		note := ""
		if truncatedByBudget {
			note = "PDF 文本较长，已按解析上限截断后续内容。"
		}
		return normalizeLineEndings(pdfText), "pdf", true, note
	}
	if decoded, ok := decodePlainText(data); ok {
		return normalizeLineEndings(decoded), "text", true, ""
	}
	return "", "binary", false, "该文件为二进制格式，无法直接按文本读取。"
}

func decodePlainText(data []byte) (string, bool) {
	if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE {
		return decodeUTF16(data[2:], binary.LittleEndian), true
	}
	if len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF {
		return decodeUTF16(data[2:], binary.BigEndian), true
	}
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	if bytes.IndexByte(data, 0) >= 0 {
		return "", false
	}
	if utf8.Valid(data) {
		return string(data), true
	}
	return decodeGB18030Text(data)
}

func decodeGB18030Text(data []byte) (string, bool) {
	if len(data) == 0 {
		return "", true
	}
	for _, b := range data {
		if (b < 0x20 && b != '\t' && b != '\n' && b != '\r' && b != '\f' && b != '\v') || b == 0x7f {
			return "", false
		}
	}
	decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes(data)
	if err != nil || !utf8.Valid(decoded) {
		return "", false
	}
	reencoded, err := simplifiedchinese.GB18030.NewEncoder().Bytes(decoded)
	if err != nil || !bytes.Equal(reencoded, data) {
		return "", false
	}
	text := string(decoded)
	totalRunes := 0
	hanRunes := 0
	suspectRunes := 0
	for _, r := range text {
		totalRunes++
		if r == unicode.ReplacementChar {
			return "", false
		}
		if r < 0x20 && r != '\t' && r != '\n' && r != '\r' && r != '\f' && r != '\v' {
			return "", false
		}
		if unicode.In(r, unicode.Co) || (unicode.IsControl(r) && !unicode.IsSpace(r)) {
			suspectRunes++
		} else if unicode.Is(unicode.Han, r) {
			hanRunes++
		}
	}
	if totalRunes == 0 || hanRunes == 0 || suspectRunes*20 > totalRunes {
		return "", false
	}
	return text, true
}

func decodeUTF16(data []byte, order binary.ByteOrder) string {
	n := len(data) / 2
	units := make([]uint16, n)
	for i := 0; i < n; i++ {
		units[i] = order.Uint16(data[i*2:])
	}
	return string(utf16.Decode(units))
}

func normalizeLineEndings(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return text
}

func paginateDocumentText(source string, offset, limit, byteOffset, maxLines, maxBytes int) (string, fileReadPagination) {
	lines := splitDocumentLines(source)
	totalLines := len(lines)
	startIndex := 0
	if offset > 1 {
		startIndex = offset - 1
	}
	startLine := startIndex + 1
	if totalLines == 0 || startIndex >= totalLines {
		return "", fileReadPagination{
			StartLine:  startLine,
			EndLine:    totalLines,
			TotalLines: totalLines,
			Truncated:  false,
		}
	}
	requestedLines := maxLines
	if limit > 0 && limit < requestedLines {
		requestedLines = limit
	}
	picked := make([]string, 0, min(requestedLines, totalLines-startIndex))
	usedBytes := 0
	firstLineExceedsLimit := false
	firstLineBytes := 0
	effectiveByteOffset := 0
	nextByteOffset := 0

	for i := startIndex; i < totalLines && len(picked) < requestedLines; i++ {
		line := lines[i]
		originalLen := len(line)
		sliceStart := 0
		if i == startIndex && byteOffset > 0 {
			sliceStart = min(byteOffset, originalLen)
			for sliceStart < originalLen && !utf8.RuneStart(line[sliceStart]) {
				sliceStart++
			}
			effectiveByteOffset = sliceStart
			line = line[sliceStart:]
		}
		lineBytes := len(line)
		sep := 0
		if len(picked) > 0 {
			sep = 1
		}
		if usedBytes+sep+lineBytes > maxBytes {
			if len(picked) == 0 {
				cut := min(maxBytes, lineBytes)
				for cut > 0 && !utf8.RuneStart(line[cut]) {
					cut--
				}
				picked = append(picked, line[:cut])
				usedBytes = cut
				firstLineExceedsLimit = true
				firstLineBytes = originalLen
				if sliceStart+cut < originalLen {
					nextByteOffset = sliceStart + cut
				}
			}
			break
		}
		picked = append(picked, line)
		usedBytes += sep + lineBytes
	}
	endLine := startIndex + len(picked)
	truncated := nextByteOffset > 0 || endLine < totalLines
	return strings.Join(picked, "\n"), fileReadPagination{
		StartLine:             startLine,
		EndLine:               endLine,
		TotalLines:            totalLines,
		Truncated:             truncated,
		FirstLineExceedsLimit: firstLineExceedsLimit,
		FirstLineBytes:        firstLineBytes,
		ByteOffset:            effectiveByteOffset,
		NextByteOffset:        nextByteOffset,
	}
}

func splitDocumentLines(source string) []string {
	if source == "" {
		return nil
	}
	lines := strings.Split(source, "\n")
	if strings.HasSuffix(source, "\n") {
		lines = lines[:len(lines)-1]
	}
	return lines
}
