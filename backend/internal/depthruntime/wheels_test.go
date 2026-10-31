package depthruntime

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testWheels() []Wheel {
	return []Wheel{
		{Name: "torch-2.8.0+cu128-cp311-cp311-win_amd64.whl", URLs: []string{"https://mirror.example/torch-2.8.0%2Bcu128-cp311-cp311-win_amd64.whl"}, Size: 100, SHA256: strings.Repeat("a", 64), Files: 1, ExpandedSize: 1000},
		{Name: "torchvision-0.23.0+cu128-cp311-cp311-win_amd64.whl", URLs: []string{"https://mirror.example/torchvision-0.23.0%2Bcu128-cp311-cp311-win_amd64.whl"}, Size: 20, SHA256: strings.Repeat("b", 64), Files: 1, ExpandedSize: 200},
	}
}

func TestSignedV3WheelsAndLegacyManifestsHaveSeparateContracts(t *testing.T) {
	wheels := testWheels()
	manifest := Manifest{Version: 3, Runtimes: map[string]Artifact{"windows-amd64/cuda": {Wheels: wheels}}}
	envelope, public := signedTestManifest(t, manifest)
	if _, err := VerifyManifest(envelope, public); err != nil {
		t.Fatal(err)
	}
	for _, platform := range []string{"windows-amd64/cpu", "darwin-arm64"} {
		if err := validateWheels(3, platform, wheels); err == nil {
			t.Fatalf("accepted split wheels on %s", platform)
		}
	}
	manifest.Version = 2
	envelope, public = signedTestManifest(t, manifest)
	if _, err := VerifyManifest(envelope, public); err == nil {
		t.Fatal("legacy signed channel accepted a new installation protocol")
	}
	for name, change := range map[string]func([]Wheel){
		"traversal":         func(w []Wheel) { w[0].Name = "../" + w[0].Name },
		"duplicate":         func(w []Wheel) { w[1] = w[0] },
		"wrong ABI":         func(w []Wheel) { w[0].Name = strings.ReplaceAll(w[0].Name, "cp311", "cp312") },
		"bad hash":          func(w []Wheel) { w[0].SHA256 = strings.Repeat("z", 64) },
		"empty hash":        func(w []Wheel) { w[0].SHA256 = "" },
		"bad URL":           func(w []Wheel) { w[0].URLs = []string{"file:///tmp/torch.whl"} },
		"credentials":       func(w []Wheel) { w[0].URLs = []string{"https://secret@example.com/" + w[0].Name} },
		"different file":    func(w []Wheel) { w[0].URLs = []string{"https://example.com/not-the-wheel.whl"} },
		"unknown expansion": func(w []Wheel) { w[0].ExpandedSize = 0 },
		"overflow":          func(w []Wheel) { w[0].ExpandedSize = 1<<63 - 1 },
	} {
		t.Run(name, func(t *testing.T) {
			wheels := testWheels()
			change(wheels)
			if err := validateWheels(3, "windows-amd64/cuda", wheels); err == nil {
				t.Fatal("invalid signed dependency accepted")
			}
		})
	}
}

func cacheTestWheel(t *testing.T, root string, wheel Wheel, entry string) Wheel {
	t.Helper()
	path := wheelPath(root, wheel)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	z := zip.NewWriter(f)
	w, _ := z.Create(entry)
	_, _ = w.Write([]byte("dependency"))
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(path)
	hash := sha256.Sum256(body)
	wheel.Size, wheel.SHA256, wheel.Files, wheel.ExpandedSize = int64(len(body)), hex.EncodeToString(hash[:]), 1, int64(len("dependency"))
	return wheel
}

