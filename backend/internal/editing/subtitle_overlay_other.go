//go:build !darwin || !cgo

package editing

import (
	"fmt"
	"image"
)

func rasterizeSubtitleFrame(_ string, _, _ int) (image.Image, error) {
	return nil, fmt.Errorf("当前媒体运行时不支持字幕烧录（缺少 subtitles 滤镜）")
}
