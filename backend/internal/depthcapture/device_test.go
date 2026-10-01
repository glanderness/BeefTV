package depthcapture

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestWindowsWorkerUsesUTF8ForChineseProgress(t *testing.T) {
	env := WorkerEnvForPlatform("C:/depth/worker", "windows")
	if !strings.Contains(strings.Join(env, "\n"), "PYTHONIOENCODING=utf-8") {
		t.Fatal("Windows worker does not force UTF-8 for its progress output")
	}
}

func TestChooseDeviceKeepsMacMPSAndSkipsWindowsCUDAWithoutCandidate(t *testing.T) {
	probed := false
	mac, err := ChooseDevice(context.Background(), "darwin", "arm64", false, func(context.Context) error { probed = true; return nil })
	if err != nil || mac.Variant != "mps" || mac.Device != "mps" || probed {
		t.Fatalf("Mac choice=%+v err=%v probed=%v", mac, err, probed)
	}
	windows, err := ChooseDevice(context.Background(), "windows", "amd64", false, func(context.Context) error { probed = true; return nil })
	if err != nil || windows.Variant != "cpu" || windows.Device != "cpu" || probed {
		t.Fatalf("Windows choice=%+v err=%v probed=%v", windows, err, probed)
	}
}

func TestChooseDeviceRequiresRealCUDAProbe(t *testing.T) {
	called := 0
	choice, err := ChooseDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { called++; return nil })
	if err != nil || choice.Device != "cuda" || called != 1 {
		t.Fatalf("choice=%+v err=%v called=%d", choice, err, called)
	}
	choice, err = ChooseDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { return ErrCUDADevice })
	if err != nil || choice.Device != "cpu" || choice.FallbackReason == "" {
		t.Fatalf("choice=%+v err=%v", choice, err)
	}
	_, err = ChooseDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { return errors.New("checksum mismatch") })
	if err == nil {
		t.Fatal("non-device CUDA preparation error was hidden by CPU fallback")
	}
}

func TestCPUFallbackOnlyForOneUncancelledCUDADeviceFailure(t *testing.T) {
	if !ShouldRetryOnCPU(ErrCUDADevice, nil, 0) {
		t.Fatal("device failure should allow one retry")
	}
	if ShouldRetryOnCPU(ErrCUDADevice, nil, 1) {
		t.Fatal("second retry allowed")
	}
	if ShouldRetryOnCPU(ErrCUDADevice, context.Canceled, 0) {
		t.Fatal("canceled task retried")
	}
	if ShouldRetryOnCPU(errors.New("bad input"), nil, 0) {
		t.Fatal("non-device error retried")
	}
}

func TestWorkerExitCodeIsStableFallbackSignal(t *testing.T) {
	if !errors.Is(ClassifyWorkerExit(42, "CUDA error"), ErrCUDADevice) {
		t.Fatal("CUDA exit code did not classify as a device failure")
	}
	if errors.Is(ClassifyWorkerExit(1, "CUDA error text in a non-device failure"), ErrCUDADevice) {
		t.Fatal("free-form stderr triggered a device fallback")
	}
}

func TestSupportedPlatform(t *testing.T) {
	if !Supported("darwin", "arm64") || !Supported("windows", "amd64") {
		t.Fatal("supported platforms rejected")
	}
	if Supported("linux", "amd64") || Supported("darwin", "amd64") {
		t.Fatal("unsupported platform accepted")
	}
}
