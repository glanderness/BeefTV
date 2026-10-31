// connectivity-session is a support-only signer. Never put it in customer kits.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"infinite-canvas/backend/internal/networkcheck"
)

func main() {
	mode := flag.String("mode", "issue", "issue 或 cleanup")
	bucket := flag.String("bucket", "", "固定 COS 桶名")
	region := flag.String("region", "ap-guangzhou", "COS 地域")
	caseID := flag.String("case", "", "支持编号，使用代号")
	ttl := flag.Duration("ttl", 20*time.Minute, "PUT 有效期，2 到 30 分钟")
	session := flag.String("session", "session.json", "客户短期会话输出（不覆盖）")
	receipt := flag.String("receipt", "cleanup-receipt.json", "仅客服保管的清理收据")
	flag.Parse()
	c, err := networkcheck.ReadCredentials(os.Stdin)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var r networkcheck.Receipt
	if err == nil {
		switch *mode {
		case "issue":
			r, err = networkcheck.Issue(ctx, c, *bucket, *region, *caseID, *ttl, *session, *receipt)
		case "cleanup":
			r, err = networkcheck.FinalCleanup(ctx, c, *receipt, *bucket, *region)
		default:
			err = fmt.Errorf("mode 必须是 issue 或 cleanup")
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("session_id=%s\nput_expires_at=%s\ncleanup_after=%s\ncleanup_state=%s\n", r.ID, r.PutExpiresAt.Format(time.RFC3339), r.CleanupAfter.Format(time.RFC3339), r.CleanupState)
}
