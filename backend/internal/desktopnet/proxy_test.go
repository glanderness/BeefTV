package desktopnet

import (
	"net/http"
	"net/url"
	"runtime"
	"testing"

	"golang.org/x/net/http/httpproxy"
)

func TestSystemProxySelection(t *testing.T) {
	windows := parseWindowsProxy("http=127.0.0.1:8080;https=127.0.0.1:7890", "*.internal;<local>")
	mac := parseMacProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.internal
    1 : 10.0.0.0/8
  }
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 8080
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
  ExcludeSimpleHostnames : 1
}`)
	for _, system := range []systemProxySettings{windows, mac} {
		for _, tc := range []struct{ target, noProxy, want string }{
			{"https://github.com/a", "", "http://127.0.0.1:7890"},
			{"https://release-assets.githubusercontent.com/a", "", "http://127.0.0.1:7890"},
			{"http://example.com", "", "http://127.0.0.1:8080"},
			{"https://github.com/a", "github.com", ""},
			{"https://host.internal", "", ""},
			{"https://intranet", "", ""},
			{"https://127.0.0.1", "", ""},
		} {
			target, _ := url.Parse(tc.target)
			got, err := proxyWithSystem(target, httpproxy.Config{NoProxy: tc.noProxy}, system)
			actual := ""
			if got != nil {
				actual = got.String()
			}
			if err != nil || actual != tc.want {
				t.Errorf("%s: proxy %q error %v, want %q", tc.target, actual, err, tc.want)
			}
		}
	}
	for _, system := range []systemProxySettings{parseWindowsProxy("", ""), parseMacProxy("HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890"), parseMacProxy("HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 99999")} {
		target, _ := url.Parse("https://github.com")
		got, err := proxyWithSystem(target, httpproxy.Config{}, system)
		if err != nil || got != nil {
			t.Fatalf("disabled or invalid system proxy: %v %v", got, err)
		}
	}
	if parseWindowsProxy("127.0.0.1:7890", "").config.HTTPSProxy != "127.0.0.1:7890" {
		t.Fatal("single Windows proxy was lost")
	}
}

func TestExplicitProxyAndBypassTakePriority(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Setenv("http_proxy", "")
		t.Setenv("https_proxy", "")
		t.Setenv("no_proxy", "")
	}
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:5555")
	t.Setenv("NO_PROXY", "github.com")
	for _, tc := range []struct{ target, want string }{{"https://example.com", "http://127.0.0.1:5555"}, {"https://github.com", ""}} {
		req, _ := http.NewRequest(http.MethodGet, tc.target, nil)
		got, err := Proxy(req)
		actual := ""
		if got != nil {
			actual = got.String()
		}
		if err != nil || actual != tc.want {
			t.Fatalf("explicit proxy %q, %v", actual, err)
		}
	}
}
