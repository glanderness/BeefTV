package operations

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"

	"infinite-canvas/backend/internal/model"
)

type fileReadFakeDomain struct {
	Domain
	resources map[string]*model.Resource
	payloads  map[string][]byte
}

func (d *fileReadFakeDomain) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	res, ok := d.resources[resourceID]
	if !ok || res.UserID != userID {
		return nil, NotFound("resource_not_found", "文件不存在")
	}
	return res, nil
}

func (d *fileReadFakeDomain) OpenMediaResource(_ context.Context, userID, resourceID string) (io.ReadCloser, error) {
	res, ok := d.resources[resourceID]
	if !ok || res.UserID != userID {
		return nil, NotFound("resource_not_found", "文件不存在")
	}
	return io.NopCloser(bytes.NewReader(d.payloads[resourceID])), nil
}

func makeZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func TestOpFileReadPlainTextPaginationAndUTF8Safety(t *testing.T) {
	lines := []string{"第一行剧本：雨夜街头", "第二行：主角转身", "第三行：特写镜头", "第四行：片尾字幕"}
	body := []byte("\xef\xbb\xbf" + strings.Join(lines, "\r\n") + "\r\n")
	dom := &fileReadFakeDomain{
		resources: map[string]*model.Resource{
			"res-md": {ID: "res-md", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "text/markdown", ObjectKey: "u1/file/script.md", Size: int64(len(body))},
		},
		payloads: map[string][]byte{"res-md": body},
	}
	ctx := &Context{Context: context.Background(), UserID: "u1", Domain: dom}
	raw, _ := json.Marshal(map[string]any{"resourceId": "res-md", "offset": 2, "limit": 2})
	out, err := opFileRead(ctx, raw)
	if err != nil {
		t.Fatalf("opFileRead text: %v", err)
	}
	res := out.(fileReadResult)
	if !res.Readable || res.Format != "text" {
		t.Fatalf("unexpected format/readable: %+v", res)
	}
	if res.Content != "第二行：主角转身\n第三行：特写镜头" {
		t.Fatalf("unexpected page content: %q", res.Content)
	}
	if res.Pagination == nil || res.Pagination.StartLine != 2 || res.Pagination.EndLine != 3 || res.Pagination.TotalLines != 4 || !res.Pagination.Truncated {
		t.Fatalf("unexpected pagination: %+v", res.Pagination)
	}

	// Single oversized UTF-8 line truncates cleanly on rune boundary.
	hugeLine := strings.Repeat("汉", 20000) // 60,000 bytes > 50 KiB
	paged, pag := paginateDocumentText(hugeLine, 1, 10, 0, 2000, 100)
	if !pag.FirstLineExceedsLimit || !pag.Truncated || pag.FirstLineBytes != len(hugeLine) {
		t.Fatalf("expected first line exceeds limit: %+v", pag)
	}
	if len(paged) > 100 || !strings.HasPrefix(hugeLine, paged) || len(paged)%3 != 0 {
		t.Fatalf("expected valid UTF-8 prefix truncation, got len=%d", len(paged))
	}
}

