package bootstrap

import (
	"os/exec"
	"strings"
	"testing"
)

func TestDesktopDependencyGraphDoesNotContainServiceAliasPackage(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./cmd/desktop")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list desktop dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/service" {
			t.Fatal("desktop dependency graph still contains the service alias package")
		}
	}
}

func TestTaskDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/task")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list task dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("task domain still depends on the application service kernel")
		}
	}
}

func TestProjectDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/project")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list project dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("project domain still depends on the application service kernel")
		}
	}
}

func TestLocalAppDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/localapp")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list localapp dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("local composition root still depends on the application service kernel")
		}
	}
}
