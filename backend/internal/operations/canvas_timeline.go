package operations

import (
	"encoding/json"
	"errors"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/timelinesources"
	"strings"
)

// timelineProjectSchema is the saved timeline contract. Every operation that
// accepts a whole timeline reuses it so validation cannot drift.
const timelineProjectSchema = `{"type":"object","description":"时间线 v2（毫秒）；可见 video/image 不可重叠","properties":{"version":{"type":"integer","enum":[2]},"durationMs":{"type":"integer"},"tracks":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["video","audio","subtitle","text","image"]},"visible":{"type":"boolean"},"muted":{"type":"boolean"}},"required":["id","kind"]}},"clips":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["video","image","audio","subtitle"]},"nodeId":{"type":"string"},"trackId":{"type":"string"},"startMs":{"type":"integer"},"durationMs":{"type":"integer"},"sourceStartMs":{"type":"integer"},"volume":{"type":"number"},"fadeInMs":{"type":"integer"},"fadeOutMs":{"type":"integer"},"text":{"type":"string"}},"required":["id","kind","trackId","startMs","durationMs"]}},"output":{"type":["object","null"],"properties":{"width":{"type":"integer"},"height":{"type":"integer"},"fps":{"type":"integer"},"burnSubtitles":{"type":"boolean"}}}},"required":["version","tracks","clips","durationMs"]}`

const timelineRefreshNodeIDsSchema = `{"type":"array","items":{"type":"string"},"description":"仅刷新指定节点素材引用（与 timeline 二选一）"}`

func registerCanvasTimelineOps(r *Registry) {
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.timeline.update", Summary: "修改画布时间线或用 refreshNodeIds 局部刷新节点素材", Scope: ScopeCanvas,
		Params: timelineUpdateSchema(), Handler: opCanvasTimelineUpdate})
}

func timelineUpdateSchema() json.RawMessage {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"canvasId":         map[string]any{"type": "string"},
			"expectedRevision": map[string]any{"type": "integer"},
			"timeline":         json.RawMessage(timelineProjectSchema),
			"refreshNodeIds":   json.RawMessage(timelineRefreshNodeIDsSchema),
		},
		"required": []string{"canvasId", "expectedRevision"},
		// 根级 oneOf 会让部分严格校验的工具端点拒绝整份工具清单。互斥条件由服务端校验，
		// 模型需要的约束放在参数描述里。
		"description": "timeline 与 refreshNodeIds 必须且只能提供一个；服务端校验互斥条件。",
	}
	encoded, _ := json.Marshal(schema)
	return encoded
}

func opCanvasTimelineUpdate(ctx *Context, params json.RawMessage) (any, error) {
	var wire timelineEditWire
	edit, err := decodeTimelineEdit(params, &wire)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(edit.canvasID) == "" || edit.expectedRevision == nil || *edit.expectedRevision < 0 ||
		edit.hasTimeline == edit.hasRefresh || (edit.timeline == nil) == (edit.refreshNodeIDs == nil) {
		return nil, InvalidArg("invalid_params", "需要 canvasId、expectedRevision，且 timeline 与 refreshNodeIds 二选一")
	}
	doc, err := canvasDocAtRevision(ctx, edit.canvasID, *edit.expectedRevision)
	if err != nil {
		return nil, err
	}
	revision, err := applyTimelineEdit(ctx, edit, params, doc)
	if err != nil {
		return nil, err
	}
	return map[string]any{"canvasId": edit.canvasID, "revision": revision, "timelineUpdated": true}, nil
}

// timelineEdit is the decoded, mutually exclusive way to change a timeline.
// Both entry points share it so they reject the same input in the same way.
type timelineEdit struct {
	canvasID         string
	expectedRevision *int64
	timeline         *editing.Project
	refreshNodeIDs   []string
	hasTimeline      bool
	hasRefresh       bool
}

type timelineEditWire struct {
	CanvasID         string           `json:"canvasId"`
	ExpectedRevision *int64           `json:"expectedRevision"`
	Timeline         *editing.Project `json:"timeline"`
	RefreshNodeIDs   []string         `json:"refreshNodeIds"`
}

func decodeTimelineEdit(params json.RawMessage, wire *timelineEditWire) (timelineEdit, error) {
	if err := decodeParams(params, wire); err != nil {
		return timelineEdit{}, err
	}
	return timelineEditFromParams(params, *wire), nil
}

// timelineEditFromParams reads only the fields shared by every caller; callers
// with extra parameters decode their own wire struct first.
func timelineEditFromParams(params json.RawMessage, wire timelineEditWire) timelineEdit {
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(params, &fields)
	_, hasTimeline := fields["timeline"]
	_, hasRefresh := fields["refreshNodeIds"]
	return timelineEdit{
		canvasID: wire.CanvasID, expectedRevision: wire.ExpectedRevision,
		timeline: wire.Timeline, refreshNodeIDs: wire.RefreshNodeIDs,
		hasTimeline: hasTimeline, hasRefresh: hasRefresh,
	}
}

func canvasDocAtRevision(ctx *Context, canvasID string, expectedRevision int64) (map[string]any, error) {
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, canvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	if revision := canvasRevision(doc); revision != expectedRevision {
		return nil, Conflict("revision_conflict", "画布已经变化，请重新读取", map[string]any{"currentRevision": revision})
	}
	return doc, nil
}

