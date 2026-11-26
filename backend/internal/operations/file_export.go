package operations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/skills"

	"gorm.io/gorm"
)

const (
	fileExportMaxBytes         = 4 << 20  // 4 MiB UTF-8 text deliverable cap
	scriptOutputMaxPersistFile = 16 << 20 // 16 MiB per persisted script output file
	scriptOutputMaxPersistNum  = 16       // max persisted output files per script run
)

type DeliverableFileSaver interface {
	SaveAssistantDeliverableFile(ctx context.Context, userID, uploadKey, fileName, mimeType string, content []byte) (*model.Resource, error)
}

type ExportedFileOutput struct {
	ResourceID string
	FileName   string
	MimeType   string
	Bytes      int64
}

var deliverableMimeByExt = map[string]string{
	".md":   "text/markdown; charset=utf-8",
	".srt":  "application/x-subrip; charset=utf-8",
	".vtt":  "text/vtt; charset=utf-8",
	".ass":  "text/plain; charset=utf-8",
	".csv":  "text/csv; charset=utf-8",
	".tsv":  "text/tab-separated-values; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt":  "text/plain; charset=utf-8",
	".yaml": "application/yaml; charset=utf-8",
	".yml":  "application/yaml; charset=utf-8",
	".xml":  "application/xml; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".svg":  "image/svg+xml",
	".js":   "text/javascript; charset=utf-8",
	".ts":   "text/plain; charset=utf-8",
	".py":   "text/x-python; charset=utf-8",
	".sh":   "text/x-shellscript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
}

func sanitizeDeliverableFileName(raw string) (string, string) {
	base := filepath.Base(strings.TrimSpace(raw))
	if base == "" || base == "." || base == "/" {
		base = "deliverable.md"
	}
	clean := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 32 || r == 127 {
			return '_'
		}
		return r
	}, base)
	clean = strings.Trim(clean, ". ")
	if clean == "" {
		clean = "deliverable.md"
	}
	ext := strings.ToLower(filepath.Ext(clean))
	if ext == "" {
		ext = ".txt"
		clean += ext
	}
	if len(clean) > 160 {
		stem := strings.TrimSuffix(clean, ext)
		runes := []rune(stem)
		if len(runes) > 120 {
			stem = string(runes[:120])
		}
		clean = stem + ext
	}
	return clean, ext
}

func deliverableMimeType(ext, requested string) string {
	if mapped, ok := deliverableMimeByExt[strings.ToLower(ext)]; ok {
		return mapped
	}
	trimmed := strings.TrimSpace(strings.Split(requested, ";")[0])
	if trimmed != "" && strings.Contains(trimmed, "/") && len(trimmed) <= 96 {
		return trimmed
	}
	if guessed := mime.TypeByExtension(ext); guessed != "" {
		return guessed
	}
	return "application/octet-stream"
}

func registerFileExportOp(r *Registry) {
	r.Register(Op{
		AssistantCanvas: true,
		ReplaySafe:      true,
		ID:              "file.export",
		Summary:         "把助手生成的剧本、字幕、分镜表或结构化文本保存为可下载交付文件卡片（.md/.srt/.csv/.json/.txt/.html 等）",
		Scope:           ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{` +
			`"canvasId":{"type":"string"},` +
			`"fileName":{"type":"string","description":"导出文件名（含扩展名，如 分镜脚本.md、对白字幕.srt、分镜表.csv）"},` +
			`"content":{"type":"string","description":"文件文本内容（UTF-8，不超过 4MB）"},` +
			`"mimeType":{"type":"string","description":"可选 MIME 类型，留空时按扩展名推断"}` +
			`},"required":["canvasId","fileName","content"]}`),
		Handler: opFileExport,
	})
}

func opFileExport(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID string `json:"canvasId"`
		FileName string `json:"fileName"`
		Content  string `json:"content"`
		MimeType string `json:"mimeType,omitempty"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.FileName) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 和 fileName 必填")
	}
	if strings.TrimSpace(ctx.OperationID) == "" {
		return nil, InvalidArg("invalid_params", "导出交付文件需要稳定操作标识")
	}
	if len(args.Content) > fileExportMaxBytes {
		return nil, InvalidArg("file_too_large", fmt.Sprintf("导出文件内容不能超过 %dMB", fileExportMaxBytes>>20))
	}
	if _, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID); err != nil {
		return nil, mapDomainError(err)
	}
	saver, ok := ctx.Domain.(DeliverableFileSaver)
	if !ok {
		return nil, Unsupported("file_export_unavailable", "当前工作区无法保存交付文件")
	}
	fileName, ext := sanitizeDeliverableFileName(args.FileName)
	mimeType := deliverableMimeType(ext, args.MimeType)
	uploadKey := "file-export:" + strings.TrimSpace(ctx.OperationID)
	resource, err := saver.SaveAssistantDeliverableFile(ctx.Context, ctx.UserID, uploadKey, fileName, mimeType, []byte(args.Content))
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"canvasId":   args.CanvasID,
		"resourceId": resource.ID,
		"storageKey": "resource:" + resource.ID,
		"fileName":   fileName,
		"mimeType":   resource.MimeType,
		"bytes":      resource.Size,
		"local":      true,
		"charged":    false,
	}, nil
}

