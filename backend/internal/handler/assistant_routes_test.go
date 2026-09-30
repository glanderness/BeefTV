package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// 内置助手对外只有这一条链路：页面 → 同源后端 → 宿主。
// 这里用真实的路由、真实的 SQLite 画布与一个替身宿主验证契约，
// 特别是「轮前快照由后端建立、撤销写回新版本」这条只能在后端成立的前提。

type assistantTestEnv struct {
	router   *gin.Engine
	service  *app.Service
	uiToken  string
	canvasID string
	hostHits map[string]int
}

func newAssistantTestEnv(t *testing.T, host func(env *assistantTestEnv) http.Handler) *assistantTestEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "assistant.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "local", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	service := app.NewLocal(repository.New(db), dataDir)
	owner, err := service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	canvasID := "assistant-canvas"
	doc := map[string]any{"id": canvasID, "title": "助手回归", "revision": 0,
		"nodes":       []any{map[string]any{"id": "n1", "type": "text", "title": "起点", "position": map[string]any{"x": 0, "y": 0}}},
		"connections": []any{}}
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpsertUserCanvasProject(owner.ID, encoded); err != nil {
		t.Fatal(err)
	}
	env := &assistantTestEnv{service: service, canvasID: canvasID, hostHits: map[string]int{}}
	if host != nil {
		server := httptest.NewServer(host(env))
		t.Cleanup(server.Close)
		t.Setenv("BEEFTV_AGENT_HOST_URL", server.URL)
	} else {
		t.Setenv("BEEFTV_AGENT_HOST_URL", "http://127.0.0.1:1")
	}
	t.Setenv("BEEFTV_AGENT_HOST_TOKEN", "test-host-token")

	ui := newUISessionStore()
	env.uiToken = ui.issue(owner.ID).Token
	router := gin.New()
	api := router.Group("/api")
	RegisterAgentProxyRoutes(api, service, agentops.NewClientRegistry(dataDir), ui)
	env.router = router
	return env
}

// 显式注入的供应商：让状态解析不依赖真实渠道配置，测试只验证路由与契约。
func useEnvProvider(t *testing.T, protocol string) {
	t.Helper()
	t.Setenv("BEEFTV_AGENT_API_KEY", "test-key")
	t.Setenv("BEEFTV_AGENT_BASE_URL", "https://relay.example.com/v1")
	t.Setenv("BEEFTV_AGENT_MODEL", "MiniMax-M3")
	t.Setenv("BEEFTV_AGENT_PROTOCOL", protocol)
}

func (e *assistantTestEnv) call(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, "http://127.0.0.1:18090/api"+path, reader)
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Beeftv-Ui-Session", e.uiToken)
	recorder := httptest.NewRecorder()
	e.router.ServeHTTP(recorder, request)
	return recorder
}

func decodeEnvelope(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var envelope struct {
		Code   int            `json:"code"`
		Reason string         `json:"reason"`
		Data   map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("响应不是信封 JSON: %s", recorder.Body.String())
	}
	if envelope.Data == nil {
		envelope.Data = map[string]any{}
	}
	envelope.Data["__code"] = float64(envelope.Code)
	envelope.Data["__reason"] = envelope.Reason
	return envelope.Data
}

