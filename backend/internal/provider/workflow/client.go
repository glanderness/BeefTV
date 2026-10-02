package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"
)

// Client executes RunningHub workflow create/poll/download through typed ports.
type Client struct {
	Requests RequestExecutor
	Media    MediaLoader
	Receipt  Receipt
	Progress Progress
	Plugins  PluginAvailability
	Time     TimePolicy
	Poller   VideoPoller
}

// prepared returns a shallow copy with optional Progress/Time defaults.
// It never writes back onto the receiver, so a shared Client is safe to reuse.
func (c *Client) prepared() *Client {
	out := Client{}
	if c != nil {
		out = *c
	}
	if out.Progress == nil {
		out.Progress = noopProgress{}
	}
	if out.Time == nil {
		out.Time = DefaultTimePolicy{}
	}
	return &out
}

func (c *Client) requireActor(ctx context.Context, interfaceType string) error {
	if c.Plugins == nil {
		return errors.New("工作流缺少插件授权端口")
	}
	return c.Plugins.EnsureEnabled(ctx, interfaceType)
}

func (c *Client) requirePaidCreate(ctx context.Context) error {
	if c.Requests == nil {
		return errors.New("工作流缺少受保护的请求执行端口")
	}
	if c.Receipt == nil {
		return errors.New("工作流缺少受理回执端口")
	}
	return c.Receipt.Ready(ctx)
}

// Run is the workflow-provider entry. Plugin authorization is required.
func (c *Client) Run(ctx context.Context, input Input) (map[string]interface{}, error) {
	exec := c.prepared()
	if isRunningHubInterface(input.Config.InterfaceType) {
		return exec.runRunningHub(ctx, input)
	}
	if err := exec.requireActor(ctx, input.Config.InterfaceType); err != nil {
		return nil, err
	}
	return nil, errors.New("未知工作流协议")
}

// RunRunningHub submits or resumes a RunningHub workflow/app task.
func (c *Client) RunRunningHub(ctx context.Context, input Input) (map[string]interface{}, error) {
	return c.prepared().runRunningHub(ctx, input)
}

func (c *Client) runRunningHub(ctx context.Context, input Input) (map[string]interface{}, error) {
	if input.LocalWorkspace && (len(input.ReferenceImages) > 0 || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 || input.Mask != nil) {
		return nil, errors.New("本地工作区不支持将参考素材上传到 RunningHub")
	}
	if err := c.requireActor(ctx, input.Config.InterfaceType); err != nil {
		return nil, err
	}
	root := runningHubRootURL(input.Config.BaseURL)
	apiKey := runningHubAPIKey(input.Config)
	if resumed := strings.TrimSpace(input.ResumedRequestID); resumed != "" {
		if c.Requests == nil {
			return nil, errors.New("工作流缺少受保护的请求执行端口")
		}
		return c.Poll(ctx, input.Config, root, resumed, input.Mode)
	}
	if err := c.requirePaidCreate(ctx); err != nil {
		return nil, err
	}
	workflowID := strings.TrimSpace(input.Config.WorkflowID)
	webappID := strings.TrimSpace(input.Config.WebappID)
	if workflowID == "" {
		workflowID = strings.TrimSpace(input.Config.Model)
	}
	mappingWorkflow := input.Config.WorkflowJSON
	if webappID == "" && len(mappingWorkflow) == 0 && workflowID != "" {
		if fetched, fetchErr := c.FetchWorkflowJSON(ctx, root, input.Config, workflowID); fetchErr == nil {
			mappingWorkflow = fetched
		}
	}
	workflowFields := input.Config.WorkflowFields
	if len(workflowFields) == 0 && len(mappingWorkflow) > 0 {
		var inferErr error
		workflowFields, inferErr = workflowFieldsFromManagement(mappingWorkflow, input.Mode)
		if inferErr != nil {
			return nil, inferErr
		}
	}
	workflowFields = workflowFieldsForMode(workflowFields, input.Mode)
	if err := validateWorkflowMediaInputs(workflowFields, input); err != nil {
		return nil, err
	}
	files := map[string]string{}
	for _, media := range append(append(append([]Media{}, input.ReferenceImages...), input.ReferenceVideos...), input.ReferenceAudios...) {
		name, err := c.UploadMedia(ctx, root, input.Config, media, input.LocalWorkspace)
		if err != nil {
			return nil, err
		}
		files[media.ID] = name
	}
	if input.Mask != nil {
		name, err := c.UploadMedia(ctx, root, input.Config, *input.Mask, input.LocalWorkspace)
		if err != nil {
			return nil, err
		}
		files[input.Mask.ID] = name
	}
	nodeInfo, err := runningHubNodeInfoWithWorkflow(workflowFields, files, input, mappingWorkflow)
	if err != nil {
		return nil, err
	}
	if !workflowFieldsBindPrompt(workflowFields) {
		nodeInfo = upsertRunningHubNodeInfo(nodeInfo, runningHubPromptFallback(mappingWorkflow, input.Prompt))
	}
	body := map[string]any{"apiKey": apiKey}
	endpoint := root + "/task/openapi/create"
	if webappID != "" {
		body["webappId"] = webappID
		endpoint = root + "/task/openapi/ai-app/run"
	} else {
		body["workflowId"] = workflowID
	}
	if len(nodeInfo) > 0 {
		body["nodeInfoList"] = nodeInfo
	}
	submitted, err := c.PostJSON(ctx, input.Config, endpoint, "", body)
	if err != nil {
		return nil, CreateUncertain{Err: fmt.Errorf("RunningHub 工作流提交失败：%w", err)}
	}
	code, validCode := runningHubPayloadCode(submitted)
	if validCode && code != 0 {
		return nil, fmt.Errorf("RunningHub 工作流提交失败：%s", runningHubWorkflowFailureMessage(submitted))
	}
	taskID := runningHubTaskID(submitted)
	if taskID == "" {
		return nil, CreateUncertain{Err: errors.New("RunningHub 未返回 taskId")}
	}
	if err := c.Receipt.RecordAccepted(ctx, taskID, "submitted", nil); err != nil {
		c.Progress.Log(ctx, "error", "RunningHub 请求状态保存失败", taskID+"："+err.Error())
		return nil, AcceptedNotRecorded{RequestID: taskID, Stage: "submitted", Err: err}
	}
	return c.Poll(ctx, input.Config, root, taskID, input.Mode)
}

