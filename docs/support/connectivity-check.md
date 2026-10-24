# 企业网络检测工具

`backend/cmd/connectivity-check` 是独立 Windows 程序，不需要安装或登录 BeefTV。不同企业复用同一程序；客服按事件配置实际 API/COS 域名、支持编号和短期深度会话。客户完整解压后双击 `启动网络检测.cmd`，保持报错时的网络与代理设置；完成后打开 HTML 检查，再将同名报告 ZIP 手动回传。

不读取 BeefTV 配置、API Key、代理密码、电脑名、MAC、项目或客户素材，不调用生成接口，不修改系统设置，不自动上传报告。图片在内存中合成。Windows 可能提示未签名程序；它不是正式安装包或应用更新，客服应提供 SHA256。

## 覆盖与边界

- 对照 BeefTV 当前线路与不使用 HTTP 代理的线路，基础采样默认三轮，可选 1 到 5 轮。
- 记录 UTC 时间、检测/支持编号、用户填写的办公网点、网络说明和 BeefTV 版本、Windows build、代理来源、HTTP 状态、响应 API/COS request ID、DNS/TCP/TLS/首字节/总耗时。DNS 超时保留 DNS 阶段；代理线路标明目标 DNS 未在本机观测。
- 有有效会话时，每种线路分别 PUT 约 197 KB / 3.15 MB 合成 PNG，HEAD 确认后完整 GET，比对长度及 SHA256。PUT 只发一次；回执不确定时先检查同一对象，不重新提交生成。
- 结束时 DELETE 四个精确对象，再 HEAD 确认当前不存在。客服仍须在 PUT 到期后按原始收据再次清理。
- 默认不记录 IP。客户输入 Y 同意后，才通过 `https://enterprise.beefapi.com/cdn-cgi/trace`（Cloudflare 提供）查询两种线路的公网出口，并记录公网 DNS 答案、公网连接目标及 IPv4/IPv6。仅解析 `ip/loc/colo`，不保存原始响应，不推断运营商；运营商/办公网说明来自客户填写。
- 主要连接阶段及每次操作后更新 JSON。Ctrl+C 后尝试清理并导出 partial 报告；强杀后可回传最后 JSON，`running` 和未完成步骤不能当成功。

基础 HTTP 401/403 表示收到 HTTPS 响应，不代表登录、上传或生成成功。直连不能绕过 VPN/TUN；工具与当前 BeefTV 一样不执行 PAC/WPAD。代理目标 DNS 可能由远端执行，本机未观测不代表失败。

客户端到 COS 成功不能证明 API 服务器转存、广州校验服务、供应商下载 COS、业务上传完成接口或生成链路正常。报告明确列出这些未测环节；须用时间、请求编号和 session ID 关联服务端及供应商日志。一次检测不能保证未来持续连通。

## 时间、流量与报告

工作最多 150 秒，另留最多 25 秒清理；首轮基础和深度传输分别有子期限。慢网络可导致部分采样未测，报告保留完成次数。单请求最多 20 秒，TCP 8 秒、TLS 10 秒；不跟随重定向，校验 TLS 证书。

应用层上下行累计上限 24 MiB，包含失败请求已交给传输层的 body 和已读响应。上传计数不能证明网络已确认传出；上限不含协议头、TLS 和重传，**不是云端费用硬封顶**。正常四组图片上传与完整回读约 13.4 MB。

最终 ZIP 只含 HTML、TXT、JSON；不含会话、签名 URL、请求/响应体或原始错误。IP 关闭时不输出解析/peer IP。报告含用户填写的信息及可选公网 IP，发送前由客户检查；客服按授权范围保存和使用。

## 客服短期会话与清理

`backend/cmd/connectivity-session` 仅在受控支持环境运行，**不放进客户工具包**。不新增公开上传 API，不修改生产服务、桶配置或权限。

1. 存储凭据仅经 stdin 进入内存：JSON 字段为 `access_key_id`、`secret_access_key`、可选 `session_token`。不要写在命令行、聊天、仓库或客户机器上。需要固定桶的 GetBucketVersioning 和诊断精确对象的写、读、删权限，不需要列桶或修改配置权限。
2. 先只读查询桶版本控制；仅支持从未开启的桶。开启、暂停、未知或无权限均停止，不能自动改配置；版本化会破坏禁止覆盖与普通删除的前提。
3. 生成随机 ID，固定四个 key：`transient/diagnostics/v1/<id>/<beeftv|direct>/<small|large>.png`。每个 key 仅签 PUT/HEAD/GET/DELETE。PUT 签入 Content-Length、Content-MD5、Content-Type、`x-cos-forbid-overwrite:true`，默认 20 分钟、最长 30 分钟。
4. 先将无签名 URL 的清理收据保存到客服私有目录，再输出会话，两者均不覆盖。只将 `session.json` 加入该企业临时包，提醒及时运行；通用公开包不带会话。
5. 会话缺失、过期、编号不符或篡改时仅基础检测，深度明确未测。客户端限制官方 COS host、固定路径/方法/请求头/大小和到期时间，不接受任意上传地址。
6. 无论客户是否完成，收据保持 pending。PUT 到期并再等至少一分钟后，用**客服原始收据**与固定 bucket/region 最终清理。仅重建四个精确 key，不 ListBucket、整前缀删除或接受客户返回的删除 URL。逐个 DELETE + HEAD 404 后才确认收据；失败保留 pending 继续处理。

签名 URL 是可重复使用的 bearer 能力，不是一次性票据。禁止覆盖不能阻止 DELETE 后重建，客户端当前清理不能代替到期后复查。异常重放或超出工具期限的在途写入仍需后续核查，不能承诺永久不存在。不要随报告转发会话，也不要假设诊断前缀已有生命周期清理。

示例（凭据由受控流程送入 stdin）：

```sh
connectivity-session -mode issue -bucket YOUR_BUCKET -region ap-guangzhou \
  -case SUPPORT-123 -ttl 20m -session /private/case/session.json \
  -receipt /private/support/cleanup-SUPPORT-123.json

# cleanup_after 到期后以同样的安全 stdin 方式传凭据
connectivity-session -mode cleanup -bucket YOUR_BUCKET -region ap-guangzhou \
  -receipt /private/support/cleanup-SUPPORT-123.json
```

## 配置与验证

`targets.json` 最多四个 HTTPS 目标，只支持 `/`、`/v1/videos`、`/api/status`，禁止凭据、查询参数、片段和非 443 端口。填客户实际入口和实际桶域名，不能用 COS 官网代替。

```json
{"targets":[{"name":"企业 API","url":"https://enterprise.beefapi.com/api/status"},{"name":"广州 COS","url":"https://YOUR_BUCKET.cos.ap-guangzhou.myqcloud.com/"}]}
```

```sh
cd backend
go test -race ./internal/networkcheck ./internal/desktopnet ./cmd/connectivity-check ./cmd/connectivity-session
cd ..
python3 scripts/build-connectivity-check.py --output /private/tool-output --cos-host YOUR_BUCKET.cos.ap-guangzhou.myqcloud.com
```

CLI 支持 `-config`、`-out`、`-session`、`-case`、`-site`、`-network`、`-beeftv-version`、`-rounds`。受控自动验证可用 `-interactive=false -pause=false`；IP 仍默认关闭，显式 `-consent-ip=true` 才开启。