// 状态在模型/凭据/宿主任一环节缺失时都要给出机器可读原因，而不是一句「不可用」。
func TestAssistantStatusReportsResolvedModelAndReasons(t *testing.T) {
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"busy":false,"model":"MiniMax-M3"}`))
		})
	})

	useEnvProvider(t, "chat-completion")
	data := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/status", ""))
	if available, _ := data["available"].(bool); !available {
		t.Fatalf("宿主健康时状态应可用: %#v", data)
	}
	modelInfo, _ := data["model"].(map[string]any)
	if modelInfo["id"] != "MiniMax-M3" {
		t.Fatalf("状态应带上解析出的模型: %#v", data["model"])
	}

	// 模型/凭据没解析出来时，宿主是否健康都不影响结论。
	for _, key := range []string{"BEEFTV_AGENT_API_KEY", "BEEFTV_AGENT_BASE_URL", "BEEFTV_AGENT_MODEL", "BEEFTV_AGENT_PROTOCOL"} {
		t.Setenv(key, "")
	}
	data = decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/status", ""))
	if available, _ := data["available"].(bool); available {
		t.Fatal("未配置模型时状态不应可用")
	}
	if data["reason"] != app.AssistantReasonModelNotConfigured {
		t.Fatalf("reason 应为 %s，得到 %v", app.AssistantReasonModelNotConfigured, data["reason"])
	}
}

// 宿主不可达且本机没有配置启动命令时，状态必须落到 host_unreachable，而不是假装可用。
func TestAssistantStatusReportsUnreachableHost(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	useEnvProvider(t, "chat-completion")

	data := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/status", ""))
	if available, _ := data["available"].(bool); available {
		t.Fatal("宿主不可达时不应可用")
	}
	if data["reason"] != "host_unreachable" && data["reason"] != "host_start_failed" {
		t.Fatalf("reason 应指向宿主问题，得到 %v", data["reason"])
	}
}

// 对话流：后端生成 turnId 与轮前版本交给宿主，并从 turn_end 记住这轮的变更；
// 之后按轮撤销把轮前文档写成新版本。
func TestAssistantChatRecordsTurnChangeAndUndoRestoresDocument(t *testing.T) {
	var captured struct {
		TurnID         string `json:"turnId"`
		RevisionBefore int64  `json:"revisionBefore"`
		SessionID      string `json:"sessionId"`
	}
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			if r.URL.Path == "/health" {
				_, _ = w.Write([]byte(`{"ok":true,"busy":false}`))
				return
			}
			if r.URL.Path != "/chat" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			// 替身宿主用与内置会话相同的入口写画布，让 turn_end 里的版本是真的。
			owner, _ := env.service.LocalWorkspaceOwner()
			raw, _ := env.service.UserCanvasProject(owner.ID, env.canvasID)
			var doc map[string]any
			_ = json.Unmarshal(raw, &doc)
			nodes, _ := doc["nodes"].([]any)
			doc["nodes"] = append(nodes, map[string]any{"id": "n2", "type": "text", "title": "助手节点",
				"position": map[string]any{"x": 10, "y": 10}})
			encoded, _ := json.Marshal(doc)
			summary, err := env.service.UpsertUserCanvasProject(owner.ID, encoded)
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/x-ndjson")
			_, _ = w.Write([]byte(`{"type":"text_delta","delta":"好"}` + "\n"))
			line, _ := json.Marshal(map[string]any{"type": "turn_end", "turnId": captured.TurnID, "reply": "好",
				"toolCalls": []any{}, "proposals": []any{},
				"change": map[string]any{"revisionBefore": captured.RevisionBefore, "revisionAfter": summary.Revision,
					"createdNodeIds": []string{"n2"}, "updatedNodeIds": []string{}, "createdEdgeIds": []string{}}})
			_, _ = w.Write(append(line, '\n'))
		})
	})
	useEnvProvider(t, "chat-completion")

	recorder := env.call(t, http.MethodPost, "/assistant/chat",
		`{"canvasId":"`+env.canvasID+`","message":"加一个节点","selectedNodeIds":["n1"]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("对话应成功: %d %s", recorder.Code, recorder.Body.String())
	}
	if captured.TurnID == "" {
		t.Fatal("后端必须生成 turnId 交给宿主")
	}
	if captured.RevisionBefore == 0 {
		t.Fatal("后端必须把轮前版本交给宿主")
	}
	if !strings.Contains(recorder.Body.String(), `"turn_end"`) {
		t.Fatalf("流式响应应原样包含 turn_end: %s", recorder.Body.String())
	}

	owner, _ := env.service.LocalWorkspaceOwner()
	before := canvasNodeIDs(t, env.service, owner.ID, env.canvasID)
	if len(before) != 2 {
		t.Fatalf("这轮应写入了一个节点，得到 %v", before)
	}

	undo := decodeEnvelope(t, env.call(t, http.MethodPost, "/assistant/turns/"+captured.TurnID+"/undo",
		`{"canvasId":"`+env.canvasID+`"}`))
	revision, _ := undo["revision"].(float64)
	if int64(revision) <= captured.RevisionBefore {
		t.Fatalf("撤销必须产生新版本，得到 %v", undo)
	}
	if after := canvasNodeIDs(t, env.service, owner.ID, env.canvasID); len(after) != 1 || after[0] != "n1" {
		t.Fatalf("撤销后应回到轮前节点集合，得到 %v", after)
	}

	// 已撤销的轮次不能再撤一次。
	recorder = env.call(t, http.MethodPost, "/assistant/turns/"+captured.TurnID+"/undo", `{"canvasId":"`+env.canvasID+`"}`)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("重复撤销应是 409，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	if reason := decodeEnvelope(t, recorder)["__reason"]; reason != app.AssistantTurnReasonAlreadyUndone {
		t.Fatalf("reason 应为 %s，得到 %v", app.AssistantTurnReasonAlreadyUndone, reason)
	}
}

