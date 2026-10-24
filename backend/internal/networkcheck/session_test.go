package networkcheck

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixtureSession(t *testing.T) Session {
	t.Helper()
	s, err := signSession(context.Background(), Credentials{AccessKeyID: "AKIDEXAMPLE", SecretAccessKey: "SECRET_CANARY", SessionToken: "TEMP_TOKEN"}, "test-bucket-12345", "ap-guangzhou", "SUPPORT-1", 20*time.Minute, time.Now().UTC().Truncate(time.Second), "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func TestSessionLimitsMethodsKeysHeadersAndExpiry(t *testing.T) {
	s := fixtureSession(t)
	for _, o := range s.Objects {
		data := Payload(s.ID, o.Size)
		if o.Size == "small" && (len(data) < 190000 || len(data) > 220000) || o.Size == "large" && (len(data) < 3000000 || len(data) > 3300000) {
			t.Fatalf("unexpected image size %d", len(data))
		}
		for method, c := range o.Requests {
			u, _ := url.Parse(c.URL)
			if u.Query().Get("X-Amz-Signature") == "" || u.Query().Get("X-Amz-Security-Token") != "TEMP_TOKEN" {
				t.Fatal("temporary credentials not signed")
			}
			if method == "PUT" && c.Headers["Content-Length"] != intString(len(data)) {
				t.Fatal("PUT length not signed")
			}
		}
	}
	b, _ := json.Marshal(s)
	if strings.Contains(string(b), "SECRET_CANARY") {
		t.Fatal("signing secret disclosed")
	}
	mutations := []func(*Session){
		func(s *Session) { s.Objects[0].Requests["POST"] = s.Objects[0].Requests["PUT"] },
		func(s *Session) {
			c := s.Objects[0].Requests["PUT"]
			c.URL = strings.Replace(c.URL, s.Host(), "attacker.example", 1)
			s.Objects[0].Requests["PUT"] = c
		},
		func(s *Session) {
			c := s.Objects[0].Requests["GET"]
			c.URL = strings.Replace(c.URL, "/small.png", "/../customer.png", 1)
			s.Objects[0].Requests["GET"] = c
		},
		func(s *Session) { s.Objects[0].Requests["PUT"].Headers["Content-Length"] = "1" },
		func(s *Session) { s.Objects[0].Requests["PUT"].Headers["Authorization"] = "secret" },
		func(s *Session) {
			c := s.Objects[0].Requests["PUT"]
			c.URL = strings.Replace(c.URL, "X-Amz-Expires=1200", "X-Amz-Expires=3600", 1)
			s.Objects[0].Requests["PUT"] = c
		},
		func(s *Session) { s.Objects[1] = s.Objects[0] },
		func(s *Session) { s.Schema = 2 },
	}
	for i, mutate := range mutations {
		var altered Session
		_ = json.Unmarshal(b, &altered)
		mutate(&altered)
		if altered.Validate(time.Now()) == nil {
			t.Fatalf("accepted tamper %d", i)
		}
	}
	if s.Validate(s.PutExpiresAt) == nil {
		t.Fatal("accepted expired ticket")
	}
}
func TestConfigurationAndCleanupRejectWrongInputsBeforeNetwork(t *testing.T) {
	for _, raw := range []string{"http://example.com/", "https://u:p@example.com/", "https://example.com/?key=secret", "https://example.com/v1/images/generations", "https://example.com:8080/"} {
		if ValidateTarget(Target{Name: "test", URL: raw}) == nil {
			t.Fatal("accepted unsafe target")
		}
	}
	dir := t.TempDir()
	s := fixtureSession(t)
	p := filepath.Join(dir, "customer-session.json")
	if err := exclusiveJSON(p, s); err != nil {
		t.Fatal(err)
	}
	if _, err := FinalCleanup(context.Background(), Credentials{}, p, s.Bucket, s.Region); err == nil {
		t.Fatal("accepted customer capability as cleanup receipt")
	}
	r := Receipt{Schema: 1, ID: s.ID, Bucket: s.Bucket, Region: s.Region, CreatedAt: s.CreatedAt, PutExpiresAt: s.PutExpiresAt, CleanupAfter: s.PutExpiresAt.Add(time.Minute), CleanupState: "pending"}
	p = filepath.Join(dir, "receipt.json")
	_ = exclusiveJSON(p, r)
	if _, err := FinalCleanup(context.Background(), Credentials{}, p, s.Bucket, s.Region); err == nil || !strings.Contains(err.Error(), "仍可能有效") {
		t.Fatal("cleanup not held until expiry")
	}
	if _, err := FinalCleanup(context.Background(), Credentials{}, p, "other-12345", s.Region); err == nil {
		t.Fatal("accepted another bucket")
	}
	if err := exclusiveJSON(p, r); err == nil {
		t.Fatal("receipt silently overwritten")
	}
	if _, err := LoadSession(filepath.Join(dir, "missing"), time.Now()); err == nil {
		t.Fatal("missing ticket accepted")
	}
	_ = os.WriteFile(filepath.Join(dir, "extra.json"), append([]byte(`{"targets":[]}`), []byte(`{"secret":1}`)...), 0600)
	if _, err := LoadConfiguration(filepath.Join(dir, "extra.json")); err == nil {
		t.Fatal("trailing JSON accepted")
	}
}
