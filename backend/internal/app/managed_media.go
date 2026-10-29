package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

// This adapter owns only the existing local send fence. BeefAPI owns the
// asynchronous task, provider retry and recovery after the first write.
type appManagedMediaPort struct{ service *Service }

func managedTaskConnection(task model.Task) bool {
	var input struct {
		Config struct {
			CredentialRef string `json:"credentialRef"`
			ChannelID     string `json:"channelId"`
		} `json:"config"`
	}
	return json.Unmarshal([]byte(task.InputJSON), &input) == nil && (input.Config.CredentialRef == beefapi.CredentialRef || input.Config.ChannelID == beefapi.ChannelID)
}

func (p appManagedMediaPort) Project(ctx context.Context, projection beefapi.MediaTask) {
	task, ok := ctx.Value(imageTaskContext{}).(model.Task)
	if !ok || p.service == nil {
		return
	}
	if projection.TaskID != "" {
		_ = p.service.repo.UpdateTaskImageJobID(task.ID, projection.TaskID)
	}
	var deadline *string
	if projection.ReconcileDeadline != nil {
		value := time.Unix(*projection.ReconcileDeadline, 0).UTC().Format(time.RFC3339)
		deadline = &value
	}
	_ = p.service.repo.UpdateTaskBeefImageSettlement(task.ID, projection.BillingState, deadline)
}