// FetchWorkflowJSON loads the current API workflow JSON for field inference.
func (c *Client) FetchWorkflowJSON(ctx context.Context, root string, config Config, workflowID string) (map[string]interface{}, error) {
	c = c.prepared()
	response, err := c.PostJSON(ctx, config, root+"/api/openapi/getJsonApiFormat", "workflow-schema", map[string]any{
		"apiKey":     runningHubAPIKey(config),
		"workflowId": workflowID,
	})
	if err != nil {
		return nil, err
	}
	code, valid := runningHubPayloadCode(response)
	if valid && code != 0 {
		return nil, errors.New(runningHubFailureMessage(response))
	}
	data, _ := response["data"].(map[string]interface{})
	if data == nil {
		return nil, errors.New("RunningHub 工作流参数响应缺少 data")
	}
	return parseWorkflowPrompt(data["prompt"], true)
}

// UploadMedia uploads one reference file. Local workspace always rejects.
func (c *Client) UploadMedia(ctx context.Context, root string, config Config, media Media, localWorkspace bool) (string, error) {
	c = c.prepared()
	if localWorkspace {
		return "", errors.New("本地工作区不支持将素材上传到 RunningHub")
	}
	if c.Media == nil {
		return "", errors.New("工作流缺少受保护的素材读取端口")
	}
	raw, mimeType, err := c.Media.LocalBytes(media)
	if err != nil && isPublicMediaURL(strings.TrimSpace(media.URL)) {
		raw, mimeType, err = c.execute(ctx, Request{
			Kind:   "upload",
			Method: http.MethodGet,
			URL:    strings.TrimSpace(media.URL),
		})
	}
	if err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return "", errors.New("RunningHub 参考素材为空")
	}
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	apiKey := strings.TrimSpace(config.RunningHubUploadKey)
	if apiKey == "" {
		return "", errors.New("RunningHub 参考素材上传需要企业级 API Key，请在 RunningHub 设置中填写“素材上传 API Key（企业级）”")
	}
	_ = writer.WriteField("apiKey", apiKey)
	_ = writer.WriteField("fileType", "input")
	filename := mediaFilename(media, mimeType)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "file", "filename": filename}))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(raw); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	data, _, err := c.execute(ctx, Request{
		Kind:        "upload",
		Method:      http.MethodPost,
		URL:         root + "/task/openapi/upload",
		Headers:     config.Headers,
		ContentType: writer.FormDataContentType(),
		Body:        body.Bytes(),
	})
	if err != nil {
		if message := runningHubUploadAuthFailure(err); message != "" {
			return "", errors.New(message)
		}
		return "", fmt.Errorf("RunningHub 参考素材上传失败：%w", err)
	}
	var rawResponse map[string]any
	if err := json.Unmarshal(data, &rawResponse); err != nil {
		return "", errors.New("RunningHub 上传响应不是有效 JSON")
	}
	code, validCode := runningHubPayloadCode(rawResponse)
	if !validCode {
		validCode = runningHubFileName(rawResponse) != ""
		code = 0
	}
	if !validCode || code != 0 {
		return "", fmt.Errorf("RunningHub 上传素材失败：%s", runningHubFailureMessage(rawResponse))
	}
	fileName := runningHubFileName(rawResponse)
	if fileName == "" {
		return "", fmt.Errorf("RunningHub 上传素材失败：%s", runningHubFailureMessage(rawResponse))
	}
	return fileName, nil
}

