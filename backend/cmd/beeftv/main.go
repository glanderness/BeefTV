// beeftv 是 BeefTV 的常规命令行入口：与内置 pi、MCP 共用同一套业务操作层，
// 连接同一个正在运行的本地工作区，不各自打开数据库或另起 worker。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpStartupTimeout = 5 * time.Second

// 退出码：机器可读的失败分类，stderr 输出诊断，stdout 只放业务结果。
const (
	exitOK               = 0
	exitInternal         = 1
	exitUsage            = 2
	exitNotFound         = 3
	exitConflict         = 4
	exitPrecondition     = 5
	exitForbidden        = 6
	exitUnsupported      = 7
	exitBadRequest       = 8
	exitTransportFailure = 9
)

type cliError struct {
	code    int
	reason  string
	msg     string
	details map[string]any
}

func (e *cliError) Error() string { return fmt.Sprintf("%s: %s", e.reason, e.msg) }

// machineError 是可被客户端解析的失败结构（CLI --json 与 MCP 错误共用同一形状）。
func (e *cliError) machineError() map[string]any {
	payload := map[string]any{"code": e.code, "reason": e.reason, "message": e.msg}
	if len(e.details) > 0 {
		payload["details"] = e.details
	}
	return payload
}

func main() {
	args := os.Args[1:]
	if err := run(args); err != nil {
		code := exitInternal
		payload := map[string]any{"code": code, "reason": "internal_error", "message": err.Error()}
		var cliErr *cliError
		if ok := asCLIError(err, &cliErr); ok {
			code = cliErr.code
			payload = cliErr.machineError()
		}
		payload["exitCode"] = code
		if wantsJSON(args) && !(len(args) > 0 && args[0] == "mcp") {
			// --json 时失败也要机器可读：结构写 stdout，人话留 stderr。
			if encoded, marshalErr := json.Marshal(payload); marshalErr == nil {
				fmt.Println(string(encoded))
			}
		}
		fmt.Fprintf(os.Stderr, "beeftv: %v\n", err)
		os.Exit(code)
	}
	os.Exit(exitOK)
}

// wantsJSON 判断本次调用是否要求 JSON 输出（用于失败路径也给出机器可读结构）。
func wantsJSON(args []string) bool {
	for _, arg := range args {
		if arg == "--json" || arg == "-json" {
			return true
		}
	}
	return false
}

func asCLIError(err error, target **cliError) bool {
	if e, ok := err.(*cliError); ok {
		*target = e
		return true
	}
	return false
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return &cliError{code: exitUsage, reason: "missing_command", msg: "需要一个子命令"}
	}
	// 顶层 --help/-h 与各子命令一致：打印用法后正常退出。
	if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		usage()
		return nil
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	switch args[0] {
	case "ops":
		fs := flag.NewFlagSet("ops", flag.ContinueOnError)
		readOnly := fs.Bool("read-only", false, "只列出只读操作")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		ops, err := c.listOps(*readOnly)
		if err != nil {
			return err
		}
		if *jsonOut {
			return emitJSON(ops)
		}
		for _, op := range ops {
			kind := "write"
			if op.ReadOnly {
				kind = "read "
			}
			fmt.Printf("%-24s %s  scope=%s  %s\n", op.ID, kind, op.Scope, op.Summary)
		}
		return nil
	case "canvas":
		return runCanvas(c, args[1:])
	case "asset":
		return runAsset(c, args[1:])
	case "task":
		return runTask(c, args[1:])
	case "client":
		return runClient(c, args[1:])
	case "mcp":
		return runMCP(c, args[1:])
	default:
		usage()
		return &cliError{code: exitUsage, reason: "unknown_command", msg: "未知子命令: " + args[0]}
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `beeftv — BeefTV 业务操作命令行（连接正在运行的本地工作区）

  beeftv ops [--read-only] [--json]
  beeftv canvas get --canvas <id> [--json]
  beeftv canvas search [--query <q>] [--page N] [--page-size N] [--json]
  beeftv canvas node update --canvas <id> --node <id> --expected-revision N [--title T] [--prompt P] [--content C] --op-id <id>
  beeftv canvas nodes create --canvas <id> --expected-revision N --node <title:type[:prompt]>... --op-id <id>
  beeftv canvas edge create --canvas <id> --from <nodeId> --to <nodeId> --expected-revision N --op-id <id>
  beeftv asset list [--query <q>] [--kind <kind>] [--favorite] [--recent] [--project <name>] [--generated] [--json]
  beeftv asset get --asset <id> [--json]
  beeftv task get --task <id> [--json]
  beeftv client register --label <label> --mode read-only|read-write [--kind codex|claude|cursor|other]
  beeftv mcp serve [--read-only]

连接哪个工作区：不设 BEEFTV_BASE_URL 时自动连正在运行的 BeefTV 桌面应用，端口是动态的。
BEEFTV_DATA_DIR 可以指向非默认数据目录。Windows 从用户目录下 .beeftv/runtime 读取对应
工作区的运行信息，其他平台读取数据目录里的 runtime.json。升级后请重新打开 BeefTV。
工作区重启换端口后，运行中的 CLI/MCP 进程会在下一次操作时自动重连新地址，
不需要重启会话；显式设置 BEEFTV_BASE_URL 时不做自动切换。

凭据：在 BeefTV 的设置里新建一个客户端，把它给出的 BEEFTV_CLIENT_ID 与 BEEFTV_CLIENT_TOKEN
填进环境变量即可，不需要桌面令牌。读写权限在新建时就定下来，客户端自己改不了。

写操作必须带幂等键（CLI 的 --op-id，MCP 工具参数里的 operationId）：重试同一操作要复用同一个值。

环境变量：BEEFTV_BASE_URL、BEEFTV_DATA_DIR、BEEFTV_CLIENT_ID、BEEFTV_CLIENT_TOKEN、
BEEFTV_OWNER_TOKEN（owner 可信通道）、BEEFTV_DESKTOP_TOKEN（桌面自身调用）
退出码：0 成功；2 用法；3 未找到；4 冲突；5 前置条件；6 只读/未授权；7 不支持；8 参数；9 连接失败；1 内部
`)
}

