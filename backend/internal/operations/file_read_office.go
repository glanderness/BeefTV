package operations

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var errFileReadExtractionLimit = errors.New("document exceeds text extraction limit")

func extractOOXMLText(ctx context.Context, data []byte, ext string) (string, string, bool, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", "", false, err
	}
	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		files[f.Name] = f
	}
	readEntry := func(name string, budget *int64) ([]byte, error) {
		if ctx != nil && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		f, ok := files[name]
		if !ok {
			return nil, nil
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		out, err := io.ReadAll(io.LimitReader(rc, *budget+1))
		if err != nil {
			return nil, err
		}
		if int64(len(out)) > *budget {
			return nil, errFileReadExtractionLimit
		}
		*budget -= int64(len(out))
		return out, nil
	}
	unzipBudget := int64(fileReadMaxUnzipBytes)
	textBudget := int64(fileReadMaxExtractedBytes)

	if _, ok := files["word/document.xml"]; ok || ext == ".docx" {
		raw, err := readEntry("word/document.xml", &unzipBudget)
		if err != nil || len(raw) == 0 {
			return "", "docx", false, err
		}
		text, err := parseDOCXDocumentXML(raw, &textBudget)
		if err != nil {
			return "", "docx", false, err
		}
		return text, "docx", true, nil
	}
	if _, ok := files["xl/workbook.xml"]; ok || ext == ".xlsx" {
		text, err := parseXLSXArchive(ctx, files, readEntry, &unzipBudget, &textBudget)
		if err != nil {
			return "", "xlsx", false, err
		}
		return text, "xlsx", true, nil
	}
	if hasPPTXSlides(files) || ext == ".pptx" {
		text, err := parsePPTXArchive(ctx, files, readEntry, &unzipBudget, &textBudget)
		if err != nil {
			return "", "pptx", false, err
		}
		return text, "pptx", true, nil
	}
	return "", "", false, nil
}

func appendBudgeted(dst *strings.Builder, s string, budget *int64) error {
	if int64(len(s)) > *budget {
		return errFileReadExtractionLimit
	}
	*budget -= int64(len(s))
	dst.WriteString(s)
	return nil
}

func parseDOCXDocumentXML(raw []byte, textBudget *int64) (string, error) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var out strings.Builder
	var para strings.Builder
	var rowCells []string
	lineCount := 0
	inTableRow := false
	inTableCell := false
	inPara := false
	inText := false

	emitLine := func(line string) error {
		if lineCount > 0 {
			if err := appendBudgeted(&out, "\n", textBudget); err != nil {
				return err
			}
		}
		lineCount++
		return appendBudgeted(&out, line, textBudget)
	}

	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "tr":
				inTableRow = true
				rowCells = rowCells[:0]
			case "tc":
				inTableCell = true
			case "p":
				inPara = true
				para.Reset()
			case "t":
				inText = true
			case "tab":
				if inPara {
					para.WriteByte('\t')
				}
			case "br", "cr":
				if inPara {
					para.WriteByte('\n')
				}
			}
		case xml.CharData:
			if inPara && inText {
				para.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p":
				inPara = false
				if inTableCell {
					if len(rowCells) == 0 {
						rowCells = append(rowCells, para.String())
					} else {
						last := len(rowCells) - 1
						if rowCells[last] != "" && para.Len() > 0 {
							rowCells[last] += " " + para.String()
						} else if para.Len() > 0 {
							rowCells[last] = para.String()
						}
					}
				} else {
					if err := emitLine(para.String()); err != nil {
						return "", err
					}
				}
			case "tc":
				inTableCell = false
				if inTableRow {
					rowCells = append(rowCells, "")
				}
			case "tr":
				inTableRow = false
				if len(rowCells) > 0 && rowCells[len(rowCells)-1] == "" {
					rowCells = rowCells[:len(rowCells)-1]
				}
				if len(rowCells) > 0 {
					if err := emitLine(strings.Join(rowCells, "\t")); err != nil {
						return "", err
					}
				}
			}
		}
	}
	return out.String(), nil
}

