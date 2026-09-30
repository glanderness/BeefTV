package app

import (
	"context"
	"errors"
	"fmt"
)

var errDepthCUDADevice = errors.New("CUDA 设备或模型前向不可用")

type depthDeviceChoice struct {
	Variant        string
	Device         string
	FallbackReason string
}

// tryCUDA performs the real model-forward probe, not just a driver-name check.
// Download, checksum and other non-device errors are returned to the caller.
func chooseDepthDevice(ctx context.Context, goos, goarch string, cudaCandidate bool, tryCUDA func(context.Context) error) (depthDeviceChoice, error) {
	if goos == "darwin" && goarch == "arm64" {
		return depthDeviceChoice{Variant: "mps", Device: "mps"}, nil
	}
	if goos != "windows" || goarch != "amd64" {
		return depthDeviceChoice{}, fmt.Errorf("深度处理暂不支持 %s/%s", goos, goarch)
	}
	if err := ctx.Err(); err != nil {
		return depthDeviceChoice{}, err
	}
	if !cudaCandidate {
		return depthDeviceChoice{Variant: "cpu", Device: "cpu", FallbackReason: "未检测到可用的 NVIDIA CUDA 设备"}, nil
	}
	if tryCUDA == nil {
		return depthDeviceChoice{}, errors.New("缺少 CUDA 真实模型探针")
	}
	if err := tryCUDA(ctx); err != nil {
		if ctx.Err() != nil {
			return depthDeviceChoice{}, ctx.Err()
		}
		if errors.Is(err, errDepthCUDADevice) {
			return depthDeviceChoice{Variant: "cpu", Device: "cpu", FallbackReason: err.Error()}, nil
		}
		return depthDeviceChoice{}, err
	}
	return depthDeviceChoice{Variant: "cuda", Device: "cuda"}, nil
}

func shouldRetryDepthOnCPU(err, contextErr error, priorRetries int) bool {
	return contextErr == nil && priorRetries == 0 && errors.Is(err, errDepthCUDADevice)
}

func classifyDepthWorkerExit(exitCode int, message string) error {
	if exitCode == 42 {
		return fmt.Errorf("%w: %s", errDepthCUDADevice, message)
	}
	return errors.New(message)
}