func emitJSON(value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return &cliError{code: exitInternal, reason: "encode_failed", msg: err.Error()}
	}
	fmt.Println(string(encoded))
	return nil
}

func runMCP(c *client, args []string) error {
	if len(args) == 0 || args[0] != "serve" {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "mcp 需要 serve"}
	}
	fs := flag.NewFlagSet("mcp serve", flag.ContinueOnError)
	readOnly := fs.Bool("read-only", false, "只暴露只读工具")
	if err := fs.Parse(args[1:]); err != nil {
		return flagError(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	startupCtx, cancel := context.WithTimeout(ctx, mcpStartupTimeout)
	ops, err := c.listOpsCtx(startupCtx, *readOnly)
	timedOut := errors.Is(startupCtx.Err(), context.DeadlineExceeded)
	cancel()
	if timedOut {
		return &cliError{code: exitTransportFailure, reason: "mcp_startup_timeout", msg: "连接 BeefTV 工作区超过 5 秒，请确认 BeefTV 已启动且工作区可以访问"}
	}
	if err != nil {
		return err
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "beeftv", Version: "1.0.0"}, nil)
	for _, op := range ops {
		descriptor := op
		server.AddTool(&mcp.Tool{Name: descriptor.ID, Description: descriptor.Summary, InputSchema: descriptor.Params,
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: descriptor.ReadOnly}},
			func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				args := map[string]any{}
				if req.Params != nil && req.Params.Arguments != nil {
					raw, err := json.Marshal(req.Params.Arguments)
					if err != nil {
						return toolError(&cliError{code: exitBadRequest, reason: "invalid_arguments", msg: err.Error()}), nil
					}
					if err := json.Unmarshal(raw, &args); err != nil {
						return toolError(&cliError{code: exitBadRequest, reason: "invalid_arguments", msg: err.Error()}), nil
					}
				}
				requestID := ""
				if !descriptor.ReadOnly {
					// 写操作必须由调用方给出稳定幂等键：模型重试同一操作要复用同一个值。
					value, _ := args["operationId"].(string)
					requestID = strings.TrimSpace(value)
					if requestID == "" {
						return toolError(&cliError{code: exitBadRequest, reason: "missing_operation_id",
							msg: "写操作必须在参数里提供 operationId，并在重试时复用同一个值"}), nil
					}
				}
				delete(args, "operationId")
				delete(args, "opId")
				params, err := json.Marshal(args)
				if err != nil {
					return toolError(&cliError{code: exitInternal, reason: "encode_failed", msg: err.Error()}), nil
				}
				result, err := c.callOpCtx(ctx, descriptor.ID, requestID, params)
				if err != nil {
					return toolError(err), nil
				}
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(result)}}}, nil
			})
	}
	// 诊断用 client 记录的快照：工作区重启换端口后地址会被刷新，不在这里重复发现。
	base, baseSource := c.baseURLInfo()
	fmt.Fprintf(os.Stderr, "beeftv mcp serve: %d 个工具，base=%s（%s），client=%s\n", len(ops), base, baseSource, orNone(c.clientID))
	return server.Run(ctx, &mcp.StdioTransport{})
}

func orNone(value string) string {
	if value == "" {
		return "(未登记的本机调用)"
	}
	return value
}

// toolError 把失败以结构化 JSON 返回，模型可以按 code/reason 决定是否重试或澄清。
func toolError(err error) *mcp.CallToolResult {
	payload := map[string]any{"reason": "operation_failed", "message": err.Error()}
	if cliErr, ok := err.(*cliError); ok {
		payload = cliErr.machineError()
	}
	encoded, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		encoded = []byte(`{"reason":"operation_failed"}`)
	}
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(encoded)}}}
}
