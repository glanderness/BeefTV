package networkcheck

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func reportBase(dir, id string) string {
	return filepath.Join(dir, "BeefTV-network-report-"+time.Now().Format("20060102-150405")+"-"+id[:8])
}
func atomicFile(path string, b []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".network-report-*")
	if err != nil {
		return errors.New("无法保存报告，请将工具放到可写入的文件夹")
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	_, err = f.Write(b)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.New("报告写入失败")
	}
	if err = os.Rename(tmp, path); err != nil {
		return errors.New("报告替换失败")
	}
	return nil
}
func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return atomicFile(path, b)
}

type summary struct {
	Target, Route                string
	Samples, Responses, Failures int
	Min, Median, Max             int64
}

func summaries(results []Result) []summary {
	var out []summary
	groups := map[string][]Result{}
	var keys []string
	for _, r := range results {
		if r.Operation != "https_connectivity" {
			continue
		}
		key := r.Target + "\x00" + r.Route
		if _, ok := groups[key]; !ok {
			keys = append(keys, key)
		}
		groups[key] = append(groups[key], r)
	}
	for _, key := range keys {
		rs := groups[key]
		s := summary{Target: rs[0].Target, Route: routeName(rs[0].Route)}
		var ms []int64
		for _, r := range rs {
			if !r.Finished {
				continue
			}
			s.Samples++
			if r.ErrorCode != "" {
				s.Failures++
			} else if r.HTTPStatus != 0 {
				s.Responses++
				ms = append(ms, r.TotalMS)
			}
		}
		s.Min = -1
		s.Median = -1
		s.Max = -1
		if len(ms) > 0 {
			sort.Slice(ms, func(i, j int) bool { return ms[i] < ms[j] })
			s.Min = ms[0]
			s.Max = ms[len(ms)-1]
			s.Median = ms[len(ms)/2]
			if len(ms)%2 == 0 {
				s.Median = (ms[len(ms)/2-1] + ms[len(ms)/2]) / 2
			}
		}
		out = append(out, s)
	}
	return out
}
func resultText(r Result) string {
	if !r.Finished {
		return "未完成，最后阶段：" + phaseName(r.Phase)
	}
	if r.ErrorCode != "" {
		return "失败于" + phaseName(r.Phase) + "（" + r.ErrorCode + "）"
	}
	return fmt.Sprintf("收到 HTTP %d，耗时 %d ms", r.HTTPStatus, r.TotalMS)
}
func phaseName(s string) string {
	labels := map[string]string{"pending": "等待开始", "prepare": "准备请求", "dns": "域名解析", "tcp": "建立 TCP 连接", "proxy_or_tls": "代理连接或 TLS 准备", "tls": "TLS 握手", "write_request": "发送请求", "wait_response": "等待响应", "read_response": "读取响应", "http_response": "收到 HTTP 响应", "verify_content": "内容校验", "not_started": "未开始"}
	if v, ok := labels[s]; ok {
		return v
	}
	return s
}
func outcomeName(s string) string {
	labels := map[string]string{"verified": "上传成功，完整回读校验一致", "verified_after_unconfirmed_put": "上传回执未确认，同一文件完整回读已通过", "not_measured": "未测", "put_not_confirmed": "未确认上传成功", "head_confirmation_failed": "上传收到成功响应，文件存在状态未确认", "read_failed": "文件存在，完整回读未通过", "absent_now; operator_final_cleanup_pending": "当前已清理；客服待到期后复查", "cleanup_unconfirmed; operator_final_cleanup_pending": "清理尚未确认，待客服处理", "operator_final_cleanup_pending": "待客服清理复查"}
	if v, ok := labels[s]; ok {
		return v
	}
	return s
}
func writeBundle(base string, r Report) error {
	var text strings.Builder
	fmt.Fprintf(&text, "BeefTV 企业网络检测报告\r\n检测编号：%s\r\n支持编号：%s\r\n检测时间（UTC）：%s\r\n状态：%s\r\n系统：%s / %s\r\n办公网络：%s / %s（用户填写）\r\nBeefTV 版本：%s（用户填写）\r\n代理来源：%s，只有自动代理：%t\r\n同意采集公网 IP：%t\r\n深度检测：%s\r\n应用层传输：%d / %d 字节\r\n", r.DiagnosticID, r.Metadata.Case, r.CreatedAt.Format(time.RFC3339), r.State, r.OSRelease, r.Architecture, r.Metadata.Site, r.Metadata.Network, r.Metadata.AppVersion, r.ProxyMode, r.AutoConfigOnly, r.IPConsent, r.SessionStatus, r.TrafficBytes, r.TrafficLimitBytes)
	for _, s := range summaries(r.Results) {
		fmt.Fprintf(&text, "\r\n%s | %s | 已完成 %d 次，收到响应 %d 次，网络失败 %d 次 | 成功响应耗时 min/median/max=%d/%d/%d ms\r\n", s.Target, s.Route, s.Samples, s.Responses, s.Failures, s.Min, s.Median, s.Max)
	}
	for _, t := range r.Transfers {
		fmt.Fprintf(&text, "\r\n图片 %s / %s / %d 字节：%s；清理=%s\r\n", t.Size, routeName(t.Route), t.Bytes, outcomeName(t.Outcome), outcomeName(t.Cleanup))
	}
	for _, e := range r.Egress {
		fmt.Fprintf(&text, "\r\n出口 %s：%s，IP=%s，国家/地区=%s，Cloudflare 节点=%s\r\n", routeName(e.Route), e.Outcome, e.IP, e.Country, e.Colo)
	}
	for _, p := range r.Results {
		fmt.Fprintf(&text, "\r\n%s | %s | %s | %s | %s | %s | request_id=%s | cos_request_id=%s\r\n", p.StartedAt.Format(time.RFC3339Nano), p.Target, p.Operation, routeName(p.Route), resultText(p), p.Host, p.RequestID, p.COSRequestID)
	}
	text.WriteString("\r\n检测边界：\r\n")
	for _, s := range r.Coverage {
		text.WriteString("- " + s + "\r\n")
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	var html bytes.Buffer
	tpl, err := template.New("report").Funcs(template.FuncMap{"route": routeName, "result": resultText, "outcome": outcomeName}).Parse(reportHTML)
	if err != nil {
		return err
	}
	view := struct {
		Report
		Summary []summary
	}{r, summaries(r.Results)}
	if err := tpl.Execute(&html, view); err != nil {
		return err
	}
	files := []struct {
		ext  string
		data []byte
	}{{".json", data}, {".txt", []byte("\xef\xbb\xbf" + text.String())}, {".html", html.Bytes()}}
	var bundle bytes.Buffer
	z := zip.NewWriter(&bundle)
	for _, f := range files {
		if err := atomicFile(base+f.ext, f.data); err != nil {
			return err
		}
		w, err := z.Create(filepath.Base(base) + f.ext)
		if err != nil {
			return err
		}
		if _, err = w.Write(f.data); err != nil {
			return err
		}
	}
	if err := z.Close(); err != nil {
		return err
	}
	return atomicFile(base+".zip", bundle.Bytes())
}

const reportHTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BeefTV 网络检测报告</title><style>
*{box-sizing:border-box}body{font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif;color:#182433;background:#f3f6f9;margin:0;padding:32px 20px}main{max-width:1160px;margin:auto}h1{font-size:28px;line-height:1.3;margin:0 0 12px}h2{font-size:19px;margin:0 0 12px}.card{background:white;border:1px solid #dce3ea;border-radius:12px;padding:24px;margin:18px 0}.meta{color:#536274;overflow-wrap:anywhere}.notice{border-left:4px solid #b97910;background:#fff9e9;padding:14px 18px}.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e4e9ef;padding:10px 12px;vertical-align:top}th{white-space:nowrap;background:#f5f7fa}td{overflow-wrap:anywhere;max-width:320px}.bad{color:#a42927;font-weight:600}.code{font-family:ui-monospace,Consolas,monospace;font-size:12px}p{margin:8px 0}li{margin:7px 0}@media(max-width:600px){body{padding:16px 10px}.card{padding:16px}h1{font-size:23px}}</style><main>
<h1>BeefTV 企业网络检测报告</h1><p class="meta">检测编号 <span class="code">{{.DiagnosticID}}</span><br>支持编号 {{.Metadata.Case}} · {{.CreatedAt.Format "2006-01-02 15:04:05 UTC"}}<br>{{.OSRelease}} / {{.Architecture}} · 办公网点 {{.Metadata.Site}} · 网络 {{.Metadata.Network}}（用户填写）</p>
<div class="notice">请先检查报告，再将同名 ZIP 发给客服。报告保存在本机，没有自动上传。<br>状态：<b>{{.State}}</b> · 深度检测：{{.SessionStatus}} · 公网 IP 采集：{{if .IPConsent}}已同意{{else}}未采集{{end}}</div>
<section class="card"><h2>HTTPS 连通性</h2><p>401 / 403 也可能说明 HTTPS 已连通。下列耗时仅统计收到响应且没有传输错误的样本；少量采样无法保证之后始终连通。</p><div class="table"><table><tr><th>目标 / 路线</th><th>完成 / 响应 / 网络失败</th><th>耗时 min / median / max（ms）</th></tr>{{range .Summary}}<tr><td>{{.Target}}<br>{{.Route}}</td><td>{{.Samples}} / {{.Responses}} / {{.Failures}}</td><td>{{.Min}} / {{.Median}} / {{.Max}}</td></tr>{{end}}</table></div><p class="meta">计划 {{.PlannedBaseProbes}} 次基础采样。-1 表示未观测到。</p></section>
<section class="card"><h2>合成图片上传与完整回读</h2>{{if .Transfers}}<div class="table"><table><tr><th>路线 / 图片</th><th>大小</th><th>校验结果</th><th>清理状态</th></tr>{{range .Transfers}}<tr><td>{{route .Route}} / {{.Size}}</td><td>{{.Bytes}} 字节</td><td>{{outcome .Outcome}}</td><td>{{outcome .Cleanup}}</td></tr>{{end}}</table></div><p>“完整回读通过”表示收到的大小与 SHA256 一致。“当前已清理”只表示此刻文件不存在，客服仍会在上传票据失效后复查。</p>{{else}}<p>未执行。没有有效的客服短期会话时，不能据此判断上传是否正常。</p>{{end}}<p class="meta">应用层传输 {{.TrafficBytes}} / {{.TrafficLimitBytes}} 字节；不含协议头与网络重传。</p></section>
{{if .Egress}}<section class="card"><h2>可选出口信息</h2><div class="table"><table><tr><th>路线</th><th>结果</th><th>公网 IP</th><th>国家/地区 / Cloudflare 节点</th></tr>{{range .Egress}}<tr><td>{{route .Route}}</td><td>{{.Outcome}}</td><td>{{.IP}}</td><td>{{.Country}} / {{.Colo}}</td></tr>{{end}}</table></div><p class="meta">来自用户同意后的一次 Cloudflare 查询。节点位置不代表客户办公地址；未推断运营商。</p></section>{{end}}
<section class="card"><h2>请求与失败阶段</h2><div class="table"><table><tr><th>UTC 时间 / 操作</th><th>目标 / 路线</th><th>结果 / 最后阶段</th><th>关联编号</th></tr>{{range .Results}}<tr><td class="code">{{.StartedAt.Format "15:04:05.000"}}<br>{{.Operation}}</td><td>{{.Host}}<br>{{route .Route}}</td><td {{if .ErrorCode}}class="bad"{{end}}>{{result .}}</td><td class="code">{{.RequestID}}<br>{{.COSRequestID}}</td></tr>{{end}}</table></div></section>
<section class="card"><h2>这份报告能说明什么</h2><ul>{{range .Coverage}}<li>{{.}}</li>{{end}}</ul><p class="meta">代理配置来源：{{.ProxyMode}}；只有自动代理：{{.AutoConfigOnly}}。没有读取 API Key、代理密码、电脑名、MAC 地址、项目或客户素材。</p></section></main></html>`
