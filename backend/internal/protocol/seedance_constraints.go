package protocol

import "strings"

// NormalizeSeedanceTaskOptions applies only explicit task intent, never guesses
// edit/extend intent from free-form prompts. See the official Seedance 2.5 guide.
func NormalizeSeedanceTaskOptions(r GenerationRequest) GenerationRequest {
	m := strings.ToLower(r.Model)
	if !(strings.HasSuffix(m, "seedance-2.5") || strings.Contains(m, "seedance-2.5-") || strings.HasSuffix(m, "seedance-2-5") || strings.Contains(m, "seedance-2-5-")) {
		return r
	}
	locked := false
	for _, media := range r.Images {
		locked = locked || media.Role == "first_frame" || media.Role == "last_frame"
	}
	if len(r.Videos) > 0 {
		switch r.Operation {
		case "extend":
			locked = true
		case "inpaint", "replace_element", "style_transfer":
			locked = true
			r.Duration = -1
		}
	}
	if locked {
		r.AspectRatio = "adaptive"
	}
	if draftTaskID, ok := r.Extra["draft_task_id"].(string); ok && strings.TrimSpace(draftTaskID) != "" {
		r.Operation = "draft_to_final"
		r.Prompt = ""
		r.Images = nil
		r.Videos = nil
		r.Audios = nil
		r.Inputs = nil
		delete(r.Extra, "draft")
		r.Output.AspectRatio, r.Output.Duration, r.Output.Resolution = r.AspectRatio, r.Duration, r.Resolution
		return r
	}
	if draft, ok := r.Extra["draft"].(bool); ok && draft {
		r.Resolution = "480p"
	}
	r.Output.AspectRatio, r.Output.Duration, r.Output.Resolution = r.AspectRatio, r.Duration, r.Resolution
	return r
}

func ApplySeedanceBodyFields(body map[string]any, r GenerationRequest) {
	if draftTaskID, ok := r.Extra["draft_task_id"].(string); ok && strings.TrimSpace(draftTaskID) != "" {
		id := strings.TrimSpace(draftTaskID)
		body["content"] = []map[string]any{{"type": "draft_task", "draft_task": map[string]any{"id": id}}}
		delete(body, "prompt")
		delete(body, "images")
		delete(body, "videos")
		delete(body, "audios")
		delete(body, "ratio")
		delete(body, "aspect_ratio")
		delete(body, "duration")
		delete(body, "generate_audio")
		delete(body, "draft")
		delete(body, "omni_reference_task_type")
		return
	}
	if kind := SeedanceOmniTaskType(r); kind != "" {
		body["omni_reference_task_type"] = kind
	}
	if draft, ok := r.Extra["draft"].(bool); ok && draft {
		body["draft"] = true
		if _, hasResolution := body["resolution"]; hasResolution {
			body["resolution"] = "480p"
		}
	}
}

// SeedanceOmniTaskType preserves explicit operation intent at the wire boundary.
func SeedanceOmniTaskType(r GenerationRequest) string {
	m := strings.ToLower(r.Model)
	if !(strings.HasSuffix(m, "seedance-2.5") || strings.Contains(m, "seedance-2.5-") || strings.HasSuffix(m, "seedance-2-5") || strings.Contains(m, "seedance-2-5-")) {
		return ""
	}
	switch r.Operation {
	case "reference_to_video":
		return "reference"
	case "extend":
		if len(r.Videos) > 0 {
			return "extend"
		}
	case "inpaint", "replace_element", "style_transfer":
		if len(r.Videos) > 0 {
			return "edit"
		}
	}
	return ""
}
