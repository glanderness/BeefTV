package task

import (
	"encoding/json"
	"net/http"
	"testing"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type sqliteCanvasLoader struct{ repo *repository.Repository }

func (l sqliteCanvasLoader) UserCanvasProject(userID, canvasID string) (json.RawMessage, error) {
	project, err := l.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(project.PayloadJSON), nil
}

func seedCanvasDoc(t *testing.T, db *gorm.DB, id, userID string, payload map[string]any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasProject{
		ID: id, UserID: userID, Title: id, Revision: 1, PayloadJSON: string(raw),
	}).Error; err != nil {
		t.Fatal(err)
	}
}

func TestSQLiteCreateTimelineRenderTaskResolvesCanvasNodeSourcesAndEnforcesOwnership(t *testing.T) {
	svc, db, _ := specializedSQLite(t, func(deps *Dependencies, _ *drainRuntime) {
		// Wired below once repo is built; see helper override via sqliteDB.
		_ = deps
	})
	repo := repository.New(db)
	svc.deps.TimelineSources = NewRepositoryTimelineSources(repo, sqliteCanvasLoader{repo: repo})

	seedSQLiteUser(t, db, "owner", "", "res-vid", "video/mp4")
	seedSQLiteUser(t, db, "owner", "", "res-img", "image/png")
	seedSQLiteUser(t, db, "owner", "", "res-aud", "audio/mp4")
	seedSQLiteUser(t, db, "owner", "", "res-local", "video/mp4")
	seedSQLiteUser(t, db, "other", "", "res-foreign", "video/mp4")
	if err := db.Create(&model.Resource{
		ID: "res-pending", UserID: "owner", Kind: "video", Status: model.ResourceStatusPending,
		Provider: "local", MimeType: "video/mp4", Size: 512, ObjectKey: "users/owner/res-pending",
	}).Error; err != nil {
		t.Fatal(err)
	}

	seedCanvasDoc(t, db, "canvas-owner", "owner", map[string]any{
		"id":       "canvas-owner",
		"revision": 1,
		"nodes": []any{
			map[string]any{
				"id":   "node-vid",
				"type": "video",
				"metadata": map[string]any{
					"storageKey":   "resource:res-vid",
					"videoPreview": map[string]any{"storageKey": "resource:res-img"},
				},
			},
			map[string]any{
				"id":       "node-img",
				"type":     "image",
				"metadata": map[string]any{"storageKey": "resource:res-img"},
			},
			map[string]any{
				"id":       "node-aud",
				"type":     "audio",
				"metadata": map[string]any{"resourceId": "res-aud"},
			},
			map[string]any{
				"id":       "node-pending",
				"type":     "video",
				"metadata": map[string]any{"storageKey": "resource:res-pending"},
			},
		},
	})
	seedCanvasDoc(t, db, "canvas-empty", "owner", map[string]any{
		"id":       "canvas-empty",
		"revision": 1,
		"nodes":    []any{},
	})
	seedCanvasDoc(t, db, "canvas-foreign", "other", map[string]any{
		"id":       "canvas-foreign",
		"revision": 1,
		"nodes": []any{
			map[string]any{"id": "node-other", "type": "video", "metadata": map[string]any{"storageKey": "resource:res-foreign"}},
		},
	})

	visible := true
	burn := true
	nodeOnlyTimeline := editing.Project{
		Version:    2,
		DurationMs: 4000,
		Tracks: []editing.Track{
			{ID: "v1", Kind: editing.KindVideo, Visible: &visible},
			{ID: "a1", Kind: editing.KindAudio, Visible: &visible},
			{ID: "s1", Kind: editing.KindSubtitle, Visible: &visible},
		},
		Clips: []editing.Clip{
			{ID: "c-vid", Kind: editing.KindVideo, NodeID: "node-vid", TrackID: "v1", StartMs: 0, DurationMs: 2000, Volume: 1},
			{ID: "c-img", Kind: editing.KindImage, NodeID: "node-img", TrackID: "v1", StartMs: 2000, DurationMs: 2000, Volume: 1},
			{ID: "c-aud", Kind: editing.KindAudio, NodeID: "node-aud", TrackID: "a1", StartMs: 0, DurationMs: 4000, Volume: 0.8, FadeInMs: 300, FadeOutMs: 400},
			{ID: "c-sub", Kind: editing.KindSubtitle, NodeID: "node-vid", TrackID: "s1", StartMs: 500, DurationMs: 1500, Text: "竖屏成片字幕"},
		},
	}
	created, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "canvas-owner",
		Timeline:  nodeOnlyTimeline,
		Options:   editing.Options{Width: 1080, Height: 1920, FPS: 30, BurnSubtitles: &burn},
	})
	if err != nil {
		t.Fatalf("node-only 9:16 timeline rejected: %v", err)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", created.ID).Error; err != nil {
		t.Fatal(err)
	}
	var savedInput TimelineRenderInput
	if err := json.Unmarshal([]byte(stored.InputJSON), &savedInput); err != nil {
		t.Fatal(err)
	}
	// Worker compiles saved InputJSON with sources=nil; canonical directMedia must have been populated.
	plan, err := editing.Compile(savedInput.Timeline, nil, savedInput.Options)
	if err != nil {
		t.Fatalf("worker compile failed on persisted input: %v", err)
	}
	if plan.Output.Width != 1080 || plan.Output.Height != 1920 {
		t.Fatalf("output = %dx%d, want 1080x1920", plan.Output.Width, plan.Output.Height)
	}
	if len(plan.Segments) != 2 || plan.Segments[0].SourceID != "res-vid" || plan.Segments[1].SourceID != "res-img" {
		t.Fatalf("segments = %+v", plan.Segments)
	}
	if len(plan.Audio) != 1 || plan.Audio[0].SourceID != "res-aud" {
		t.Fatalf("audio = %+v", plan.Audio)
	}

	// Empty canvas with unsaved direct-uploaded owned resource must succeed.
	emptyCanvasUpload := editing.Project{
		Version:    2,
		DurationMs: 2000,
		Tracks:     []editing.Track{{ID: "v1", Kind: editing.KindVideo, Visible: &visible}},
		Clips: []editing.Clip{{
			ID: "c-local", Kind: editing.KindVideo, NodeID: "timeline-media-local-1", TrackID: "v1",
			StartMs: 0, DurationMs: 2000, Volume: 1,
			DirectMedia: &editing.DirectMedia{ID: "local-1", Kind: editing.KindVideo, StorageKey: "resource:res-local"},
		}},
	}
	if _, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
		ProjectID: "canvas-empty",
		Timeline:  emptyCanvasUpload,
	}); err != nil {
		t.Fatalf("empty canvas direct upload rejected: %v", err)
	}

	beforeRejectCount := countTasks(t, db, "owner")

	rejectCases := []struct {
		name       string
		projectID  string
		clip       editing.Clip
		wantStatus int
	}{
		{
			name:       "foreign-node-not-in-canvas",
			projectID:  "canvas-owner",
			clip:       editing.Clip{ID: "c1", Kind: editing.KindVideo, NodeID: "node-does-not-exist", TrackID: "v1", StartMs: 0, DurationMs: 1000, Volume: 1},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "foreign-canvas-node",
			projectID:  "canvas-foreign",
			clip:       editing.Clip{ID: "c2", Kind: editing.KindVideo, NodeID: "node-other", TrackID: "v1", StartMs: 0, DurationMs: 1000, Volume: 1},
			wantStatus: http.StatusForbidden,
		},
		{
			name:      "foreign-resource-direct-media",
			projectID: "canvas-empty",
			clip: editing.Clip{
				ID: "c3", Kind: editing.KindVideo, NodeID: "timeline-media-x", TrackID: "v1", StartMs: 0, DurationMs: 1000, Volume: 1,
				DirectMedia: &editing.DirectMedia{ID: "x", Kind: editing.KindVideo, StorageKey: "resource:res-foreign"},
			},
			wantStatus: http.StatusForbidden,
		},
		{
			name:      "mismatched-node-and-direct-media",
			projectID: "canvas-owner",
			clip: editing.Clip{
				ID: "c4", Kind: editing.KindVideo, NodeID: "node-vid", TrackID: "v1", StartMs: 0, DurationMs: 1000, Volume: 1,
				DirectMedia: &editing.DirectMedia{ID: "x", Kind: editing.KindVideo, StorageKey: "resource:res-local"},
			},
			wantStatus: http.StatusForbidden,
		},
		{
			name:      "unready-resource",
			projectID: "canvas-owner",
			clip:      editing.Clip{ID: "c5", Kind: editing.KindVideo, NodeID: "node-pending", TrackID: "v1", StartMs: 0, DurationMs: 1000, Volume: 1},
			wantStatus: http.StatusPreconditionFailed,
		},
		{
			name:      "external-url-smuggle",
			projectID: "canvas-empty",
			clip: editing.Clip{
				ID: "c6", Kind: editing.KindVideo, NodeID: "timeline-media-url", TrackID: "v1", StartMs: 0, DurationMs: 1000, Volume: 1,
				DirectMedia: &editing.DirectMedia{ID: "url", Kind: editing.KindVideo, StorageKey: "https://example.com/a.mp4"},
			},
			wantStatus: http.StatusForbidden,
		},
	}

	for _, tc := range rejectCases {
		t.Run(tc.name, func(t *testing.T) {
			project := editing.Project{
				Version:    2,
				DurationMs: 1000,
				Tracks:     []editing.Track{{ID: "v1", Kind: editing.KindVideo, Visible: &visible}},
				Clips:      []editing.Clip{tc.clip},
			}
			_, err := svc.CreateTimelineRenderTask("owner", TimelineRenderCreateRequest{
				ProjectID: tc.projectID,
				Timeline:  project,
			})
			if err == nil {
				t.Fatalf("%s unexpectedly admitted", tc.name)
			}
			if !isStatus(err, tc.wantStatus) {
				t.Fatalf("%s err = %v, want status %d", tc.name, err, tc.wantStatus)
			}
		})
	}

	if got := countTasks(t, db, "owner"); got != beforeRejectCount {
		t.Fatalf("rejected requests wrote task rows: got %d want %d", got, beforeRejectCount)
	}
}
