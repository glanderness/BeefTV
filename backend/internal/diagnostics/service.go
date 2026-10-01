package diagnostics

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"

	"gorm.io/gorm"
)

type Dependencies struct {
	Store Store
	Brand Brand
	Now   func() time.Time
	NewID func() string
}

type Service struct {
	store Store
	brand Brand
	now   func() time.Time
	newID func() string
}

func New(deps Dependencies) *Service {
	now := deps.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	newID := deps.NewID
	if newID == nil {
		newID = kernel.NewID
	}
	brand := deps.Brand
	if brand == nil {
		brand = staticBrand{name: defaultBrandName, slug: defaultBrandSlug}
	}
	return &Service{store: deps.Store, brand: brand, now: now, newID: newID}
}

func (s *Service) Preview(userID string, req ExportRequest) (*Preview, error) {
	collection, err := s.collect(userID, req)
	if err != nil {
		return nil, err
	}
	return &Preview{
		ClientEventLimit: maxClientEvents,
		TaskCount:        len(collection.Tasks), TaskLogCount: len(collection.TaskLogs), APICallCount: len(collection.APICalls),
		EstimatedBytes: int64(2048 + len(collection.ClientEvents)*420 + len(collection.Tasks)*620 + len(collection.TaskLogs)*700 + len(collection.APICalls)*520),
		WillTruncate:   collection.Truncated,
	}, nil
}

func (s *Service) Export(userID string, req ExportRequest) (*Bundle, error) {
	collection, err := s.collect(userID, req)
	if err != nil {
		return nil, err
	}
	bundleID := "DIAG_" + strings.ToUpper(s.newID()[:8])
	manifest := manifest{
		SchemaVersion: SchemaVersion, BundleID: bundleID, GeneratedAt: s.now().UTC(),
		AppVersion: collection.Runtime.AppVersion, BuildCommit: collection.Runtime.BuildCommit,
		TimeRange: timeRange{From: collection.Window.From, To: collection.Window.To},
		TaskID:    collection.TaskID, ProjectID: collection.ProjectID, Description: collection.Description,
		RedactionVersion: RedactionVersion, Truncated: collection.Truncated,
		Counts: counts{ClientEvents: len(collection.ClientEvents), Tasks: len(collection.Tasks), TaskLogs: len(collection.TaskLogs), APICalls: len(collection.APICalls)},
	}
	brandName, brandSlug := s.brand.NameAndSlug()
	if strings.TrimSpace(brandName) == "" {
		brandName = defaultBrandName
	}
	if strings.TrimSpace(brandSlug) == "" {
		brandSlug = defaultBrandSlug
	}
	data, err := buildZIP(brandName, bundleID, manifest, collection)
	if err != nil {
		return nil, err
	}
	if len(data) > maxBundleBytes {
		return nil, kernel.BadAuthRequest("诊断包超过 10 MB，请缩短时间范围后重试")
	}
	fileName := fmt.Sprintf("%s-diagnostics-%s-%s.zip", brandSlug, s.now().UTC().Format("20060102-150405"), bundleID)
	return &Bundle{BundleID: bundleID, FileName: fileName, Data: data}, nil
}

func (s *Service) collect(userID string, req ExportRequest) (*collection, error) {
	if s == nil || s.store == nil {
		return nil, kernel.Unauthorized("本地工作区尚未初始化")
	}
	window, err := s.normalizeWindow(req.From, req.To)
	if err != nil {
		return nil, err
	}
	taskID := strings.TrimSpace(req.TaskID)
	projectID := strings.TrimSpace(req.ProjectID)
	if len(taskID) > 96 || len(projectID) > 96 {
		return nil, kernel.BadAuthRequest("诊断上下文无效")
	}
	if taskID != "" {
		task, taskErr := s.store.TaskForUser(userID, taskID)
		if errors.Is(taskErr, gorm.ErrRecordNotFound) {
			return nil, kernel.BadAuthRequest("任务不存在或无权访问")
		}
		if taskErr != nil {
			return nil, taskErr
		}
		if projectID != "" && task.ProjectID != projectID {
			return nil, kernel.BadAuthRequest("任务不属于当前项目")
		}
		if projectID == "" {
			projectID = task.ProjectID
		}
	}
	tasks, err := s.store.DiagnosticTasks(userID, window.From, window.To, taskID, projectID)
	if err != nil {
		return nil, err
	}
	taskLogs, err := s.store.DiagnosticTaskLogs(userID, window.From, window.To, taskID, projectID)
	if err != nil {
		return nil, err
	}
	apiCalls, err := s.store.DiagnosticAPICallLogs(userID, window.From, window.To, taskID, projectID)
	if err != nil {
		return nil, err
	}
	clientEvents := req.ClientEvents
	truncated := false
	if len(clientEvents) > maxClientEvents {
		clientEvents = clientEvents[len(clientEvents)-maxClientEvents:]
		truncated = true
	}
	collected := &collection{
		Window: window, Description: redactText(req.Description, maxDescription), TaskID: taskID, ProjectID: projectID, Truncated: truncated,
		Runtime: runtimeRecord{
			AppVersion: redactText(req.Runtime.AppVersion, 120), BuildCommit: redactText(req.Runtime.BuildCommit, 120),
			Browser: redactText(req.Runtime.Browser, 240), OS: redactText(req.Runtime.OS, 120), Timezone: redactText(req.Runtime.Timezone, 80),
		},
	}
	for _, event := range clientEvents {
		collected.ClientEvents = append(collected.ClientEvents, sanitizeClientEvent(event))
	}
	for _, task := range tasks {
		collected.Tasks = append(collected.Tasks, sanitizeTask(task))
	}
	for _, taskLog := range taskLogs {
		collected.TaskLogs = append(collected.TaskLogs, sanitizeTaskLog(taskLog))
	}
	for _, apiCall := range apiCalls {
		collected.APICalls = append(collected.APICalls, sanitizeAPICall(apiCall))
	}
	return collected, nil
}

func (s *Service) normalizeWindow(fromRaw string, toRaw string) (timeWindow, error) {
	now := s.now().UTC()
	from, to := now.Add(-30*time.Minute), now
	var err error
	if strings.TrimSpace(fromRaw) != "" {
		from, err = time.Parse(time.RFC3339Nano, strings.TrimSpace(fromRaw))
		if err != nil {
			return timeWindow{}, kernel.BadAuthRequest("诊断开始时间格式无效")
		}
	}
	if strings.TrimSpace(toRaw) != "" {
		to, err = time.Parse(time.RFC3339Nano, strings.TrimSpace(toRaw))
		if err != nil {
			return timeWindow{}, kernel.BadAuthRequest("诊断结束时间格式无效")
		}
	}
	from, to = from.UTC(), to.UTC()
	if to.After(now) {
		to = now
	}
	if !to.After(from) {
		return timeWindow{}, kernel.BadAuthRequest("诊断时间范围无效")
	}
	if to.Sub(from) > maxWindow {
		return timeWindow{}, kernel.BadAuthRequest("诊断时间范围不能超过 24 小时")
	}
	return timeWindow{From: from, To: to}, nil
}
