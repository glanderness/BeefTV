package operations

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

// projectProbe 记录 handler 转发给领域的参数，并返回可预测的结果。
type projectProbe struct {
	unusedDomain
	owned     *model.Project
	ownedErr  error
	created   ProjectCreateInput
	updated   ProjectUpdateInput
	updatedID string
	deleted   []string
	listPage  int
	listSize  int
	detailID  string
}

func (p *projectProbe) ListProjectsPage(_ string, page int, pageSize int) (ProjectListPage, error) {
	p.listPage, p.listSize = page, pageSize
	return ProjectListPage{Page: page, PageSize: pageSize, Total: 1, HasMore: false,
		Projects: []ProjectSummary{{Project: model.Project{ID: "p1", Name: "海边剧"}, CanvasCount: 2}}}, nil
}

func (p *projectProbe) ProjectDetail(_ string, projectID string) (ProjectDetail, error) {
	p.detailID = projectID
	return ProjectDetail{Project: model.Project{ID: projectID, Name: "海边剧"}}, nil
}

func (p *projectProbe) CreateProject(_ string, input ProjectCreateInput) (model.Project, error) {
	p.created = input
	return model.Project{ID: "p-new", Name: input.Name, Type: "short-drama"}, nil
}

func (p *projectProbe) UpdateProject(_ string, projectID string, input ProjectUpdateInput) (model.Project, error) {
	p.updatedID = projectID
	p.updated = input
	return model.Project{ID: projectID, Name: input.Name, Revision: 2}, nil
}

func (p *projectProbe) DeleteProject(_ string, projectID string) error {
	p.deleted = append(p.deleted, projectID)
	return nil
}

func (p *projectProbe) OwnedProject(_ string, _ string) (*model.Project, error) {
	if p.ownedErr != nil {
		return nil, p.ownedErr
	}
	return p.owned, nil
}

func TestOpProjectListNormalizesPaging(t *testing.T) {
	probe := &projectProbe{}
	result, err := opProjectList(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if probe.listPage != 1 || probe.listSize != 20 {
		t.Fatalf("缺省分页 = %d/%d", probe.listPage, probe.listSize)
	}
	page := result.(ProjectListPage)
	if len(page.Projects) != 1 || page.Projects[0].CanvasCount != 2 {
		t.Fatalf("page = %#v", page)
	}
	if _, err := opProjectList(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"page":0,"pageSize":500}`)); err != nil {
		t.Fatal(err)
	}
	if probe.listSize != 100 {
		t.Fatalf("pageSize 上限 = %d", probe.listSize)
	}
}

func TestOpProjectGetRequiresProjectID(t *testing.T) {
	probe := &projectProbe{}
	if _, err := opProjectGet(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"projectId":"  "}`)); err == nil {
		t.Fatal("空 projectId 应被拒绝")
	}
	result, err := opProjectGet(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"projectId":"p1"}`))
	if err != nil {
		t.Fatal(err)
	}
	if probe.detailID != "p1" {
		t.Fatalf("detailID = %s", probe.detailID)
	}
	detail := result.(ProjectDetail)
	if detail.Project.ID != "p1" {
		t.Fatalf("detail = %#v", detail)
	}
}

func TestOpProjectCreateValidatesName(t *testing.T) {
	probe := &projectProbe{}
	if _, err := opProjectCreate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"name":"  "}`)); err == nil {
		t.Fatal("空名称应被拒绝")
	}
	if strings.TrimSpace(string([]rune("名"))) == "" {
		t.Fatal("unreachable")
	}
	if _, err := opProjectCreate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"name":"`+strings.Repeat("长", 241)+`"}`)); err == nil {
		t.Fatal("超长名称应被拒绝")
	}
	result, err := opProjectCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"name":"海边剧","aspectRatio":"16:9","description":"夏日短剧"}`))
	if err != nil {
		t.Fatal(err)
	}
	if probe.created.Name != "海边剧" || probe.created.AspectRatio != "16:9" || probe.created.Description != "夏日短剧" {
		t.Fatalf("created 转发 = %#v", probe.created)
	}
	payload := result.(map[string]any)
	created, ok := payload["created"].(model.Project)
	if !ok || created.ID != "p-new" {
		t.Fatalf("回执 = %#v", payload["created"])
	}
}

// 白名单外字段（如 styleProfileJson）必须被 unknown_field 拒绝。
func TestOpProjectCreateRejectsUnknownField(t *testing.T) {
	probe := &projectProbe{}
	_, err := opProjectCreate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"name":"x","styleProfileJson":"{}"}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "unknown_field" {
		t.Fatalf("应拒绝白名单外字段，实际 %v", err)
	}
}

func TestOpProjectUpdateRequiresFreshRevision(t *testing.T) {
	probe := &projectProbe{owned: &model.Project{ID: "p1", Name: "海边剧", Revision: 3}}
	// 缺 expectedRevision。
	if _, err := opProjectUpdate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"projectId":"p1","name":"新名"}`)); err == nil {
		t.Fatal("缺 expectedRevision 应被拒绝")
	}
	// revision 不匹配必须得到冲突回执，不进领域。
	_, err := opProjectUpdate(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"projectId":"p1","expectedRevision":2,"name":"新名"}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "stale_revision" {
		t.Fatalf("过期 revision 应返回冲突，实际 %v", err)
	}
	if probe.updatedID != "" {
		t.Fatal("冲突时不应进领域")
	}
	// revision 匹配：指针字段语义转发。
	result, err := opProjectUpdate(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"projectId":"p1","expectedRevision":3,"name":"新名","description":"新描述"}`))
	if err != nil {
		t.Fatal(err)
	}
	if probe.updated.Name != "新名" || probe.updated.Description == nil || *probe.updated.Description != "新描述" {
		t.Fatalf("update 转发 = %#v", probe.updated)
	}
	if probe.updated.Type != "" {
		t.Fatalf("未给出的字段应为零值: %#v", probe.updated)
	}
	payload := result.(map[string]any)
	if updated, ok := payload["updated"].(model.Project); !ok || updated.Revision != 2 {
		t.Fatalf("回执 = %#v", payload["updated"])
	}
}

// 删除必须带项目当前名称；名称不匹配整批拒绝，不进领域。
func TestOpProjectDeleteRequiresNameConfirmation(t *testing.T) {
	probe := &projectProbe{owned: &model.Project{ID: "p1", Name: "海边剧", Revision: 1}}
	if _, err := opProjectDelete(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"projectId":"p1"}`)); err == nil {
		t.Fatal("缺 expectedName 应被拒绝")
	}
	_, err := opProjectDelete(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"projectId":"p1","expectedName":"别的剧"}`))
	opErr, ok := err.(*Error)
	if !ok || opErr.Reason != "name_mismatch" {
		t.Fatalf("名称不匹配应拒绝删除，实际 %v", err)
	}
	if len(probe.deleted) != 0 {
		t.Fatal("名称不匹配时不应进领域")
	}
	if _, err := opProjectDelete(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"projectId":"p1","expectedName":"海边剧"}`)); err != nil {
		t.Fatal(err)
	}
	if len(probe.deleted) != 1 || probe.deleted[0] != "p1" {
		t.Fatalf("deleted = %#v", probe.deleted)
	}
}
