package canvasworkflow

import (
	"fmt"
	"math"
	"sort"
)

type ReplacementSegment struct {
	StartFrame          int    `json:"startFrame"`
	EndFrame            int    `json:"endFrame"`
	ReferenceStartFrame int    `json:"referenceStartFrame"`
	ReferenceEndFrame   int    `json:"referenceEndFrame"`
	ReferenceFrames     int    `json:"referenceFrames"`
	GenerationSeconds   int    `json:"generationSeconds"`
	ResourceID          string `json:"resourceId,omitempty"`
	TaskID              string `json:"taskId,omitempty"`
	OutputResourceID    string `json:"outputResourceId,omitempty"`
}

type ReplacementPlan struct {
	Version          int                  `json:"version"`
	SourceResourceID string               `json:"sourceResourceId"`
	Width            int                  `json:"width"`
	Height           int                  `json:"height"`
	FPS              int                  `json:"fps"`
	FrameCount       int                  `json:"frameCount"`
	MinSeconds       int                  `json:"minSeconds,omitempty"`
	MaxSeconds       int                  `json:"maxSeconds,omitempty"`
	MinRefSeconds    int                  `json:"minRefSeconds,omitempty"`
	MinVideoAspect   float64              `json:"minVideoAspect,omitempty"`
	MaxVideoAspect   float64              `json:"maxVideoAspect,omitempty"`
	Segments         []ReplacementSegment `json:"segments"`
}

type ReplacementProgress struct {
	PrepareTaskID string           `json:"prepareTaskId,omitempty"`
	Plan          *ReplacementPlan `json:"plan,omitempty"`
	FinishTaskID  string           `json:"finishTaskId,omitempty"`
}

// The reference is resampled, never played at a different speed.
func ReplacementFPS(source float64) (int, error) {
	if math.IsNaN(source) || math.IsInf(source, 0) || source <= 0 {
		return 0, fmt.Errorf("无法读取视频的真实帧率")
	}
	return max(24, min(60, int(math.Round(source)))), nil
}

func PlanCharacterReplacement(width, height, fps, frames int, cuts []int, maxSegments int, customLimits ...ReplacementLimits) (ReplacementPlan, error) {
	lim := DefaultReplacementLimits()
	if len(customLimits) > 0 {
		c := customLimits[0]
		if c.MinSeconds > 0 {
			lim.MinSeconds = c.MinSeconds
		}
		if c.MaxSeconds > 0 {
			lim.MaxSeconds = c.MaxSeconds
		}
		if c.MinRefSeconds > 0 {
			lim.MinRefSeconds = c.MinRefSeconds
		}
		if c.MinVideoAspect > 0 {
			lim.MinVideoAspect = c.MinVideoAspect
		}
		if c.MaxVideoAspect > 0 {
			lim.MaxVideoAspect = c.MaxVideoAspect
		}
	}
	minSec, maxSec, minRefSec := lim.MinSeconds, lim.MaxSeconds, lim.MinRefSeconds
	p := ReplacementPlan{
		Version: 1, Width: (width + 1) / 2 * 2, Height: (height + 1) / 2 * 2, FPS: fps, FrameCount: frames,
		MinSeconds: minSec, MaxSeconds: maxSec, MinRefSeconds: minRefSec,
		MinVideoAspect: lim.MinVideoAspect, MaxVideoAspect: lim.MaxVideoAspect,
	}
	if minRefSec < 1 || minSec < minRefSec || maxSec < max(minSec, 5) || maxSec > 15 {
		return p, fmt.Errorf("人物替换模型时长范围无效")
	}
	if width < 2 || height < 2 || width > 8192 || height > 8192 || float64(width)/float64(height) < lim.MinVideoAspect || float64(width)/float64(height) > lim.MaxVideoAspect {
		return p, fmt.Errorf("当前模型支持宽高2–8192像素、宽高比%.2g–%.2g的视频，请先调整超出范围的素材", lim.MinVideoAspect, lim.MaxVideoAspect)
	}
	if fps < 24 || fps > 60 || frames < 1 || frames > fps*3600 || maxSegments < 1 || maxSegments > 100 {
		return p, fmt.Errorf("视频时间轴或最多生成片段数无效")
	}
	points := []int{0, frames}
	for _, cut := range cuts {
		if cut < 0 || cut > frames {
			return p, fmt.Errorf("镜头边界超出原视频范围")
		}
		if cut > 0 && cut < frames {
			points = append(points, cut)
		}
	}
	sort.Ints(points)
	for i := 1; i < len(points); i++ {
		start, end := points[i-1], points[i]
		if end == start {
			continue
		}
		length := end - start
		parts := 1
		if length > maxSec*fps {
			parts = (length + max(1, maxSec-1)*fps - 1) / (max(1, maxSec-1) * fps)
		}
		var built []ReplacementSegment
		for {
			if len(p.Segments)+parts > maxSegments {
				return p, fmt.Errorf("视频需要超过%d个生成片段，已在付费前停止；请提高片段上限或缩短输入", maxSegments)
			}
			built = built[:0]
			exceeds := false
			for part := 0; part < parts; part++ {
				a, b := start+length*part/parts, start+length*(part+1)/parts
				if b <= a {
					return p, fmt.Errorf("准备片段超过模型参考时长限制")
				}
				refStart, refEnd := max(start, a-fps/4), min(end, b+fps/4)
				refFrames := max(minRefSec*fps, refEnd-refStart)
				seconds := max(minSec, (refFrames+fps-1)/fps)
				if refFrames > maxSec*fps || seconds > maxSec {
					exceeds = true
					break
				}
				built = append(built, ReplacementSegment{StartFrame: a, EndFrame: b, ReferenceStartFrame: refStart, ReferenceEndFrame: refEnd, ReferenceFrames: refFrames, GenerationSeconds: seconds})
			}
			if !exceeds {
				break
			}
			parts++
		}
		p.Segments = append(p.Segments, built...)
	}
	return p, nil
}

