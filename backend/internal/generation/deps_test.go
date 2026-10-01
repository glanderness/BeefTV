package generation

import (
	"os/exec"
	"strings"
	"testing"
)

func TestGenerationDomainDoesNotImportApp(t *testing.T) {
	command := exec.Command("go", "list", "-deps", ".")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list generation dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "infinite-canvas/backend/internal/app" {
			t.Fatal("generation domain still depends on internal/app")
		}
	}
}