func parseXLSXArchive(ctx context.Context, files map[string]*zip.File, readEntry func(string, *int64) ([]byte, error), unzipBudget, textBudget *int64) (string, error) {
	sharedStrings := []string{}
	ssRaw, err := readEntry("xl/sharedStrings.xml", unzipBudget)
	if err != nil {
		return "", err
	}
	if len(ssRaw) > 0 {
		sharedStrings = parseXLSXSharedStrings(ssRaw)
	}
	sheetTargets, err := resolveXLSXSheets(files, readEntry, unzipBudget)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	for i, sheet := range sheetTargets {
		if ctx != nil && ctx.Err() != nil {
			return "", ctx.Err()
		}
		raw, err := readEntry(sheet.path, unzipBudget)
		if err != nil {
			return "", err
		}
		if len(raw) == 0 {
			continue
		}
		if i > 0 {
			if err := appendBudgeted(&out, "\n\n", textBudget); err != nil {
				return "", err
			}
		}
		if err := appendBudgeted(&out, "=== "+sheet.name+" ===\n", textBudget); err != nil {
			return "", err
		}
		if err := parseXLSXWorksheetXML(ctx, raw, sharedStrings, &out, textBudget); err != nil {
			return "", err
		}
	}
	return out.String(), nil
}

type xlsxSheetTarget struct {
	name string
	path string
}

func resolveXLSXSheets(files map[string]*zip.File, readEntry func(string, *int64) ([]byte, error), budget *int64) ([]xlsxSheetTarget, error) {
	rels := map[string]string{}
	relRaw, err := readEntry("xl/_rels/workbook.xml.rels", budget)
	if err != nil {
		return nil, err
	}
	if len(relRaw) > 0 {
		dec := xml.NewDecoder(bytes.NewReader(relRaw))
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "Relationship" {
				var id, target string
				for _, attr := range se.Attr {
					switch attr.Name.Local {
					case "Id":
						id = attr.Value
					case "Target":
						target = strings.TrimPrefix(attr.Value, "/")
					}
				}
				if id != "" && target != "" {
					if !strings.HasPrefix(target, "xl/") {
						target = "xl/" + target
					}
					rels[id] = target
				}
			}
		}
	}
	var targets []xlsxSheetTarget
	wbRaw, err := readEntry("xl/workbook.xml", budget)
	if err != nil {
		return nil, err
	}
	if len(wbRaw) > 0 {
		dec := xml.NewDecoder(bytes.NewReader(wbRaw))
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "sheet" {
				var name, relID string
				for _, attr := range se.Attr {
					switch attr.Name.Local {
					case "name":
						name = attr.Value
					case "id":
						relID = attr.Value
					}
				}
				if p, ok := rels[relID]; ok {
					targets = append(targets, xlsxSheetTarget{name: name, path: p})
				}
			}
		}
	}
	if len(targets) > 0 {
		return targets, nil
	}
	var paths []string
	for name := range files {
		if strings.HasPrefix(name, "xl/worksheets/sheet") && strings.HasSuffix(name, ".xml") {
			paths = append(paths, name)
		}
	}
	sort.Slice(paths, func(i, j int) bool { return numericSuffix(paths[i]) < numericSuffix(paths[j]) })
	for idx, p := range paths {
		targets = append(targets, xlsxSheetTarget{name: fmt.Sprintf("Sheet%d", idx+1), path: p})
	}
	return targets, nil
}

func parseXLSXSharedStrings(raw []byte) []string {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var list []string
	var cur strings.Builder
	inSI := false
	inT := false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSI = true
				cur.Reset()
			case "t":
				if inSI {
					inT = true
				}
			}
		case xml.CharData:
			if inSI && inT {
				cur.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inT = false
			case "si":
				inSI = false
				list = append(list, cur.String())
			}
		}
	}
	return list
}