func (p appManagedMediaPort) Sent(ctx context.Context) (bool, error) {
	task, ok := ctx.Value(imageTaskContext{}).(model.Task)
	attempt, _ := ctx.Value(imageAttemptContext{}).(string)
	if p.service == nil || !ok || attempt == "" {
		return false, generation.ErrImageOwnerMissing
	}
	row, err := p.service.repo.ImageSubmission(attempt, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return row.SendCount > 0 || row.ResponseAccepted, nil
}
func (p appManagedMediaPort) Begin(req *http.Request) (bool, error) {
	row, handled, err := prepareImageSubmission(p.service, req)
	if err != nil {
		return false, err
	}
	if !handled {
		return false, generation.ErrImageOwnerMissing
	}
	if row.SendCount > 0 || row.ResponseAccepted {
		return true, nil
	}
	wire, err := p.service.imageSubmissionWire(row)
	if err != nil {
		return false, err
	}
	if wire.ReplayProtocol != beefapi.MediaProtocolVersion || wire.Header.Get("Idempotency-Key") != req.Header.Get("Idempotency-Key") || wire.URL != req.URL.String() {
		return false, errors.New("媒体任务原始提交身份不一致")
	}
	task := req.Context().Value(imageTaskContext{}).(model.Task)
	if err := p.service.repo.ClaimImageSubmissionSend(row, task.LeaseOwner, 1); err != nil {
		current, loadErr := p.service.repo.ImageSubmission(row.AttemptID, row.TaskID, row.UserID)
		if loadErr == nil && (current.SendCount > 0 || current.ResponseAccepted) {
			return true, nil
		}
		return false, err
	}
	req.Body = ioReadCloser(wire.Body)
	req.ContentLength = int64(len(wire.Body))
	return false, nil
}

type memoryReadCloser struct{ *bytes.Reader }

func (memoryReadCloser) Close() error            { return nil }
func ioReadCloser(data []byte) *memoryReadCloser { return &memoryReadCloser{bytes.NewReader(data)} }

func isManagedMediaRequest(req *http.Request) bool {
	return req != nil && req.URL != nil && req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/media/tasks") && req.Header.Get(beefapi.MediaProtocolHeader) == beefapi.MediaProtocolVersion
}
func managedFrozenImage(task model.Task, wire imageWireRequest) bool {
	if wire.ReplayProtocol == beefapi.MediaProtocolVersion || wire.ChannelID == beefapi.ChannelID {
		return true
	}
	return managedTaskConnection(task)
}

func (s *Service) managedImageQueryCipher(task model.Task, wire imageWireRequest) (string, error) {
	if !managedFrozenImage(task, wire) {
		return "", nil
	}
	wire.Body = nil
	raw, err := json.Marshal(wire)
	if err != nil {
		return "", err
	}
	return s.encryptSettingSecret(string(raw))
}

func (s *Service) expireImageSubmissionRequests() error {
	for {
		rows, err := s.repo.ExpiredImageSubmissionRequests()
		if err != nil {
			return err
		}
		for _, row := range rows {
			query := row.QueryCipher
			if query == "" {
				// Old frozen requests can contain 64MiB of inline bytes. Read and
				// decrypt one at a time; the cleanup batch only contains small fields.
				full, err := s.repo.ImageSubmission(row.AttemptID, row.TaskID, row.UserID)
				if err != nil {
					return err
				}
				row = *full
				query = row.QueryCipher
				if wire, err := s.imageSubmissionWire(&row); query == "" && err == nil {
					if task, err := s.repo.TaskForUser(row.UserID, row.TaskID); err == nil {
						if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt.ID == row.AttemptID && attempt.ChannelID == beefapi.ChannelID {
							wire.ChannelID = beefapi.ChannelID
						}
						query, err = s.managedImageQueryCipher(*task, wire)
						if err != nil {
							return err
						}
					}
				}
			}
			if err := s.repo.ExpireImageSubmissionRequest(row, query); err != nil {
				return err
			}
		}
		if len(rows) < 100 {
			return nil
		}
	}
}

func (s *Service) managedImageQueryClient(ctx context.Context, task model.Task, row *model.ImageSubmission) (*beefapi.MediaClient, string, bool, bool, error) {
	managed := managedTaskConnection(task) || row.QueryCipher != ""
	if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil && attempt.ID == row.AttemptID && attempt.ChannelID == beefapi.ChannelID {
		managed = true
	}
	var wire imageWireRequest
	var err error
	if row.QueryCipher != "" {
		var plain string
		plain, err = s.decryptSettingSecret(row.QueryCipher)
		if err == nil {
			err = json.Unmarshal([]byte(plain), &wire)
		}
	} else {
		wire, err = s.imageSubmissionWire(row)
	}
	if err != nil {
		return nil, "", false, managed, imageRecoveryError{errors.New("原任务查询信息暂不可用，尚未确认结果")}
	}
	managed = managed || managedFrozenImage(task, wire)
	if !managed {
		return nil, "", false, false, nil
	}
	if row.QueryCipher == "" {
		wire.ChannelID = beefapi.ChannelID
		cipher, cipherErr := s.managedImageQueryCipher(task, wire)
		if cipherErr != nil {
			return nil, "", false, true, cipherErr
		}
		if cipher != "" {
			if err := s.repo.SaveImageQueryCipher(*row, cipher); err != nil {
				return nil, "", false, true, err
			}
		}
	}
	key := strings.TrimSpace(wire.Header.Get("Idempotency-Key"))
	if key == "" {
		return nil, "", false, true, imageRecoveryError{errors.New("历史图片任务缺少原始查询编号")}
	}
	base := wire.URL
	for _, part := range []string{"/media/tasks", "/images/generations", "/images/edits"} {
		if index := strings.LastIndex(base, part); index >= 0 {
			base = base[:index]
			break
		}
	}
	client := &beefapi.MediaClient{BaseURL: base, APIKey: strings.TrimPrefix(wire.Header.Get("Authorization"), "Bearer "), Headers: wire.Header.Clone()}
	runtime, _ := generation.RuntimeFromContext(ctx)
	client.AllowHTTPTest = runtime.Endpoints.BeefAPIVideoBaseURL != ""
	client.Project = appManagedMediaPort{service: s}.Project
	client.Observe = func(req *http.Request, resp *http.Response, body []byte, callErr error) {
		if runtime.Receipts == nil {
			return
		}
		observation := generation.TransportObservation{Request: req, Body: body, Err: callErr, Dispatched: true}
		if resp != nil {
			observation.StatusCode = resp.StatusCode
			observation.HTTPStatus = resp.StatusCode
			observation.Headers = resp.Header.Clone()
		}
		runtime.Receipts.Observe(observation)
	}
	return client, key, wire.ReplayProtocol != beefapi.MediaProtocolVersion, true, nil
}

func (s *Service) collectManagedImage(ctx context.Context, task model.Task, row *model.ImageSubmission) (map[string]any, bool, error) {
	client, key, legacy, managed, err := s.managedImageQueryClient(ctx, task, row)
	if err != nil || !managed {
		return nil, managed, err
	}
	result, err := client.Wait(ctx, key, "image", legacy)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	return result, true, nil
}
