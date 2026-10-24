// connectivity-check writes a local, bounded support report without generation.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/networkcheck"
)

func main() {
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	config := flag.String("config", filepath.Join(dir, "targets.json"), "检测目标配置")
	out := flag.String("out", dir, "本地报告目录")
	session := flag.String("session", filepath.Join(dir, "session.json"), "客服短期深度会话")
	interactive := flag.Bool("interactive", true, "询问支持编号、网点和可选 IP 采集")
	pause := flag.Bool("pause", true, "结束后等待回车")
	consent := flag.Bool("consent-ip", false, "同意通过 BeefAPI 的 Cloudflare 入口查询公网出口并记录公网 IP")
	caseID := flag.String("case", "", "支持编号")
	site := flag.String("site", "", "办公网点代号（不要填人员姓名）")
	network := flag.String("network", "", "网络说明，如电信办公网 / 公司 VPN")
	app := flag.String("beeftv-version", "", "用户填写的 BeefTV 版本")
	rounds := flag.Int("rounds", 3, "基础采样轮数，1 到 5")
	flag.Parse()
	reader := bufio.NewReader(os.Stdin)
	fmt.Println("BeefTV 企业网络检测 · " + networkcheck.Version)
	fmt.Println("请保持报错时的网络与代理设置。检测最多约 3 分钟；Ctrl+C 会停止检测并尝试清理测试文件。")
	fmt.Println("不读取 API Key、客户素材或项目，不提交生成。只上传合成测试图片；报告先保存在本机，不自动发送。")
	if *interactive {
		if *caseID == "" {
			*caseID = ask(reader, "支持编号（有客服会话时可直接回车）：")
		}
		if *site == "" {
			*site = ask(reader, "办公网点代号（可留空，不填人员姓名）：")
		}
		if *network == "" {
			*network = ask(reader, "网络说明，如电信办公网 / 公司 VPN（可留空）：")
		}
		if *app == "" {
			*app = ask(reader, "BeefTV 版本（可留空）：")
		}
		fmt.Println("可选：通过 BeefAPI 的 Cloudflare 入口查询公网出口，报告会记录公网出口 IP、公网 DNS 结果和连接目标 IP。不会记录内网 IP、代理地址或密码。")
		if !*consent {
			*consent = strings.EqualFold(ask(reader, "是否同意这项 IP 采集？输入 Y 同意，直接回车跳过："), "y")
		}
	}
	c, err := networkcheck.LoadConfiguration(*config)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	var base string
	if err == nil {
		base, err = networkcheck.Run(ctx, networkcheck.Options{Configuration: c, Metadata: networkcheck.Metadata{Case: *caseID, Site: *site, Network: *network, AppVersion: *app}, SessionPath: *session, OutputDir: *out, ConsentIP: *consent, Rounds: *rounds, Progress: func(s string) { fmt.Println(s) }})
	}
	if err != nil {
		fmt.Println("检测报告未完整保存：", err)
	} else {
		fmt.Println("报告已保存。请打开 HTML 检查，再把同名 ZIP 发给客服：")
		fmt.Println(base + ".html")
		fmt.Println(base + ".zip")
	}
	if *pause {
		fmt.Println("按回车关闭窗口。")
		_, _ = reader.ReadString('\n')
	}
	if err != nil {
		os.Exit(1)
	}
}
func ask(r *bufio.Reader, prompt string) string {
	fmt.Print(prompt)
	s, _ := r.ReadString('\n')
	return strings.TrimSpace(s)
}