func parseXLSXWorksheetXML(ctx context.Context, raw []byte, sharedStrings []string, out *strings.Builder, textBudget *int64) error {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var cellType string
	var valBuf strings.Builder
	rowCount := 0
	cellCount := 0
	inRow := false
	inCell := false
	inVal := false
	inInlineText := false

	for {
		if ctx != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				inRow = true
				cellCount = 0
			case "c":
				if inRow {
					inCell = true
					cellType = ""
					valBuf.Reset()
					for _, attr := range t.Attr {
						if attr.Name.Local == "t" {
							cellType = attr.Value
						}
					}
				}
			case "v":
				if inCell {
					inVal = true
				}
			case "t":
				if inCell {
					inInlineText = true
				}
			}
		case xml.CharData:
			if inCell && (inVal || inInlineText) {
				valBuf.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inVal = false
			case "t":
				inInlineText = false
			case "c":
				if inCell {
					inCell = false
					text := valBuf.String()
					if cellType == "s" {
						if idx, err := strconv.Atoi(strings.TrimSpace(text)); err == nil && idx >= 0 && idx < len(sharedStrings) {
							text = sharedStrings[idx]
						}
					}
					text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", " "), "\n", " ")
					// Write incrementally under textBudget on every cell so a single crafted row
					// referencing a large shared string can never allocate gigabytes before failing.
					if cellCount == 0 {
						if rowCount > 0 {
							if err := appendBudgeted(out, "\n", textBudget); err != nil {
								return err
							}
						}
						rowCount++
					} else {
						if err := appendBudgeted(out, "\t", textBudget); err != nil {
							return err
						}
					}
					cellCount++
					if err := appendBudgeted(out, text, textBudget); err != nil {
						return err
					}
				}
			case "row":
				inRow = false
			}
		}
	}
	return nil
}

func hasPPTXSlides(files map[string]*zip.File) bool {
	for name := range files {
		if strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml") {
			return true
		}
	}
	return false
}

func parsePPTXArchive(ctx context.Context, files map[string]*zip.File, readEntry func(string, *int64) ([]byte, error), unzipBudget, textBudget *int64) (string, error) {
	var slides []string
	for name := range files {
		if strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml") {
			slides = append(slides, name)
		}
	}
	sort.Slice(slides, func(i, j int) bool { return numericSuffix(slides[i]) < numericSuffix(slides[j]) })
	var out strings.Builder
	for i, name := range slides {
		if ctx != nil && ctx.Err() != nil {
			return "", ctx.Err()
		}
		raw, err := readEntry(name, unzipBudget)
		if err != nil {
			return "", err
		}
		if i > 0 {
			if err := appendBudgeted(&out, "\n\n", textBudget); err != nil {
				return "", err
			}
		}
		if err := appendBudgeted(&out, fmt.Sprintf("=== Slide %d ===\n", i+1), textBudget); err != nil {
			return "", err
		}
		if err := appendBudgeted(&out, parsePPTXSlideXML(raw), textBudget); err != nil {
			return "", err
		}
	}
	return out.String(), nil
}

func parsePPTXSlideXML(raw []byte) string {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var lines []string
	var para strings.Builder
	inPara := false
	inText := false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				inPara = true
				para.Reset()
			case "t":
				if inPara {
					inText = true
				}
			case "br":
				if inPara {
					para.WriteByte('\n')
				}
			}
		case xml.CharData:
			if inPara && inText {
				para.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p":
				inPara = false
				if strings.TrimSpace(para.String()) != "" {
					lines = append(lines, para.String())
				}
			}
		}
	}
	return strings.Join(lines, "\n")
}

var numericSuffixPattern = regexp.MustCompile(`(\d+)\.xml$`)

func numericSuffix(path string) int {
	match := numericSuffixPattern.FindStringSubmatch(path)
	if len(match) < 2 {
		return 0
	}
	n, _ := strconv.Atoi(match[1])
	return n
}
