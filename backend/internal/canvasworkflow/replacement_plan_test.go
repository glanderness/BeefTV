package canvasworkflow

import (
	"math"
	"testing"
)

func TestReplacementPlanKeepsNewContinuousDanceWhole(t *testing.T) {
	p, err := PlanCharacterReplacement(714, 1280, 30, 422, nil, 12)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Segments) != 1 || p.Segments[0].StartFrame != 0 || p.Segments[0].EndFrame != 422 || p.Segments[0].GenerationSeconds != 15 {
		t.Fatalf("continuous input was unnecessarily split or truncated: %+v", p)
	}
}

func TestReplacementPlanCoversLongAndCutVideoWithoutOverlap(t *testing.T) {
	for _, cuts := range [][]int{nil, {90, 225, 225, 510, 511}} {
		p, err := PlanCharacterReplacement(1920, 1080, 30, 1801, cuts, 100)
		if err != nil {
			t.Fatal(err)
		}
		end := 0
		for _, segment := range p.Segments {
			if segment.StartFrame != end || segment.EndFrame <= segment.StartFrame || segment.ReferenceStartFrame > segment.StartFrame || segment.ReferenceEndFrame < segment.EndFrame {
				t.Fatalf("gap, overlap or missing context: %+v", p)
			}
			if segment.ReferenceEndFrame-segment.ReferenceStartFrame > 450 || segment.GenerationSeconds < 4 || segment.GenerationSeconds > 15 {
				t.Fatalf("outside Fast limits: %+v", segment)
			}
			for _, cut := range cuts {
				if segment.StartFrame < cut && segment.EndFrame > cut {
					t.Fatalf("crossed hard cut %d: %+v", cut, segment)
				}
			}
			end = segment.EndFrame
		}
		if end != 1801 {
			t.Fatalf("lost final frames: %+v", p)
		}
	}
}

func TestReplacementPlanPadsVeryShortReferenceWithoutExtendingSource(t *testing.T) {
	p, err := PlanCharacterReplacement(1080, 1080, 24, 7, nil, 12)
	if err != nil {
		t.Fatal(err)
	}
	s := p.Segments[0]
	if s.EndFrame != 7 || s.ReferenceFrames != 48 || s.GenerationSeconds != 4 {
		t.Fatalf("short reference/source contract: %+v", s)
	}
}

func TestReplacementPlanRejectsBadMetadataAndExcessPaidSegments(t *testing.T) {
	for _, dims := range [][2]int{{0, 1280}, {720, -1}, {8194, 1280}, {100, 2000}} {
		if _, err := PlanCharacterReplacement(dims[0], dims[1], 30, 422, nil, 12); err == nil {
			t.Fatalf("accepted invalid geometry %v", dims)
		}
	}
	if _, err := PlanCharacterReplacement(720, 1280, 30, 422, []int{423}, 12); err == nil {
		t.Fatal("accepted cut beyond source")
	}
	if _, err := PlanCharacterReplacement(720, 1280, 30, 1801, nil, 1); err == nil {
		t.Fatal("accepted more paid segments than authorized")
	}
	if _, err := PlanCharacterReplacement(720, 1280, 30, 0, nil, 12); err == nil {
		t.Fatal("accepted empty source")
	}
}

func TestReplacementFPSResamplesWithoutPretendingInvalidFactsAreValid(t *testing.T) {
	for _, tc := range []struct {
		source float64
		want   int
	}{{20.167, 24}, {23.976, 24}, {29.97, 30}, {30, 30}, {60, 60}, {120, 60}} {
		got, err := ReplacementFPS(tc.source)
		if err != nil || got != tc.want {
			t.Fatalf("fps %v -> %d, %v", tc.source, got, err)
		}
	}
	for _, fps := range []float64{0, -1, math.NaN(), math.Inf(1)} {
		if _, err := ReplacementFPS(fps); err == nil {
			t.Fatalf("accepted invalid FPS %v", fps)
		}
	}
}

func TestPreparedReplacementPlanRejectsGapsAndMissingResults(t *testing.T) {
	p, err := PlanCharacterReplacement(714, 1280, 30, 422, nil, 12)
	if err != nil {
		t.Fatal(err)
	}
	p.SourceResourceID = "source"
	p.Segments[0].ResourceID = "prepared"
	if err := ValidatePreparedReplacementPlan(p, false); err != nil {
		t.Fatal(err)
	}
	if err := ValidatePreparedReplacementPlan(p, true); err == nil {
		t.Fatal("accepted incomplete generation as final")
	}
	p.Segments[0].OutputResourceID = "generated"
	if err := ValidatePreparedReplacementPlan(p, true); err != nil {
		t.Fatal(err)
	}
	p.Segments[0].StartFrame = 1
	if err := ValidatePreparedReplacementPlan(p, true); err == nil {
		t.Fatal("accepted missing first frame")
	}
}