// PostJSON sends a JSON body through RequestExecutor.
func (c *Client) PostJSON(ctx context.Context, config Config, endpoint string, kind string, body interface{}) (map[string]any, error) {
	c = c.prepared()
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	data, _, err := c.execute(ctx, Request{
		Kind:        kind,
		Method:      http.MethodPost,
		URL:         endpoint,
		Headers:     config.Headers,
		ContentType: "application/json",
		Body:        encoded,
	})
	if err != nil {
		return nil, err
	}
	var target map[string]any
	if err := json.Unmarshal(data, &target); err != nil {
		return nil, err
	}
	return target, nil
}

// Poll waits for the original accepted task. Video uses VideoPoller; other modes use the legacy interval.
func (c *Client) Poll(ctx context.Context, config Config, root string, taskID string, mode string) (map[string]interface{}, error) {
	c = c.prepared()
	if mode == "video" {
		return c.PollVideo(ctx, config, root, taskID, defaultVideoPolicy())
	}
	return c.pollLegacy(ctx, config, root, taskID)
}

// PollVideo queries the original task through the provider video poll loop.
func (c *Client) PollVideo(ctx context.Context, config Config, root string, taskID string, policy PollPolicy) (map[string]interface{}, error) {
	c = c.prepared()
	if c.Poller == nil {
		return nil, errors.New("工作流缺少视频轮询端口")
	}
	return c.Poller.Poll(ctx, taskID, policy, func(ctx context.Context) (PollOutcome, error) {
		response, err := c.PostJSON(ctx, config, root+"/task/openapi/outputs", "poll", map[string]any{"apiKey": runningHubAPIKey(config), "taskId": taskID})
		if err != nil {
			return PollOutcome{}, fmt.Errorf("RunningHub 查询任务失败：%w", err)
		}
		code, validCode := runningHubPayloadCode(response)
		if !validCode {
			validCode = len(runningHubOutputURLs(response["data"])) > 0
			code = 0
		}
		if !validCode {
			return PollOutcome{}, errors.New("RunningHub 查询响应缺少可识别状态")
		}
		if code == 0 {
			urls := runningHubOutputURLs(response["data"])
			if len(urls) == 0 {
				return PollOutcome{}, errors.New("RunningHub 任务成功但没有返回产物")
			}
			for index, rawURL := range urls {
				urls[index] = resolveRunningHubOutputURL(root, rawURL)
			}
			result, err := c.DownloadOutputs(ctx, urls, taskID, &policy)
			if err != nil {
				return PollOutcome{}, err
			}
			c.updateReceipt(ctx, taskID, "succeeded", nil)
			return PollOutcome{Done: true, Result: result}, nil
		}
		if code == 805 || code == 806 {
			return PollOutcome{}, fmt.Errorf("RunningHub 任务失败：%s", runningHubFailureMessage(response))
		}
		stage := "running"
		if code == 813 {
			stage = "queued"
		} else if code != 804 {
			stage = "pending"
		}
		interval := policy.Interval
		if interval <= 0 {
			interval = defaultVideoPollInterval
		}
		next := c.Time.Now().Add(interval)
		c.updateReceipt(ctx, taskID, stage, &next)
		return PollOutcome{}, nil
	})
}