// ListTurnExportedFiles reads verified file.export receipts belonging to a turn
// and confirms each referenced Resource is still owned and ready.
func ListTurnExportedFiles(db *gorm.DB, userID, canvasID, turnID string) ([]ExportedFileOutput, error) {
	if db == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(turnID) == "" {
		return nil, nil
	}
	var receipts []model.AgentOpRecord
	if err := db.Where("user_id = ? AND turn_id = ? AND op = ? AND status = ?", userID, turnID, "file.export", "succeeded").
		Order("created_at ASC").Find(&receipts).Error; err != nil {
		return nil, err
	}
	if len(receipts) == 0 {
		return nil, nil
	}
	repo := repository.New(db)
	outputs := make([]ExportedFileOutput, 0, len(receipts))
	seen := make(map[string]bool, len(receipts))
	for _, receipt := range receipts {
		var result struct {
			CanvasID   string `json:"canvasId"`
			ResourceID string `json:"resourceId"`
			FileName   string `json:"fileName"`
			MimeType   string `json:"mimeType"`
			Bytes      int64  `json:"bytes"`
		}
		if json.Unmarshal([]byte(receipt.ResultJSON), &result) != nil || result.CanvasID != canvasID || result.ResourceID == "" {
			continue
		}
		if seen[result.ResourceID] {
			continue
		}
		resource, err := repo.ResourceByUploadKey(userID, "file-export:"+receipt.OpID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if resource.ID != result.ResourceID || resource.Status != model.ResourceStatusReady {
			continue
		}
		seen[resource.ID] = true
		outputs = append(outputs, ExportedFileOutput{
			ResourceID: resource.ID,
			FileName:   result.FileName,
			MimeType:   resource.MimeType,
			Bytes:      resource.Size,
		})
	}
	return outputs, nil
}

// PersistScriptOutputResources saves files written to BEEFTV_OUTPUT_DIR during
// a skill script run into owned local Resources so users can preview/download them
// directly from the chat card.
func PersistScriptOutputResources(db *gorm.DB, dataDir, userID, canvasID, proposalID string, res *skills.ScriptRunResult) {
	if db == nil || strings.TrimSpace(dataDir) == "" || strings.TrimSpace(userID) == "" || res == nil || len(res.OutputFiles) == 0 {
		return
	}
	outDir := skills.OutputDirForRun(dataDir, canvasID, proposalID)
	if outDir == "" {
		return
	}
	cleanRoot := filepath.Clean(outDir)
	repo := repository.New(db)
	persisted := 0
	for i := range res.OutputFiles {
		if persisted >= scriptOutputMaxPersistNum {
			break
		}
		item := &res.OutputFiles[i]
		rel := strings.TrimSpace(item.Path)
		if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "..") {
			continue
		}
		fullPath := filepath.Join(cleanRoot, filepath.FromSlash(rel))
		checkedRel, err := filepath.Rel(cleanRoot, fullPath)
		if err != nil || checkedRel == ".." || strings.HasPrefix(checkedRel, ".."+string(filepath.Separator)) {
			continue
		}
		info, err := os.Lstat(fullPath)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > scriptOutputMaxPersistFile {
			continue
		}
		body, err := os.ReadFile(fullPath)
		if err != nil || int64(len(body)) > scriptOutputMaxPersistFile {
			continue
		}
		fileName, ext := sanitizeDeliverableFileName(filepath.Base(rel))
		mimeType := deliverableMimeType(ext, "")
		uploadKey := fmt.Sprintf("script-output:%s:%d:%s", strings.TrimSpace(proposalID), i, rel)
		resource, err := localasset.StoreDeliverable(repo, dataDir, userID, uploadKey, fileName, mimeType, body, 64, 0, 0)
		if err != nil || resource == nil {
			continue
		}
		item.ResourceID = resource.ID
		item.MimeType = resource.MimeType
		persisted++
	}
}
