package desktopupdate

import (
 "os"
 "path/filepath"
 "testing"
)

func TestPublishedWindowsArchiveExtractionAudit(t *testing.T) {
 archive := os.Getenv("BEEFTV_AUDIT_ARCHIVE")
 if archive == "" { t.Skip("requires downloaded release archive") }
 dest := filepath.Join(t.TempDir(), "payload")
 if err := extractSecureZip(archive, dest, defaultExtractLimits()); err != nil { t.Fatal(err) }
 if err := validateWindowsLayout(dest); err != nil { t.Fatal(err) }
 t.Log("Actual published ZIP passed production secure extraction and Windows layout validation")
}