func TestOpFileReadDOCXAndXLSXAndPPTX(t *testing.T) {
	docxBytes := makeZip(t, map[string]string{
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>` +
			`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
			`<w:p><w:r><w:t>第一集分镜大纲</w:t></w:r></w:p>` +
			`<w:tbl><w:tr><w:tc><w:p><w:r><w:t>镜号</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>画面</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
			`</w:body></w:document>`,
	})
	xlsxBytes := makeZip(t, map[string]string{
		"xl/workbook.xml":            `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="分镜表" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<sst><si><t>镜头1</t></si><si><t>雨夜奔跑</t></si></sst>`,
		"xl/worksheets/sheet1.xml":   `<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c><v>5</v></c></row></sheetData></worksheet>`,
	})
	pptxBytes := makeZip(t, map[string]string{
		"ppt/slides/slide1.xml": `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>项目提案标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
	})
	dom := &fileReadFakeDomain{
		resources: map[string]*model.Resource{
			"res-docx": {ID: "res-docx", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ObjectKey: "u1/file/a.docx", Size: int64(len(docxBytes))},
			"res-xlsx": {ID: "res-xlsx", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ObjectKey: "u1/file/b.xlsx", Size: int64(len(xlsxBytes))},
			"res-pptx": {ID: "res-pptx", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ObjectKey: "u1/file/c.pptx", Size: int64(len(pptxBytes))},
		},
		payloads: map[string][]byte{
			"res-docx": docxBytes,
			"res-xlsx": xlsxBytes,
			"res-pptx": pptxBytes,
		},
	}
	ctx := &Context{Context: context.Background(), UserID: "u1", Domain: dom}

	out, err := opFileRead(ctx, json.RawMessage(`{"resourceId":"res-docx"}`))
	if err != nil {
		t.Fatalf("docx: %v", err)
	}
	docxRes := out.(fileReadResult)
	if docxRes.Format != "docx" || !strings.Contains(docxRes.Content, "第一集分镜大纲") || !strings.Contains(docxRes.Content, "镜号\t画面") {
		t.Fatalf("unexpected docx result: %+v", docxRes)
	}

	out, err = opFileRead(ctx, json.RawMessage(`{"resourceId":"res-xlsx"}`))
	if err != nil {
		t.Fatalf("xlsx: %v", err)
	}
	xlsxRes := out.(fileReadResult)
	if xlsxRes.Format != "xlsx" || !strings.Contains(xlsxRes.Content, "=== 分镜表 ===") || !strings.Contains(xlsxRes.Content, "镜头1\t雨夜奔跑\t5") {
		t.Fatalf("unexpected xlsx result: %+v", xlsxRes)
	}

	out, err = opFileRead(ctx, json.RawMessage(`{"resourceId":"res-pptx"}`))
	if err != nil {
		t.Fatalf("pptx: %v", err)
	}
	pptxRes := out.(fileReadResult)
	if pptxRes.Format != "pptx" || !strings.Contains(pptxRes.Content, "=== Slide 1 ===") || !strings.Contains(pptxRes.Content, "项目提案标题") {
		t.Fatalf("unexpected pptx result: %+v", pptxRes)
	}
}

