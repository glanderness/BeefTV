package desktopupdate

import "errors"

const (
	StatusDisabled    = "disabled"
	StatusIdle        = "idle"
	StatusChecking    = "checking"
	StatusAvailable   = "available"
	StatusDownloading = "downloading"
	StatusReady       = "ready"
	StatusInstalling  = "installing"
	StatusError       = "error"
)

// UpdateState is the Wails JSON contract. Field names must stay stable.
type UpdateState struct {
	Status          string `json:"status"`
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	ReleaseNotes    string `json:"releaseNotes"`
	DownloadedBytes int64  `json:"downloadedBytes"`
	TotalBytes      int64  `json:"totalBytes"`
	Error           string `json:"error"`
}

var (
	ErrDisabled         = errors.New("自动更新未开启")
	ErrBusy             = errors.New("已有更新操作正在进行")
	ErrNotAvailable     = errors.New("没有可下载的更新")
	ErrNotReady         = errors.New("更新尚未准备好安装")
	ErrInvalidSignature = errors.New("更新信息无法验证")
	ErrTampered         = errors.New("更新文件损坏或被篡改")
	ErrWrongPlatform    = errors.New("没有适合当前系统的更新包")
	ErrUnsupported      = errors.New("当前系统不支持自动更新")
	ErrNoDowngrade      = errors.New("更新源版本不是更新的版本")
	ErrTimeout          = errors.New("检查或下载更新超时")
	ErrInvalidArchive   = errors.New("更新包格式无效")
	ErrInstallFailed    = errors.New("安装更新失败")
	ErrIncompleteConfig = errors.New("更新配置不完整")
)

func (s UpdateState) clone() UpdateState {
	return s
}