func (c *Client) pollLegacy(ctx context.Context, config Config, root string, taskID string) (map[string]interface{}, error) {
	interval := c.Time.LegacyPollInterval()
	for deadline := c.Time.PollDeadline(ctx); c.Time.Now().Before(deadline); {
		response, err := c.PostJSON(ctx, config, root+"/task/openapi/outputs", "poll", map[string]any{"apiKey": runningHubAPIKey(config), "taskId": taskID})
		if err != nil {
			return nil, fmt.Errorf("RunningHub 查询任务失败：%w", err)
		}
		code, validCode := runningHubPayloadCode(response)
		if !validCode {
			validCode = len(runningHubOutputURLs(response["data"])) > 0
			code = 0
		}
		if !validCode {
			return nil, errors.New("RunningHub 查询响应缺少可识别状态")
		}
		if code == 0 {
			urls := runningHubOutputURLs(response["data"])
			if len(urls) == 0 {
				return nil, errors.New("RunningHub 任务成功但没有返回产物")
			}
			for index, rawURL := range urls {
				urls[index] = resolveRunningHubOutputURL(root, rawURL)
			}
			c.updateReceipt(ctx, taskID, "succeeded", nil)
			return c.DownloadOutputs(ctx, urls, "", nil)
		}
		if code == 805 || code == 806 {
			return nil, fmt.Errorf("RunningHub 任务失败：%s", runningHubFailureMessage(response))
		}
		stage := "running"
		if code == 813 {
			stage = "queued"
		} else if code != 804 {
			stage = "pending"
		}
		next := c.Time.Now().Add(interval)
		c.updateReceipt(ctx, taskID, stage, &next)
		if err := c.Time.Sleep(ctx, interval); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("RunningHub 任务超时（%s）", taskID)
}

// DownloadOutputs fetches and normalizes output URLs. policy != nil uses video download retries.
func (c *Client) DownloadOutputs(ctx context.Context, urls []string, taskID string, policy *PollPolicy) (map[string]interface{}, error) {
	c = c.prepared()
	images := make([]map[string]interface{}, 0)
	var video, audio map[string]interface{}
	for _, rawURL := range urls {
		if strings.HasPrefix(rawURL, "data:") {
			mimeType, data, err := decodeDataURL(rawURL)
			if err != nil {
				return nil, err
			}
			if item := workflowOutputValue(mimeType, data); item != nil {
				switch value := item.(type) {
				case map[string]interface{}:
					if strings.HasPrefix(mimeType, "image/") {
						images = append(images, value)
					} else if strings.HasPrefix(mimeType, "video/") {
						video = value
					} else if strings.HasPrefix(mimeType, "audio/") {
						audio = value
					}
				}
			}
			continue
		}
		if !isPublicMediaURL(rawURL) {
			continue
		}
		var data []byte
		var mimeType string
		var err error
		download := func(ctx context.Context) ([]byte, string, error) {
			return c.execute(ctx, Request{
				Kind:   "download",
				Method: http.MethodGet,
				URL:    rawURL,
			})
		}
		if policy == nil {
			data, mimeType, err = download(ctx)
		} else {
			if c.Poller == nil {
				return nil, errors.New("工作流缺少视频轮询端口")
			}
			data, mimeType, err = c.Poller.Download(ctx, taskID, *policy, download)
		}
		if err != nil {
			return nil, fmt.Errorf("下载 RunningHub 产物失败：%w", err)
		}
		mimeType = runningHubOutputMimeType(rawURL, mimeType)
		item := workflowOutputValue(mimeType, data)
		if item == nil {
			continue
		}
		value := item.(map[string]interface{})
		switch {
		case strings.HasPrefix(mimeType, "image/"):
			images = append(images, value)
		case strings.HasPrefix(mimeType, "video/"):
			video = value
		case strings.HasPrefix(mimeType, "audio/"):
			audio = value
		}
	}
	result := map[string]interface{}{"mode": "image"}
	if len(images) > 0 {
		result["images"] = images
	}
	if video != nil {
		result["mode"] = "video"
		result["video"] = video
	}
	if audio != nil {
		result["mode"] = "audio"
		result["audio"] = audio
	}
	if len(images) == 0 && video == nil && audio == nil {
		return nil, errors.New("RunningHub 返回的产物类型不受支持")
	}
	return result, nil
}

func (c *Client) execute(ctx context.Context, req Request) ([]byte, string, error) {
	if c.Requests == nil {
		return nil, "", errors.New("工作流缺少受保护的请求执行端口")
	}
	return c.Requests.Execute(ctx, req)
}

func (c *Client) updateReceipt(ctx context.Context, requestID, stage string, nextPollAt *time.Time) {
	if c.Receipt == nil {
		return
	}
	_ = c.Receipt.UpdateStage(ctx, requestID, stage, nextPollAt)
}

func defaultVideoPolicy() PollPolicy {
	return PollPolicy{
		InitialDelay:          defaultVideoPollInterval,
		Interval:              defaultVideoPollInterval,
		MaxNotFoundMisses:     3,
		MaxMalformedResponses: 3,
		MaxDownloadTries:      3,
		RetryTransient:        true,
	}
}
