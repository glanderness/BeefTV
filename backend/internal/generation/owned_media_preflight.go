package generation

import (
	"context"
	"fmt"
	"image"
	"io"
	"os"
	"strings"
)

// ownedLocalFile matches the *os.File returned by local ResourcePort.Open
// implementations (pinned by contract test in internal/app) so media preflight
// can stat and probe directly on disk without reading 30–200 MiB into RAM.
type ownedLocalFile interface {
	Name() string
	Stat() (os.FileInfo, error)
}

func resourceNotReadyError() error {
	return PreparationUserError{
		Category: CategoryInputInaccessible,
		Reason:   "任务参考资源尚未上传完成",
		Action:   "请等待素材导入完成后重试",
	}
}

func missingMediaMetadataPortError() error {
	return PreparationUserError{
		Category: CategoryInputInaccessible,
		Reason:   "参考素材缺少时长或尺寸，媒体检查服务不可用",
		Action:   "请重新导入素材后重试",
	}
}

func probeImageHeader(r io.Reader) (width, height int, mime string, err error) {
	cfg, format, err := image.DecodeConfig(io.LimitReader(r, videoReferenceHeaderDecodeLimit))
	if err != nil {
		return 0, 0, "", err
	}
	format = strings.ToLower(strings.TrimSpace(format))
	if format != "" {
		mime = "image/" + format
	}
	return cfg.Width, cfg.Height, mime, nil
}

func videoDeliveryLimitError(deliveryLimit int64) error {
	return PreparationUserError{
		Category: CategoryInputTooLarge,
		Reason:   fmt.Sprintf("视频大小超过本机单个生成资源上限 %s", formatStorageLimit(deliveryLimit)),
		Action:   "请调高资源上限后重试",
	}
}

func validateOwnedVideoSize(size, uploadLimit, deliveryLimit int64) error {
	if err := ValidateBeefTVMediaToolSize("video", size, uploadLimit); err != nil {
		return err
	}
	if size > deliveryLimit {
		return videoDeliveryLimitError(deliveryLimit)
	}
	return nil
}

// preflightOwnedVideoDelivery checks readability, emptiness, and size limits
// for an owned video resource without buffering large payloads in RAM.
func preflightOwnedVideoDelivery(ctx context.Context, userID string, media *Media, uploadLimit, deliveryLimit int64) error {
	uploadLimit = NormalizeToolVideoLimit(uploadLimit)
	if media.Bytes > 0 {
		if err := validateOwnedVideoSize(media.Bytes, uploadLimit, deliveryLimit); err != nil {
			return err
		}
	}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.Resources == nil {
		return PreparationUserError{Category: CategoryInputInaccessible, Reason: "本地素材服务暂不可用", Action: "请稍后重试"}
	}
	resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
	_, rc, err := runtime.Resources.Open(userID, resourceID)
	if err != nil {
		return localMediaOpenError(err)
	}
	defer rc.Close()

	file, ok := rc.(ownedLocalFile)
	if !ok {
		return PreparationUserError{Category: CategoryInputInaccessible, Reason: "本地素材文件无法读取", Action: "请重新导入素材后重试"}
	}
	info, statErr := file.Stat()
	if statErr != nil {
		return localMediaOpenError(statErr)
	}
	if !info.Mode().IsRegular() {
		return PreparationUserError{Category: CategoryInputInaccessible, Reason: "本地素材文件无法读取", Action: "请重新导入素材后重试"}
	}
	if err := validateOwnedVideoSize(info.Size(), uploadLimit, deliveryLimit); err != nil {
		return err
	}
	media.Bytes = info.Size()
	return nil
}