func TestOpFileReadPDFPureGoAndMediaRejectionAndBinaryFallback(t *testing.T) {
	var compressed bytes.Buffer
	zw := zlib.NewWriter(&compressed)
	_, _ = zw.Write([]byte("BT /F1 12 Tf (Scene 01: Night Rain) Tj T* (Hero enters frame) Tj ET"))
	_ = zw.Close()
	pdfBytes := append([]byte("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n"), compressed.Bytes()...)
	pdfBytes = append(pdfBytes, []byte("\nendstream\nendobj\n%%EOF")...)

	dom := &fileReadFakeDomain{
		resources: map[string]*model.Resource{
			"res-pdf": {ID: "res-pdf", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "application/pdf", ObjectKey: "u1/file/doc.pdf", Size: int64(len(pdfBytes))},
			"res-img": {ID: "res-img", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", ObjectKey: "u1/image/a.png", Size: 16},
			"res-bin": {ID: "res-bin", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "application/octet-stream", ObjectKey: "u1/file/raw.bin", Size: 8},
		},
		payloads: map[string][]byte{
			"res-pdf": pdfBytes,
			"res-img": []byte{0x89, 'P', 'N', 'G'},
			"res-bin": []byte{0x00, 0x01, 0x02, 0xFF, 0xFE, 0x00, 0x10, 0x20},
		},
	}
	ctx := &Context{Context: context.Background(), UserID: "u1", Domain: dom}

	out, err := opFileRead(ctx, json.RawMessage(`{"resourceId":"res-pdf"}`))
	if err != nil {
		t.Fatalf("pdf: %v", err)
	}
	pdfRes := out.(fileReadResult)
	if !pdfRes.Readable || pdfRes.Format != "pdf" || !strings.Contains(pdfRes.Content, "Scene 01: Night Rain") {
		t.Fatalf("unexpected pdf result: %+v", pdfRes)
	}

	if _, err := opFileRead(ctx, json.RawMessage(`{"resourceId":"res-img"}`)); err == nil {
		t.Fatal("expected image resource to direct model to media tools")
	}

	out, err = opFileRead(ctx, json.RawMessage(`{"resourceId":"res-bin"}`))
	if err != nil {
		t.Fatalf("binary: %v", err)
	}
	binRes := out.(fileReadResult)
	if binRes.Readable || binRes.Format != "binary" {
		t.Fatalf("expected non-readable binary metadata, got %+v", binRes)
	}
}

func TestOpFileReadByteOffsetContinuationForSingleLongLine(t *testing.T) {
	// Single 60 KiB UTF-8 line (Chinese 3-byte runes) must be readable completely via byteOffset continuation.
	longLine := strings.Repeat("镜", 21000) // 63,000 bytes (> 50 KiB)
	body := []byte(longLine)
	dom := &fileReadFakeDomain{
		resources: map[string]*model.Resource{
			"res-long": {ID: "res-long", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "application/json", ObjectKey: "u1/file/min.json", Size: int64(len(body))},
		},
		payloads: map[string][]byte{"res-long": body},
	}
	ctx := &Context{Context: context.Background(), UserID: "u1", Domain: dom}

	out1, err := opFileRead(ctx, json.RawMessage(`{"resourceId":"res-long"}`))
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	res1 := out1.(fileReadResult)
	if !res1.Pagination.Truncated || !res1.Pagination.FirstLineExceedsLimit || res1.Pagination.NextByteOffset <= 0 {
		t.Fatalf("expected nextByteOffset on page 1, got %+v", res1.Pagination)
	}

	rawArgs, _ := json.Marshal(map[string]any{
		"resourceId": "res-long",
		"offset":     res1.Pagination.StartLine,
		"byteOffset": res1.Pagination.NextByteOffset,
	})
	out2, err := opFileRead(ctx, rawArgs)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	res2 := out2.(fileReadResult)
	if res2.Pagination.Truncated || res2.Pagination.NextByteOffset != 0 {
		t.Fatalf("expected page 2 to finish line, got %+v", res2.Pagination)
	}
	if res1.Content+res2.Content != longLine {
		t.Fatalf("reassembled single line mismatch: got %d bytes, want %d bytes", len(res1.Content)+len(res2.Content), len(longLine))
	}
}

func TestFileReadXLSXSharedStringAmplificationAndPDFBudgetCaps(t *testing.T) {
	// XLSX shared-string amplification: a 1 MiB shared string referenced 4000 times in one row
	// would be 4 GiB if joined first; incremental per-cell budgeting must fail fast at 32 MiB.
	bigStr := strings.Repeat("A", 1<<20)
	var cells strings.Builder
	for i := 0; i < 4000; i++ {
		cells.WriteString(`<c t="s"><v>0</v></c>`)
	}
	xlsxBytes := makeZip(t, map[string]string{
		"xl/workbook.xml":            `<workbook><sheets><sheet name="Bomb" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<sst><si><t>` + bigStr + `</t></si></sst>`,
		"xl/worksheets/sheet1.xml":   `<worksheet><sheetData><row>` + cells.String() + `</row></sheetData></worksheet>`,
	})
	if _, _, ok, err := extractOOXMLText(context.Background(), xlsxBytes, ".xlsx"); ok || err == nil {
		t.Fatalf("expected shared-string amplification bomb to hit extraction limit, got ok=%v err=%v", ok, err)
	}

	// Pure-Go PDF extractor enforces aggregate text cap across multiple streams and respects cancelled ctx.
	var multiPDF bytes.Buffer
	multiPDF.WriteString("%PDF-1.4\n")
	for i := 0; i < 10; i++ {
		var compressed bytes.Buffer
		zw := zlib.NewWriter(&compressed)
		_, _ = zw.Write([]byte("BT (" + strings.Repeat("X", 200) + ") Tj ET"))
		_ = zw.Close()
		multiPDF.WriteString("stream\n")
		multiPDF.Write(compressed.Bytes())
		multiPDF.WriteString("\nendstream\n")
	}
	text, truncated := extractPDFTextPureGo(context.Background(), multiPDF.Bytes(), 4096, 500)
	if !truncated || len(text) > 500 {
		t.Fatalf("expected PDF aggregate budget cap at 500 bytes, got len=%d truncated=%v", len(text), truncated)
	}
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, _ := extractPDFTextPureGo(canceledCtx, multiPDF.Bytes(), 4096, 5000); got != "" {
		t.Fatalf("expected cancelled ctx to stop PDF extraction immediately, got %d bytes", len(got))
	}
}

func TestOpFileReadGB18030AndBinaryRejection(t *testing.T) {
	original := "镜号,画面描述,台词\r\n1,雨夜霓虹街口，主角撑伞走过,\"今晚风很大\"\r\n"
	gbkBytes, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(original))
	if err != nil {
		t.Fatalf("encode GB18030: %v", err)
	}
	binaryBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xfe, 0xff}
	cp1252Bytes := []byte("Caf\xe9 na\xefve \xa9 2026\n")
	dom := &fileReadFakeDomain{
		resources: map[string]*model.Resource{
			"res-gbk":    {ID: "res-gbk", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "text/csv", ObjectKey: "u1/file/shots.csv", Size: int64(len(gbkBytes))},
			"res-bin":    {ID: "res-bin", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "application/octet-stream", ObjectKey: "u1/file/raw.bin", Size: int64(len(binaryBytes))},
			"res-cp1252": {ID: "res-cp1252", UserID: "u1", Kind: "file", Status: model.ResourceStatusReady, MimeType: "text/plain", ObjectKey: "u1/file/latin.txt", Size: int64(len(cp1252Bytes))},
		},
		payloads: map[string][]byte{
			"res-gbk":    gbkBytes,
			"res-bin":    binaryBytes,
			"res-cp1252": cp1252Bytes,
		},
	}
	ctx := &Context{Context: context.Background(), UserID: "u1", Domain: dom}
	raw, _ := json.Marshal(map[string]any{"resourceId": "res-gbk"})
	out, err := opFileRead(ctx, raw)
	if err != nil {
		t.Fatalf("opFileRead GB18030: %v", err)
	}
	res := out.(fileReadResult)
	want := "镜号,画面描述,台词\n1,雨夜霓虹街口，主角撑伞走过,\"今晚风很大\""
	if !res.Readable || res.Format != "text" || res.Content != want {
		t.Fatalf("unexpected GB18030 read result: %+v", res)
	}

	rawBin, _ := json.Marshal(map[string]any{"resourceId": "res-bin"})
	outBin, err := opFileRead(ctx, rawBin)
	if err != nil {
		t.Fatalf("opFileRead binary: %v", err)
	}
	binRes := outBin.(fileReadResult)
	if binRes.Readable || binRes.Format != "binary" {
		t.Fatalf("expected binary file to be rejected as unreadable, got %+v", binRes)
	}

	rawCP, _ := json.Marshal(map[string]any{"resourceId": "res-cp1252"})
	outCP, err := opFileRead(ctx, rawCP)
	if err != nil {
		t.Fatalf("opFileRead cp1252: %v", err)
	}
	cpRes := outCP.(fileReadResult)
	if cpRes.Readable || cpRes.Format != "binary" {
		t.Fatalf("expected non-GB18030 legacy bytes to stay binary, got %+v", cpRes)
	}
}
