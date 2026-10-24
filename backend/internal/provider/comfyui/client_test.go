package comfyui

import "testing"

func TestValidateURLRejectsUnsafeOrigins(t *testing.T) {
	for _, value := range []string{
		"", "ftp://127.0.0.1:8188", "http://user:secret@127.0.0.1:8188",
		"http://127.0.0.1:8188/path", "http://127.0.0.1:8188?x=1", "http://127.0.0.1:8188#fragment",
	} {
		if _, err := ValidateURL(value); err == nil {
			t.Fatalf("accepted unsafe origin %q", value)
		}
	}
	if _, err := ValidateURL("http://127.0.0.1:18188"); err != nil {
		t.Fatalf("rejected loopback origin: %v", err)
	}
}
