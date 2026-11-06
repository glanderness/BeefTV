package operations_test

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/skills"
)

func TestSkillScriptProposalApprovalAndSessionAlwaysAllow(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "ops-script.sqlite")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{}, &model.SystemSetting{}, &model.AgentOpRecord{}, &model.AssistantTurn{}); err != nil {
		t.Fatal(err)
	}
	rawDB, _ := db.DB()
	t.Cleanup(func() { _ = rawDB.Close() })

	skillSvc := skills.New(repository.New(db), dir, nil)
	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	for name, content := range map[string]string{
		"SKILL.md":       "---\nname: 脚本审批测试\ndescription: 验证脚本确认与本对话始终允许\n---\n运行 scripts/echo.js",
		"scripts/echo.js": "console.log('ECHO:' + process.argv.slice(2).join(','));",
	} {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(f, content)
	}
	_ = zw.Close()

	var formBuf bytes.Buffer
	mw := multipart.NewWriter(&formBuf)
	fw, _ := mw.CreateFormFile("file", "skill.zip")
	_, _ = fw.Write(zipBuf.Bytes())
	_ = mw.Close()
	req := httptest.NewRequest("POST", "/skills/install", &formBuf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	_ = req.ParseMultipartForm(10 << 20)
	defer req.MultipartForm.RemoveAll()

	installed, err := skillSvc.InstallSkillUpload("owner", "zip", req.MultipartForm.File["file"][0], skills.SkillInstallRequest{IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	pin := skills.Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}

	sessionID := "durable:22222222-2222-2222-2222-222222222222"
	// 1. First call requires confirmation
	firstOut, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-1", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		SessionID:  sessionID,
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"hello", "world"},
		Note:       "测试首次确认",
	})
	if err != nil {
		t.Fatal(err)
	}
	firstMap := firstOut.(map[string]any)
	if firstMap["status"] != "requires_confirmation" {
		t.Fatalf("expected status=requires_confirmation, got %+v", firstMap)
	}
	proposal := firstMap["proposal"].(operations.SkillScriptProposal)
	if !strings.HasPrefix(proposal.ProposalID, "sp-") || proposal.Status != "pending" {
		t.Fatalf("unexpected proposal: %+v", proposal)
	}

	// 2. Confirm proposal with alwaysAllowSession=true
	confirmed, result, err := operations.ConfirmSkillScriptProposal(context.Background(), db, skillSvc, "owner", "turn-1", proposal.ProposalID, "canvas-1", true)
	if err != nil {
		t.Fatal(err)
	}
	if confirmed.Status != "completed" || result.ExitCode != 0 || strings.TrimSpace(result.Stdout) != "ECHO:hello,world" {
		t.Fatalf("unexpected confirmation result: proposal=%+v result=%+v", confirmed, result)
	}

	// 3. Subsequent call in the same session for the same script runs inline
	secondOut, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-2", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		SessionID:  sessionID,
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"auto"},
	})
	if err != nil {
		t.Fatal(err)
	}
	secondMap := secondOut.(map[string]any)
	if secondMap["status"] != "completed" {
		t.Fatalf("expected session-allowed script to run immediately, got %+v", secondMap)
	}
	secondRes := secondMap["result"].(*skills.ScriptRunResult)
	if strings.TrimSpace(secondRes.Stdout) != "ECHO:auto" {
		t.Fatalf("unexpected auto-run stdout: %q", secondRes.Stdout)
	}

	// 4. Revoking session allows requires confirmation again
	if err := operations.RevokeSessionScriptAllows(db, "owner", "canvas-1", sessionID); err != nil {
		t.Fatal(err)
	}
	thirdOut, err := operations.ProposeOrRunSkillScript(context.Background(), db, skillSvc, "owner", "turn-3", skills.ScriptRunRequest{
		CanvasID:   "canvas-1",
		SessionID:  sessionID,
		Pin:        pin,
		ScriptPath: "scripts/echo.js",
		Args:       []string{"after-revoke"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if thirdOut.(map[string]any)["status"] != "requires_confirmation" {
		t.Fatalf("expected requires_confirmation after RevokeSessionScriptAllows, got %+v", thirdOut)
	}
}
