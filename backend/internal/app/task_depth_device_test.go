package app

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestWindowsDepthWorkerUsesUTF8ForChineseProgress(t *testing.T) {
	env := depthWorkerEnvForPlatform("C:/depth/worker", "windows")
	if !strings.Contains(strings.Join(env, "\n"), "PYTHONIOENCODING=utf-8") {
		t.Fatal("Windows worker does not force UTF-8 for its progress output")
	}
}

func TestChooseDepthDeviceKeepsMacMPSAndSkipsWindowsCUDAWithoutCandidate(t *testing.T) {
	probed := false
	mac, err := chooseDepthDevice(context.Background(), "darwin", "arm64", false, func(context.Context) error { probed = true; return nil })
	if err != nil || mac.Variant != "mps" || mac.Device != "mps" || probed {
		t.Fatalf("Mac choice=%+v err=%v probed=%v", mac, err, probed)
	}
	windows, err := chooseDepthDevice(context.Background(), "windows", "amd64", false, func(context.Context) error { probed = true; return nil })
	if err != nil || windows.Variant != "cpu" || windows.Device != "cpu" || probed {
		t.Fatalf("Windows choice=%+v err=%v probed=%v", windows, err, probed)
	}
}

func TestChooseDepthDeviceRequiresRealCUDAProbe(t *testing.T) {
	called := 0
	choice, err := chooseDepthDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { called++; return nil })
	if err != nil || choice.Device != "cuda" || called != 1 {
		t.Fatalf("choice=%+v err=%v called=%d", choice, err, called)
	}
	choice, err = chooseDepthDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { return errDepthCUDADevice })
	if err != nil || choice.Device != "cpu" || choice.FallbackReason == "" {
		t.Fatalf("choice=%+v err=%v", choice, err)
	}
	_, err = chooseDepthDevice(context.Background(), "windows", "amd64", true, func(context.Context) error { return errors.New("checksum mismatch") })
	if err == nil {
		t.Fatal("non-device CUDA preparation error was hidden by CPU fallback")
	}
}

func TestDepthCPUFallbackOnlyForOneUncancelledCUDADeviceFailure(t *testing.T) {
	if !shouldRetryDepthOnCPU(errDepthCUDADevice, nil, 0) {
		t.Fatal("device failure should allow one retry")
	}
	if shouldRetryDepthOnCPU(errDepthCUDADevice, nil, 1) {
		t.Fatal("second retry allowed")
	}
	if shouldRetryDepthOnCPU(errDepthCUDADevice, context.Canceled, 0) {
		t.Fatal("canceled task retried")
	}
	if shouldRetryDepthOnCPU(errors.New("bad input"), nil, 0) {
		t.Fatal("non-device error retried")
	}
}

func TestDepthWorkerExitCodeIsStableFallbackSignal(t *testing.T) {
	if !errors.Is(classifyDepthWorkerExit(42, "CUDA error"), errDepthCUDADevice) {
		t.Fatal("CUDA exit code did not classify as a device failure")
	}
	if errors.Is(classifyDepthWorkerExit(1, "CUDA error text in a non-device failure"), errDepthCUDADevice) {
		t.Fatal("free-form stderr triggered a device fallback")
	}
}
