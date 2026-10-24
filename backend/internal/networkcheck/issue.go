package networkcheck

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// Receipt stays with support, not in the customer package. It contains no URL.
type Receipt struct {
	Schema       int       `json:"schema"`
	ID           string    `json:"id"`
	Bucket       string    `json:"bucket"`
	Region       string    `json:"region"`
	CreatedAt    time.Time `json:"created_at"`
	PutExpiresAt time.Time `json:"put_expires_at"`
	CleanupAfter time.Time `json:"cleanup_after"`
	CleanupState string    `json:"cleanup_state"`
}
type Credentials struct {
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	SessionToken    string `json:"session_token,omitempty"`
}

func ReadCredentials(r io.Reader) (Credentials, error) {
	var c Credentials
	d := json.NewDecoder(io.LimitReader(r, 16384))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil || c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return c, errors.New("无法从标准输入读取存储凭据")
	}
	return c, nil
}
func (c Credentials) aws() aws.Credentials {
	return aws.Credentials{AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey, SessionToken: c.SessionToken}
}
func Issue(ctx context.Context, c Credentials, bucket, region, caseID string, ttl time.Duration, sessionPath, receiptPath string) (Receipt, error) {
	var receipt Receipt
	if !bucketPattern.MatchString(bucket) || !regionPattern.MatchString(region) || !cleanLabel(caseID, 120) || caseID == "" || ttl < 2*time.Minute || ttl > 30*time.Minute || ttl%time.Second != 0 || sessionPath == receiptPath {
		return receipt, errors.New("签发参数无效；有效期须为 2 到 30 分钟，支持编号不能为空")
	}
	host := bucket + ".cos." + region + ".myqcloud.com"
	if err := checkUnversioned(ctx, c, host, region); err != nil {
		return receipt, err
	}
	now := time.Now().UTC().Truncate(time.Second)
	s, err := signSession(ctx, c, bucket, region, caseID, ttl, now, randomID())
	if err != nil {
		return receipt, err
	}
	receipt = Receipt{Schema: 1, ID: s.ID, Bucket: bucket, Region: region, CreatedAt: now, PutExpiresAt: s.PutExpiresAt, CleanupAfter: s.PutExpiresAt.Add(time.Minute), CleanupState: "pending"}
	// Persist cleanup custody before disclosing any write capability. Never overwrite.
	if err := exclusiveJSON(receiptPath, receipt); err != nil {
		return receipt, errors.New("无法新建客服清理收据；没有输出会话")
	}
	if err := exclusiveJSON(sessionPath, s); err != nil {
		return receipt, errors.New("会话输出失败；清理收据已保留")
	}
	return receipt, nil
}
func signSession(ctx context.Context, c Credentials, bucket, region, caseID string, ttl time.Duration, now time.Time, id string) (Session, error) {
	host := bucket + ".cos." + region + ".myqcloud.com"
	s := Session{Schema: 1, ID: id, Case: caseID, Bucket: bucket, Region: region, CreatedAt: now, PutExpiresAt: now.Add(ttl)}
	for _, route := range []string{"beeftv", "direct"} {
		for _, size := range []string{"small", "large"} {
			data := Payload(s.ID, size)
			md := md5.Sum(data)
			o := Object{Route: route, Size: size, Requests: map[string]Capability{}}
			for _, method := range []string{"PUT", "HEAD", "GET", "DELETE"} {
				req, _ := http.NewRequestWithContext(ctx, method, "https://"+host+"/"+objectKey(s.ID, route, size), nil)
				life := ttl + 5*time.Minute
				if method == "PUT" {
					life = ttl
					req.ContentLength = int64(len(data))
					req.Header.Set("Content-Type", "image/png")
					req.Header.Set("Content-MD5", base64.StdEncoding.EncodeToString(md[:]))
					req.Header.Set("X-Cos-Forbid-Overwrite", "true")
				}
				q := req.URL.Query()
				q.Set("X-Amz-Expires", seconds(life))
				req.URL.RawQuery = q.Encode()
				signed, headers, err := v4.NewSigner().PresignHTTP(ctx, c.aws(), req, "UNSIGNED-PAYLOAD", "s3", region, now, func(o *v4.SignerOptions) { o.DisableURIPathEscaping = true; o.DisableHeaderHoisting = true })
				if err != nil {
					return s, errors.New("签发失败，未输出会话")
				}
				cap := Capability{URL: signed, Headers: map[string]string{}}
				for k, v := range headers {
					if k != "Host" && len(v) == 1 {
						cap.Headers[http.CanonicalHeaderKey(k)] = v[0]
					}
				}
				o.Requests[method] = cap
			}
			s.Objects = append(s.Objects, o)
		}
	}
	if err := s.Validate(now); err != nil {
		return s, errors.New("签发结果未通过安全校验")
	}
	return s, nil
}
func exclusiveJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func operatorRequest(ctx context.Context, c Credentials, region, method, raw string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, raw, nil)
	if err != nil {
		return 0, nil, errors.New("invalid request")
	}
	req.Header.Set("X-Amz-Content-Sha256", digest(nil))
	if err := v4.NewSigner().SignHTTP(ctx, c.aws(), req, digest(nil), "s3", region, time.Now(), func(o *v4.SignerOptions) { o.DisableURIPathEscaping = true }); err != nil {
		return 0, nil, errors.New("sign failed")
	}
	tr := &http.Transport{TLSHandshakeTimeout: 8 * time.Second, ResponseHeaderTimeout: 10 * time.Second, DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	client := &http.Client{Timeout: 15 * time.Second, Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, errors.New("storage transport failed")
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4097))
	if err != nil || len(b) > 4096 {
		return resp.StatusCode, nil, errors.New("storage response incomplete")
	}
	return resp.StatusCode, b, nil
}
func checkUnversioned(ctx context.Context, c Credentials, host, region string) error {
	status, b, err := operatorRequest(ctx, c, region, "GET", "https://"+host+"/?versioning")
	var v struct {
		XMLName xml.Name
		Status  string `xml:"Status"`
	}
	if err != nil || status != 200 || xml.Unmarshal(b, &v) != nil || v.XMLName.Local != "VersioningConfiguration" || v.Status != "" {
		return errors.New("无法确认 COS 从未开启版本控制；不签发或清理，不修改桶配置")
	}
	return nil
}
func FinalCleanup(ctx context.Context, c Credentials, receiptPath, bucket, region string) (Receipt, error) {
	var r Receipt
	if err := readJSON(receiptPath, &r, 8192); err != nil {
		return r, errors.New("无法读取客服原始清理收据；不能使用客户会话文件")
	}
	if r.Schema != 1 || !idPattern.MatchString(r.ID) || !bucketPattern.MatchString(bucket) || !regionPattern.MatchString(region) || r.Bucket != bucket || r.Region != region || r.PutExpiresAt.Sub(r.CreatedAt) < 2*time.Minute || r.PutExpiresAt.Sub(r.CreatedAt) > 30*time.Minute || !r.CleanupAfter.Equal(r.PutExpiresAt.Add(time.Minute)) {
		return r, errors.New("清理收据或固定存储目标不匹配")
	}
	if time.Now().Before(r.CleanupAfter) {
		return r, fmt.Errorf("PUT 仍可能有效或在途，请在 %s 后再次清理", r.CleanupAfter.Format(time.RFC3339))
	}
	host := bucket + ".cos." + region + ".myqcloud.com"
	if err := checkUnversioned(ctx, c, host, region); err != nil {
		return r, err
	}
	r.CleanupState = "pending"
	for _, route := range []string{"beeftv", "direct"} {
		for _, size := range []string{"small", "large"} {
			u := "https://" + host + "/" + objectKey(r.ID, route, size)
			status, _, err := operatorRequest(ctx, c, region, "DELETE", u)
			if err != nil || (status != 204 && status != 200) {
				return r, errors.New("精确对象删除未确认；保留 pending 收据")
			}
			status, _, err = operatorRequest(ctx, c, region, "HEAD", u)
			if err != nil || status != 404 {
				return r, errors.New("删除后的不存在状态未确认；保留 pending 收据")
			}
		}
	}
	r.CleanupState = "confirmed_after_put_expiry"
	if err := writeJSON(receiptPath, r); err != nil {
		return r, errors.New("对象已清理，但收据状态保存失败")
	}
	return r, nil
}