func TestWheelPlanIncludesAllDownloadAndPipTemporarySpace(t *testing.T) {
	root := t.TempDir()
	wheels := testWheels()
	artifact := Artifact{Size: 10, ExpandedSize: 100, Wheels: wheels}
	model := Artifact{Size: 2}
	plan, err := installationPlan(context.Background(), root, artifact, model, false, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.DownloadBytes != 132 || plan.RequiredBytes != (256<<20)+2632 {
		t.Fatalf("plan omits base, wheels, model or temporary install: %+v", plan)
	}
	cached := cacheTestWheel(t, root, wheels[0], "torch/__init__.py")
	artifact.Wheels[0] = cached
	plan, err = installationPlan(context.Background(), root, artifact, model, true, true, false)
	if err != nil || plan.DownloadBytes != 20 || plan.RequiredBytes != (256<<20)+100+20+2*(cached.ExpandedSize+200) {
		t.Fatalf("verified wheel cache was not reused: %+v %v", plan, err)
	}
	plan, err = installationPlan(context.Background(), root, artifact, model, true, true, true)
	if err != nil || plan.DownloadBytes != 0 || plan.RequiredBytes != 256<<20 {
		t.Fatalf("complete old runtime should not redownload wheels: %+v %v", plan, err)
	}
}

func TestAllWheelsAreFullyVerifiedBeforePythonCanStart(t *testing.T) {
	root, stage := t.TempDir(), t.TempDir()
	wheels := testWheels()
	for i := range wheels {
		wheels[i] = cacheTestWheel(t, root, wheels[i], "package/__init__.py")
	}
	called := 0
	run := func(ctx context.Context, python, stage string, args []string) error {
		called++
		return nil
	}
	path := wheelPath(root, wheels[1])
	data, _ := os.ReadFile(path)
	data[len(data)/2] ^= 1
	_ = os.WriteFile(path, data, 0600)
	if err := installWheels(context.Background(), root, stage, wheels, run); err == nil || called != 0 {
		t.Fatalf("corrupt wheel reached Python: calls=%d err=%v", called, err)
	}
	wheels[1] = cacheTestWheel(t, root, wheels[1], "../escape.py")
	if err := installWheels(context.Background(), root, stage, wheels, run); err == nil || called != 0 {
		t.Fatalf("unsafe wheel reached Python: calls=%d err=%v", called, err)
	}
}

func TestWheelInstallUsesOnlyVerifiedOfflineFilesAndChecksImports(t *testing.T) {
	root, stage := t.TempDir(), t.TempDir()
	wheels := testWheels()
	for i := range wheels {
		wheels[i] = cacheTestWheel(t, root, wheels[i], "package/__init__.py")
	}
	var calls [][]string
	err := installWheels(context.Background(), root, stage, wheels, func(ctx context.Context, python, gotStage string, args []string) error {
		if python != filepath.Join(stage, ".python", "python.exe") || stage != gotStage {
			t.Fatal("installer escaped its staging interpreter")
		}
		calls = append(calls, args)
		return nil
	})
	if err != nil || len(calls) != 2 {
		t.Fatalf("missing offline install or DLL import check: %v %v", calls, err)
	}
	for _, args := range calls {
		if strings.Join(args[:3], " ") != "-I -X utf8" {
			t.Fatal("isolated Python must enable UTF-8 with command flags")
		}
	}
	install := strings.Join(calls[0], " ")
	for _, required := range []string{"--isolated", "--no-index", "--no-deps", "--no-cache-dir", "--no-compile", "--only-binary=:all:", wheelPath(root, wheels[0]), wheelPath(root, wheels[1])} {
		if !strings.Contains(install, required) {
			t.Errorf("install lacks %q", required)
		}
	}
	if strings.Join(calls[1][len(calls[1])-2:], ",") != "2.8.0+cu128,0.23.0+cu128" {
		t.Fatalf("self-check does not bind paired versions: %v", calls[1])
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	err = installWheels(ctx, root, stage, wheels, func(context.Context, string, string, []string) error { called = true; return nil })
	if !errors.Is(err, context.Canceled) || called {
		t.Fatalf("cancelled install ran Python: %v", err)
	}
}