// 未知轮次与不属于当前工作区的画布都必须被拒绝：撤销是写路径，不接受空 scope。
func TestAssistantUndoRejectsUnknownTurnAndForeignCanvas(t *testing.T) {
	env := newAssistantTestEnv(t, nil)

	recorder := env.call(t, http.MethodPost, "/assistant/turns/00112233445566/undo", `{"canvasId":"`+env.canvasID+`"}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("未知轮次应是 404，得到 %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = env.call(t, http.MethodPost, "/assistant/turns/00112233445566/undo", `{"canvasId":"not-mine"}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("外部画布应是 404，得到 %d", recorder.Code)
	}
}

// 会话与历史只是宿主状态的透传，但 scope 校验与信封解包必须在后端完成。
func TestAssistantSessionsAndHistoryAreProxiedWithScopeCheck(t *testing.T) {
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			env.hostHits[r.URL.Path]++
			w.Header().Set("Content-Type", "application/json")
			switch {
			case r.URL.Path == "/sessions" && r.Method == http.MethodGet:
				if r.URL.Query().Get("canvasId") != env.canvasID {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				_, _ = w.Write([]byte(`{"currentSessionId":"s1","sessions":[{"sessionId":"s1","title":"加一个节点","updatedAt":"2026-01-01T00:00:00Z","turnCount":1}]}`))
			case r.URL.Path == "/sessions" && r.Method == http.MethodPost:
				_, _ = w.Write([]byte(`{"sessionId":"s2"}`))
			case r.URL.Path == "/history":
				_, _ = w.Write([]byte(`{"sessionId":"s1","turns":[{"turnId":"t1","userText":"加一个节点","selectedNodeIds":["n1"],"reply":"好","toolCalls":[],"change":null,"proposals":[],"error":null,"cancelled":false,"createdAt":"2026-01-01T00:00:00Z"}]}`))
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})
	})

	data := decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/sessions?canvasId="+url.QueryEscape(env.canvasID), ""))
	if data["currentSessionId"] != "s1" {
		t.Fatalf("会话列表应被解包成契约形状: %#v", data)
	}
	if list, _ := data["sessions"].([]any); len(list) != 1 {
		t.Fatalf("会话条目异常: %#v", data["sessions"])
	}

	data = decodeEnvelope(t, env.call(t, http.MethodPost, "/assistant/sessions", `{"canvasId":"`+env.canvasID+`"}`))
	if data["sessionId"] != "s2" {
		t.Fatalf("新建会话应回 sessionId: %#v", data)
	}

	data = decodeEnvelope(t, env.call(t, http.MethodGet, "/assistant/history?canvasId="+url.QueryEscape(env.canvasID), ""))
	turns, _ := data["turns"].([]any)
	if len(turns) != 1 {
		t.Fatalf("历史条目异常: %#v", data)
	}
	turn, _ := turns[0].(map[string]any)
	if turn["userText"] != "加一个节点" {
		t.Fatalf("历史必须是用户原文，得到 %v", turn["userText"])
	}

	// 不属于当前工作区的画布不能借会话/历史入口探测宿主。
	if recorder := env.call(t, http.MethodGet, "/assistant/sessions?canvasId=not-mine", ""); recorder.Code != http.StatusNotFound {
		t.Fatalf("外部画布应是 404，得到 %d", recorder.Code)
	}
	if env.hostHits["/sessions"] != 2 {
		t.Fatalf("scope 未通过时不应转发给宿主，命中 %d 次", env.hostHits["/sessions"])
	}
}

func canvasNodeIDs(t *testing.T, service *app.Service, userID, canvasID string) []string {
	t.Helper()
	raw, err := service.UserCanvasProject(userID, canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(doc.Nodes))
	for _, node := range doc.Nodes {
		out = append(out, node.ID)
	}
	return out
}
