// Package networkcheck implements the standalone, opt-in support diagnostic.
// It never loads BeefTV settings, credentials, projects, or customer media.
package networkcheck

import (
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const Version = "2.0.0"
const TrafficLimit int64 = 24 << 20
const SessionPrefix = "transient/diagnostics/v1/"

var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*-[0-9]+$`)
var regionPattern = regexp.MustCompile(`^ap-[a-z]+(?:-[a-z]+)?$`)

type Target struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}
type Configuration struct {
	Targets []Target `json:"targets"`
}
type Metadata struct {
	Case       string `json:"support_case,omitempty"`
	Site       string `json:"site_label,omitempty"`
	Network    string `json:"network_label,omitempty"`
	AppVersion string `json:"beeftv_version_user_supplied,omitempty"`
}
type Capability struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}
type Object struct {
	Route    string                `json:"route"`
	Size     string                `json:"size"`
	Requests map[string]Capability `json:"requests"`
}
type Session struct {
	Schema       int       `json:"schema"`
	ID           string    `json:"id"`
	Case         string    `json:"support_case"`
	Bucket       string    `json:"bucket"`
	Region       string    `json:"region"`
	CreatedAt    time.Time `json:"created_at"`
	PutExpiresAt time.Time `json:"put_expires_at"`
	Objects      []Object  `json:"objects"`
}

func LoadConfiguration(path string) (Configuration, error) {
	var c Configuration
	if err := readJSON(path, &c, 16384); err != nil {
		return c, errors.New("找不到或无法读取 targets.json，请完整解压工具包")
	}
	if len(c.Targets) < 1 || len(c.Targets) > 4 {
		return c, errors.New("检测目标应为 1 到 4 个")
	}
	for _, t := range c.Targets {
		if err := ValidateTarget(t); err != nil {
			return c, err
		}
	}
	return c, nil
}
func ValidateTarget(t Target) error {
	u, err := url.Parse(t.URL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") || (u.Path != "/" && u.Path != "/v1/videos" && u.Path != "/api/status") || !cleanLabel(t.Name, 80) || t.Name == "" {
		return errors.New("检测目标必须是无凭据的 HTTPS 连通性地址")
	}
	return nil
}
func ValidateMetadata(m Metadata) error {
	for _, s := range []string{m.Case, m.Site, m.Network, m.AppVersion} {
		if !cleanLabel(s, 120) {
			return errors.New("编号和网络说明最长 120 字节，不能包含换行")
		}
	}
	return nil
}
func cleanLabel(s string, limit int) bool {
	if len(s) > limit {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func readJSON(path string, dst any, limit int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(b)) > limit {
		return errors.New("file too large")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func LoadSession(path string, now time.Time) (*Session, error) {
	var s Session
	if err := readJSON(path, &s, 65536); err != nil {
		return nil, errors.New("会话文件缺失或无法读取")
	}
	if err := s.Validate(now); err != nil {
		return nil, err
	}
	return &s, nil
}
func (s Session) Host() string { return s.Bucket + ".cos." + s.Region + ".myqcloud.com" }
func objectKey(id, route, size string) string {
	return SessionPrefix + id + "/" + route + "/" + size + ".png"
}
func (s Session) Validate(now time.Time) error {
	bad := errors.New("深度检测会话无效，请向客服获取新会话")
	if s.Schema != 1 || !idPattern.MatchString(s.ID) || !bucketPattern.MatchString(s.Bucket) || !regionPattern.MatchString(s.Region) || !cleanLabel(s.Case, 120) || len(s.Objects) != 4 {
		return bad
	}
	if s.CreatedAt.After(now.Add(time.Minute)) || s.PutExpiresAt.Sub(s.CreatedAt) < 2*time.Minute || s.PutExpiresAt.Sub(s.CreatedAt) > 30*time.Minute || !s.PutExpiresAt.After(now.Add(30*time.Second)) {
		return errors.New("深度检测会话已过期或剩余时间不足，请向客服获取新会话")
	}
	seen := map[string]bool{}
	for _, o := range s.Objects {
		if (o.Route != "beeftv" && o.Route != "direct") || (o.Size != "small" && o.Size != "large") || seen[o.Route+o.Size] || len(o.Requests) != 4 {
			return bad
		}
		seen[o.Route+o.Size] = true
		data := Payload(s.ID, o.Size)
		md := md5.Sum(data)
		for _, method := range []string{"PUT", "HEAD", "GET", "DELETE"} {
			c, ok := o.Requests[method]
			if !ok {
				return bad
			}
			u, err := url.Parse(c.URL)
			if err != nil || u.Scheme != "https" || u.Host != s.Host() || u.User != nil || u.Fragment != "" || u.RawPath != "" || u.Path != "/"+objectKey(s.ID, o.Route, o.Size) {
				return bad
			}
			q, queryErr := url.ParseQuery(u.RawQuery)
			if queryErr != nil {
				return bad
			}
			for k, values := range q {
				if len(values) != 1 {
					return bad
				}
				switch k {
				case "X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Signature", "X-Amz-Security-Token":
				default:
					return bad
				}
			}
			scope := strings.Split(q.Get("X-Amz-Credential"), "/")
			if len(scope) != 5 || scope[0] == "" || scope[1] != s.CreatedAt.Format("20060102") || scope[2] != s.Region || scope[3] != "s3" || scope[4] != "aws4_request" {
				return bad
			}
			if q.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" || q.Get("X-Amz-Signature") == "" {
				return bad
			}
			stamp, err := time.Parse("20060102T150405Z", q.Get("X-Amz-Date"))
			if err != nil || !stamp.Equal(s.CreatedAt) {
				return bad
			}
			var lifetime time.Duration
			if method == "PUT" {
				lifetime = s.PutExpiresAt.Sub(s.CreatedAt)
			} else {
				lifetime = s.PutExpiresAt.Sub(s.CreatedAt) + 5*time.Minute
			}
			if q.Get("X-Amz-Expires") != seconds(lifetime) {
				return bad
			}
			expect := map[string]string{}
			if method == "PUT" {
				expect = map[string]string{"Content-Md5": base64.StdEncoding.EncodeToString(md[:]), "Content-Type": "image/png", "X-Cos-Forbid-Overwrite": "true", "Content-Length": intString(len(data))}
			}
			if len(c.Headers) != len(expect) {
				return bad
			}
			for k, v := range expect {
				if c.Headers[k] != v {
					return bad
				}
			}
			names := "host"
			if method == "PUT" {
				names = "content-length;content-md5;content-type;host;x-cos-forbid-overwrite"
			}
			if q.Get("X-Amz-SignedHeaders") != names {
				return bad
			}
		}
	}
	return nil
}

// A deterministic, incompressible PNG represents real image transfer sizes.
// Session data determines its pixels; no customer file is opened.
func Payload(id, size string) []byte {
	n := 256
	if size == "large" {
		n = 1024
	}
	im := image.NewNRGBA(image.Rect(0, 0, n, n))
	seed := sha256.Sum256([]byte(id + size))
	var x uint64
	for _, b := range seed[:8] {
		x = x<<8 | uint64(b)
	}
	if x == 0 {
		x = 1
	}
	for i := 0; i < len(im.Pix); i += 4 {
		for j := 0; j < 3; j++ {
			x ^= x << 13
			x ^= x >> 7
			x ^= x << 17
			im.Pix[i+j] = byte(x)
		}
		im.Pix[i+3] = 255
	}
	var b bytes.Buffer
	e := png.Encoder{CompressionLevel: png.NoCompression}
	_ = e.Encode(&b, im)
	return b.Bytes()
}
func digest(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }
func safeID(v string) string {
	if len(v) > 160 {
		return ""
	}
	for _, r := range v {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_-.:/+=", r)) {
			return ""
		}
	}
	return v
}