// applyTimelineEdit validates the edit against doc and commits it, returning
// the saved revision. params is the original request because an omitted output
// and an explicit null are different edits.
func applyTimelineEdit(ctx *Context, edit timelineEdit, params json.RawMessage, doc map[string]any) (int64, error) {
	revision := canvasRevision(doc)
	if edit.refreshNodeIDs != nil {
		if err := refreshTimelineSources(ctx, doc, edit.refreshNodeIDs); err != nil {
			return 0, err
		}
		return commitTimelineDoc(ctx, edit.canvasID, revision, doc)
	}
	if edit.timeline == nil {
		return revision, nil
	}
	if edit.timeline.Output == nil {
		var requested struct {
			Timeline map[string]json.RawMessage `json:"timeline"`
		}
		if err := json.Unmarshal(params, &requested); err != nil {
			return 0, InvalidArg("invalid_params", "timeline 必须是对象")
		}
		// An edit may replace tracks and clips without restating project output.
		// Explicit null clears the setting; omission retains only valid output.
		if _, present := requested.Timeline["output"]; !present {
			var saved struct {
				Output *editing.Options `json:"output"`
			}
			previous, marshalErr := json.Marshal(doc["timeline"])
			if marshalErr == nil && json.Unmarshal(previous, &saved) == nil && saved.Output != nil {
				if _, outputErr := editing.NormalizeOptions(*saved.Output); outputErr == nil {
					edit.timeline.Output = saved.Output
				}
			}
		}
	}
	sources, err := timelineSources(ctx, doc, edit.timeline)
	if err != nil {
		return 0, err
	}
	if _, err = editing.Compile(*edit.timeline, sources, editing.Options{}); err != nil {
		return 0, InvalidArg("invalid_timeline", err.Error())
	}
	// Encode the typed timeline; unknown fields can never introduce paths or URLs.
	timeline, err := json.Marshal(edit.timeline)
	if err != nil {
		return 0, AsError(err)
	}
	var value any
	if err = json.Unmarshal(timeline, &value); err != nil {
		return 0, AsError(err)
	}
	doc["timeline"] = value
	return commitTimelineDoc(ctx, edit.canvasID, revision, doc)
}

func commitTimelineDoc(ctx *Context, canvasID string, revision int64, doc map[string]any) (int64, error) {
	encoded, err := json.Marshal(doc)
	if err != nil {
		return 0, AsError(err)
	}
	summary, _, err := ctx.Domain.CommitUserCanvasDocument(ctx.UserID, canvasID, revision, encoded)
	if err != nil {
		return 0, mapDomainError(err)
	}
	return summary.Revision, nil
}

// Validate using the same ownership and render rules as a full edit, but write
// only the selected media references back into the original document.
func refreshTimelineSources(ctx *Context, doc map[string]any, nodeIDs []string) error {
	if len(nodeIDs) == 0 {
		return InvalidArg("invalid_params", "refreshNodeIds 至少需要 1 个节点")
	}
	selected := map[string]bool{}
	for _, id := range nodeIDs {
		if strings.TrimSpace(id) == "" || selected[id] {
			return InvalidArg("invalid_params", "refreshNodeIds 不能包含空节点或重复节点")
		}
		selected[id] = true
	}
	rawTimeline, ok := doc["timeline"].(map[string]any)
	if !ok {
		return InvalidArg("invalid_timeline", "当前画布没有可更新的时间线")
	}
	rawClips, ok := rawTimeline["clips"].([]any)
	if !ok {
		return InvalidArg("invalid_timeline", "当前时间线缺少片段")
	}
	raw, err := json.Marshal(rawTimeline)
	var project editing.Project
	if err != nil || json.Unmarshal(raw, &project) != nil {
		return InvalidArg("invalid_timeline", "当前时间线无法读取")
	}
	found := map[string]bool{}
	for i := range project.Clips {
		clip := &project.Clips[i]
		if selected[clip.NodeID] && clip.Kind != editing.KindSubtitle {
			clip.DirectMedia = nil
			found[clip.NodeID] = true
		}
	}
	if len(found) != len(selected) {
		return InvalidArg("timeline_node_not_used", "指定节点没有对应的媒体片段，未修改时间线")
	}
	sources, err := timelineSources(ctx, doc, &project)
	if err != nil {
		return err
	}
	if _, err := editing.Compile(project, sources, editing.Options{}); err != nil {
		return InvalidArg("invalid_timeline", err.Error())
	}
	for i, clip := range project.Clips {
		if selected[clip.NodeID] && clip.Kind != editing.KindSubtitle {
			rawClip, ok := rawClips[i].(map[string]any)
			if !ok {
				return InvalidArg("invalid_timeline", "时间线片段无法读取")
			}
			rawClip["directMedia"] = clip.DirectMedia
		}
	}
	return nil
}

func timelineSources(ctx *Context, doc map[string]any, project *editing.Project) ([]editing.SourceMeta, error) {
	sources, err := timelinesources.Resolve(ctx.UserID, doc, project, timelinesources.Ports{
		Resources: ctx.Domain,
		Assets:    ctx.Domain,
	}, timelinesources.Options{
		RequireCanvasDocumentMembership: true,
		RequireAssetLink:                true,
	})
	if err != nil {
		return nil, mapTimelineSourceError(err)
	}
	return sources, nil
}

func mapTimelineSourceError(err error) error {
	var tsErr *timelinesources.Error
	if errors.As(err, &tsErr) {
		switch tsErr.Kind {
		case timelinesources.KindPermissionDenied:
			return PermissionDenied(tsErr.Reason, tsErr.Message)
		case timelinesources.KindPreconditionFailed:
			return PreconditionFailed(tsErr.Reason, tsErr.Message, nil)
		default:
			return InvalidArg(tsErr.Reason, tsErr.Message)
		}
	}
	return mapDomainError(err)
}
