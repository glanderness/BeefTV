package referencestorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"infinite-canvas/backend/internal/outbound"
)

func Upload(ctx context.Context, config Config, path string, observers ...func(int64, int64, string)) (string, error) {
	if !config.Enabled {
		return "", errors.New("尚未启用参考素材对象存储")
	}
	if err := config.Validate(); err != nil {
		return "", err
	}
	client := outbound.OutboundHTTPClient(10 * time.Minute)
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return upload(ctx, config, path, client, observers...)
}

func upload(ctx context.Context, config Config, path string, client *http.Client, observers ...func(int64, int64, string)) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return "", err
	}
	observe := func(loaded int64, phase string) {
		if len(observers) > 0 && observers[0] != nil {
			observers[0](loaded, stat.Size(), phase)
		}
	}
	observe(0, "preparing")
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return "", err
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	sample := make([]byte, 512)
	n, _ := file.Read(sample)
	contentType := http.DetectContentType(sample[:n])
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	key := "beeftv/references/" + digest
	endpoint, err := objectEndpointURL(config, key)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, &uploadReader{Reader: file, total: stat.Size(), observe: observe})
	if err != nil {
		return "", err
	}
	request.ContentLength = stat.Size()
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("X-Amz-Content-Sha256", digest)
	request.URL.Opaque = "//" + request.URL.Host + request.URL.EscapedPath()
	credentials := aws.Credentials{AccessKeyID: config.AccessKeyID, SecretAccessKey: config.SecretAccessKey}
	if err = v4.NewSigner().SignHTTP(ctx, credentials, request, digest, "s3", config.Region, time.Now(), func(options *v4.SignerOptions) { options.DisableURIPathEscaping = true }); err != nil {
		return "", errors.New("对象存储请求签名失败")
	}
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("对象存储上传失败，请检查端点和网络")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", uploadRejectionError(response.StatusCode, response.Body)
	}
	observe(stat.Size(), "processing")
	publicURL, err := url.JoinPath(config.PublicBaseURL, key)
	if err != nil {
		return "", err
	}
	// A successful PUT does not prove the URL is readable without credentials.
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, publicURL, nil)
	if err != nil {
		return "", err
	}
	probe.Header.Set("Range", "bytes=0-511")
	check, err := client.Do(probe)
	if err != nil {
		return "", errors.New("素材已上传，但公网地址无法访问，请检查公开读取设置")
	}
	defer check.Body.Close()
	if check.StatusCode != http.StatusOK && check.StatusCode != http.StatusPartialContent {
		return "", fmt.Errorf("素材已上传，但公网地址不可读取（HTTP %d），请检查公开读取设置", check.StatusCode)
	}
	first := make([]byte, n)
	if n == 0 {
		return "", errors.New("参考素材文件为空")
	}
	if _, err := io.ReadFull(check.Body, first); err != nil || !bytes.Equal(first, sample[:n]) {
		return "", errors.New("公网地址未返回上传的素材，请检查地址与存储桶的对应关系")
	}
	return publicURL, nil
}

type uploadReader struct {
	io.Reader
	loaded, total int64
	last          time.Time
	observe       func(int64, string)
}

func (r *uploadReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.loaded += int64(n)
	if err != nil || r.loaded == r.total || time.Since(r.last) >= 300*time.Millisecond {
		r.last = time.Now()
		phase := "transferring"
		if r.loaded == r.total {
			phase = "processing"
		}
		r.observe(r.loaded, phase)
	}
	return n, err
}

func objectEndpointURL(config Config, key string) (string, error) {
	parsed, err := url.Parse(config.Endpoint)
	if err != nil {
		return "", err
	}
	host := strings.ToLower(parsed.Hostname())
	bucketPrefix := strings.ToLower(config.Bucket) + "."
	if strings.HasPrefix(host, bucketPrefix) {
		return url.JoinPath(config.Endpoint, key)
	}
	if isVirtualHostedOnlyS3Provider(host) && (parsed.Path == "" || parsed.Path == "/") {
		if port := parsed.Port(); port != "" {
			parsed.Host = config.Bucket + "." + parsed.Hostname() + ":" + port
		} else {
			parsed.Host = config.Bucket + "." + parsed.Hostname()
		}
		return url.JoinPath(parsed.String(), key)
	}
	return url.JoinPath(config.Endpoint, config.Bucket, key)
}

func isVirtualHostedOnlyS3Provider(host string) bool {
	return strings.HasSuffix(host, ".myqcloud.com") || strings.HasSuffix(host, ".aliyuncs.com")
}

// UploadRejectionError carries an allowlisted S3/COS rejection diagnostic so
// both storage tests and generation failures can explain HTTP 403 causes
// without ever exposing raw upstream XML, URLs, or secrets.
type UploadRejectionError struct {
	StatusCode int
	Code       string
	Reason     string
	Action     string
}