func ValidatePreparedReplacementPlan(p ReplacementPlan, completed bool) error {
	if p.Version != 1 || p.SourceResourceID == "" || len(p.SourceResourceID) > 128 || len(p.Segments) < 1 || len(p.Segments) > 100 {
		return fmt.Errorf("人物替换准备记录无效")
	}
	lim := DefaultReplacementLimits()
	if p.MinSeconds > 0 {
		lim.MinSeconds = p.MinSeconds
	}
	if p.MaxSeconds > 0 {
		lim.MaxSeconds = p.MaxSeconds
	}
	if p.MinRefSeconds > 0 {
		lim.MinRefSeconds = p.MinRefSeconds
	}
	if p.MinVideoAspect > 0 {
		lim.MinVideoAspect = p.MinVideoAspect
	}
	if p.MaxVideoAspect > 0 {
		lim.MaxVideoAspect = p.MaxVideoAspect
	}
	if _, err := PlanCharacterReplacement(p.Width, p.Height, p.FPS, p.FrameCount, nil, 100, lim); err != nil {
		return err
	}
	end := 0
	for _, s := range p.Segments {
		if s.StartFrame != end || s.EndFrame <= s.StartFrame || s.EndFrame > p.FrameCount || s.ReferenceStartFrame < 0 || s.ReferenceStartFrame > s.StartFrame || s.ReferenceEndFrame < s.EndFrame || s.ReferenceEndFrame > p.FrameCount || s.ResourceID == "" || len(s.ResourceID) > 128 {
			return fmt.Errorf("人物替换片段不连续或缺少持久资源")
		}
		if s.ReferenceFrames != max(lim.MinRefSeconds*p.FPS, s.ReferenceEndFrame-s.ReferenceStartFrame) || s.GenerationSeconds != max(lim.MinSeconds, (s.ReferenceFrames+p.FPS-1)/p.FPS) || s.GenerationSeconds > lim.MaxSeconds {
			return fmt.Errorf("人物替换片段超出模型时间范围")
		}
		if completed && (s.OutputResourceID == "" || len(s.OutputResourceID) > 128) {
			return fmt.Errorf("人物替换仍有未完成的生成片段")
		}
		end = s.EndFrame
	}
	if end != p.FrameCount {
		return fmt.Errorf("人物替换时间轴没有覆盖完整视频")
	}
	return nil
}