func (e UploadRejectionError) Error() string {
	if strings.TrimSpace(e.Action) == "" {
		return e.Reason
	}
	return e.Reason + "，" + e.Action
}

func (e UploadRejectionError) SafeStorageFailure() (string, string) {
	return e.Reason + "，本次尚未开始生成", e.Action
}

var (
	safeStorageReasonPattern = regexp.MustCompile(`^.+?（HTTP ([345]\d{2})(?:，([A-Za-z]+))?），本次尚未开始生成$`)
	allowlistedS3ErrorCodes  = map[string]struct{}{
		"AccessDenied":                 {},
		"SignatureDoesNotMatch":        {},
		"InvalidAccessKeyId":           {},
		"NoSuchBucket":                 {},
		"InvalidBucketName":            {},
		"RequestTimeTooSkewed":         {},
		"AuthorizationHeaderMalformed": {},
		"PermanentRedirect":            {},
	}
)

// SafeStorageRejectionCopy builds the canonical application-owned reason and
// action for an allowlisted S3/COS rejection status and code.
func SafeStorageRejectionCopy(statusCode int, code string) (string, string) {
	switch code {
	case "AccessDenied":
		return fmt.Sprintf("对象存储拒绝上传（HTTP %d，AccessDenied）", statusCode),
			"请检查存储桶访问权限（推荐公有读私有写）以及子账号/CAM 是否具备写入与删除权限"
	case "SignatureDoesNotMatch":
		return fmt.Sprintf("对象存储签名校验失败（HTTP %d，SignatureDoesNotMatch）", statusCode),
			"请检查 Secret Access Key、区域代码（如 ap-guangzhou / auto）及本机系统时间后重试"
	case "InvalidAccessKeyId":
		return fmt.Sprintf("对象存储密钥无效（HTTP %d，InvalidAccessKeyId）", statusCode),
			"请检查 Access Key ID（腾讯云 COS 为 SecretId）后重试"
	case "NoSuchBucket", "InvalidBucketName":
		return fmt.Sprintf("找不到指定的对象存储桶（HTTP %d，%s）", statusCode, code),
			"请检查存储桶名称（腾讯云 COS 须含 -APPID 后缀）与区域端点是否一致后重试"
	case "RequestTimeTooSkewed":
		return fmt.Sprintf("对象存储拒绝上传（HTTP %d，RequestTimeTooSkewed）", statusCode),
			"请校准本机系统时间后重试"
	case "AuthorizationHeaderMalformed", "PermanentRedirect":
		return fmt.Sprintf("对象存储区域或端点不匹配（HTTP %d，%s）", statusCode, code),
			"请核对 S3 端点与区域代码是否一致后重试"
	}
	if statusCode == http.StatusForbidden {
		return "对象存储拒绝上传（HTTP 403）",
			"请检查访问密钥、存储桶名称（腾讯云 COS 须含 -APPID）、区域及存储桶/子账号写入权限"
	}
	return fmt.Sprintf("对象存储拒绝上传（HTTP %d）", statusCode),
		"请检查对象存储端点、区域、访问密钥与存储桶权限后重试"
}

// MatchSafeStorageFailure reports whether reason and action exactly match an
// application-owned SafeStorageFailure copy generated by UploadRejectionError.
func MatchSafeStorageFailure(reason, action string) (int, string, bool) {
	m := safeStorageReasonPattern.FindStringSubmatch(strings.TrimSpace(reason))
	if len(m) != 3 {
		return 0, "", false
	}
	statusCode, err := strconv.Atoi(m[1])
	if err != nil || statusCode < 300 || statusCode > 599 {
		return 0, "", false
	}
	code := m[2]
	if code != "" {
		if _, ok := allowlistedS3ErrorCodes[code]; !ok {
			return 0, "", false
		}
	}
	expectedReason, expectedAction := SafeStorageRejectionCopy(statusCode, code)
	if strings.TrimSpace(reason) == expectedReason+"，本次尚未开始生成" && strings.TrimSpace(action) == expectedAction {
		return statusCode, code, true
	}
	return 0, "", false
}

func uploadRejectionError(statusCode int, body io.Reader) error {
	code := parseSafeS3ErrorCode(body)
	reason, action := SafeStorageRejectionCopy(statusCode, code)
	return UploadRejectionError{
		StatusCode: statusCode,
		Code:       code,
		Reason:     reason,
		Action:     action,
	}
}

func parseSafeS3ErrorCode(body io.Reader) string {
	if body == nil {
		return ""
	}
	raw, err := io.ReadAll(io.LimitReader(body, 4096))
	if err != nil || len(raw) == 0 {
		return ""
	}
	var payload struct {
		Code string `xml:"Code"`
	}
	if err := xml.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	code := strings.TrimSpace(payload.Code)
	if _, ok := allowlistedS3ErrorCodes[code]; ok {
		return code
	}
	return ""
}
