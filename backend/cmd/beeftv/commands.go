// canvas/asset/task/client 子命令：只做参数解析与结果呈现，业务一律走操作层 HTTP 请求。
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func runCanvas(c *client, args []string) error {
	if len(args) == 0 {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "canvas 需要 get|search|node|nodes|edge"}
	}
	switch args[0] {
	case "get":
		fs := flag.NewFlagSet("canvas get", flag.ContinueOnError)
		canvasID := fs.String("canvas", "", "画布 ID")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		if *canvasID == "" {
			return &cliError{code: exitUsage, reason: "missing_flag", msg: "--canvas 必填"}
		}
		raw, err := c.callOp("canvas.get", "", mustJSON(map[string]any{"canvasId": *canvasID}))
		if err != nil {
			return err
		}
		return printResult(raw, *jsonOut)
	case "search":
		fs := flag.NewFlagSet("canvas search", flag.ContinueOnError)
		query := fs.String("query", "", "搜索关键字")
		page := fs.Int("page", 1, "页码")
		pageSize := fs.Int("page-size", 20, "每页数量")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		raw, err := c.callOp("canvas.search", "", mustJSON(map[string]any{"query": *query, "page": *page, "pageSize": *pageSize}))
		if err != nil {
			return err
		}
		return printResult(raw, *jsonOut)
	case "node":
		if err := requireVerb("node", args, "update"); err != nil {
			return err
		}
		return runCanvasNodeUpdate(c, args[2:])
	case "nodes":
		if err := requireVerb("nodes", args, "create"); err != nil {
			return err
		}
		return runCanvasNodesCreate(c, args[2:])
	case "edge":
		if err := requireVerb("edge", args, "create"); err != nil {
			return err
		}
		return runCanvasEdgeCreate(c, args[2:])
	default:
		return &cliError{code: exitUsage, reason: "unknown_subcommand", msg: "未知的 canvas 子命令: " + args[0]}
	}
}

// requireVerb 校验二级子命令：缺失或未知动词直接按用法错误退出，绝不发 HTTP 请求。
func requireVerb(group string, args []string, verb string) error {
	if len(args) < 2 {
		return &cliError{code: exitUsage, reason: "missing_subcommand",
			msg: fmt.Sprintf("canvas %s 需要子命令 %s", group, verb)}
	}
	if args[1] != verb {
		return &cliError{code: exitUsage, reason: "unknown_subcommand",
			msg: fmt.Sprintf("未知的 canvas %s 子命令 %q（只支持 %s）", group, args[1], verb)}
	}
	return nil
}

// flagError 把 -h/--help 视为正常退出，其余解析失败按用法错误。
// 这里绝不能递归调用自己：非法 flag 会直接打爆栈，而不是给用户一条错误。
func flagError(err error) error {
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	return &cliError{code: exitUsage, reason: "bad_flags", msg: err.Error()}
}

func runCanvasNodeUpdate(c *client, args []string) error {
	fs := flag.NewFlagSet("canvas node update", flag.ContinueOnError)
	canvasID := fs.String("canvas", "", "画布 ID")
	nodeID := fs.String("node", "", "节点 ID")
	revision := fs.Int64("expected-revision", 0, "读取画布时的 revision（必填）")
	title := fs.String("title", "", "新标题")
	prompt := fs.String("prompt", "", "新的生成提示词")
	content := fs.String("content", "", "新的内容")
	opID := fs.String("op-id", "", "幂等键（必填）")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	if err := fs.Parse(args); err != nil {
		return flagError(err)
	}
	if *canvasID == "" || *nodeID == "" || *opID == "" || *revision <= 0 {
		return &cliError{code: exitUsage, reason: "missing_flag", msg: "--canvas/--node/--op-id/--expected-revision 均为必填"}
	}
	patch := map[string]any{}
	// 用「flags 是否出现」判断是否传参：显式传空串是清空语义，不允许用非空值猜测。
	fs.Visit(func(flagValue *flag.Flag) {
		switch flagValue.Name {
		case "title":
			patch["title"] = *title
		case "prompt":
			patch["prompt"] = *prompt
		case "content":
			patch["content"] = *content
		}
	})
	if len(patch) == 0 {
		return &cliError{code: exitUsage, reason: "empty_patch", msg: "至少要给出 --title/--prompt/--content 之一"}
	}
	raw, err := c.callOp("canvas.node.update", *opID, mustJSON(map[string]any{
		"canvasId": *canvasID, "nodeId": *nodeID, "expectedRevision": *revision, "patch": patch}))
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runCanvasNodesCreate(c *client, args []string) error {
	fs := flag.NewFlagSet("canvas nodes create", flag.ContinueOnError)
	canvasID := fs.String("canvas", "", "画布 ID")
	revision := fs.Int64("expected-revision", 0, "读取画布时的 revision（必填）")
	opID := fs.String("op-id", "", "幂等键（必填）")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	var specs stringList
	fs.Var(&specs, "node", "节点，格式 title:type[:prompt]，可重复")
	if err := fs.Parse(args); err != nil {
		return flagError(err)
	}
	if *canvasID == "" || *opID == "" || *revision <= 0 || len(specs) == 0 {
		return &cliError{code: exitUsage, reason: "missing_flag", msg: "--canvas/--op-id/--expected-revision/--node 必填"}
	}
	nodes := make([]map[string]any, 0, len(specs))
	for _, spec := range specs {
		parts := strings.SplitN(spec, ":", 3)
		if len(parts) < 2 {
			return &cliError{code: exitUsage, reason: "bad_node_spec", msg: "节点格式应为 title:type[:prompt]：" + spec}
		}
		node := map[string]any{"title": parts[0], "type": parts[1]}
		if len(parts) == 3 {
			node["prompt"] = parts[2]
		}
		nodes = append(nodes, node)
	}
	raw, err := c.callOp("canvas.nodes.create", *opID, mustJSON(map[string]any{
		"canvasId": *canvasID, "expectedRevision": *revision, "nodes": nodes}))
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runCanvasEdgeCreate(c *client, args []string) error {
	fs := flag.NewFlagSet("canvas edge create", flag.ContinueOnError)
	canvasID := fs.String("canvas", "", "画布 ID")
	from := fs.String("from", "", "起点节点 ID")
	to := fs.String("to", "", "终点节点 ID")
	revision := fs.Int64("expected-revision", 0, "读取画布时的 revision（必填）")
	opID := fs.String("op-id", "", "幂等键（必填）")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	if err := fs.Parse(args); err != nil {
		return flagError(err)
	}
	if *canvasID == "" || *from == "" || *to == "" || *opID == "" || *revision <= 0 {
		return &cliError{code: exitUsage, reason: "missing_flag", msg: "--canvas/--from/--to/--op-id/--expected-revision 必填"}
	}
	raw, err := c.callOp("canvas.edge.create", *opID, mustJSON(map[string]any{
		"canvasId": *canvasID, "fromNodeId": *from, "toNodeId": *to, "expectedRevision": *revision}))
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runAsset(c *client, args []string) error {
	if len(args) == 0 {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "asset 需要 list|get"}
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("asset list", flag.ContinueOnError)
		query := fs.String("query", "", "搜索关键字")
		kind := fs.String("kind", "", "素材类型")
		favorite := fs.Bool("favorite", false, "只列出收藏")
		recent := fs.Bool("recent", false, "只列出最近使用")
		project := fs.String("project", "", "项目来源")
		generated := fs.Bool("generated", false, "只列出生成历史")
		page := fs.Int("page", 1, "页码")
		pageSize := fs.Int("page-size", 40, "每页数量")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		raw, err := c.callOp("asset.list", "", mustJSON(map[string]any{
			"query": *query, "kind": *kind, "favorite": *favorite, "recent": *recent, "project": *project, "generated": *generated,
			"page": *page, "pageSize": *pageSize,
		}))
		if err != nil {
			return err
		}
		return printResult(raw, *jsonOut)
	case "get":
		fs := flag.NewFlagSet("asset get", flag.ContinueOnError)
		assetID := fs.String("asset", "", "素材 ID")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		if *assetID == "" {
			return &cliError{code: exitUsage, reason: "missing_flag", msg: "--asset 必填"}
		}
		raw, err := c.callOp("asset.get", "", mustJSON(map[string]any{"assetId": *assetID}))
		if err != nil {
			return err
		}
		return printResult(raw, *jsonOut)
	default:
		return &cliError{code: exitUsage, reason: "unknown_subcommand", msg: "未知的 asset 子命令: " + args[0]}
	}
}

func runTask(c *client, args []string) error {
	if len(args) == 0 || args[0] != "get" {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "task 需要 get"}
	}
	fs := flag.NewFlagSet("task get", flag.ContinueOnError)
	taskID := fs.String("task", "", "任务 ID")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	if err := fs.Parse(args[1:]); err != nil {
		return flagError(err)
	}
	if *taskID == "" {
		return &cliError{code: exitUsage, reason: "missing_flag", msg: "--task 必填"}
	}
	raw, err := c.callOp("task.get", "", mustJSON(map[string]any{"taskId": *taskID}))
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runClient(c *client, args []string) error {
	if len(args) == 0 || args[0] != "register" {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "client 需要 register"}
	}
	fs := flag.NewFlagSet("client register", flag.ContinueOnError)
	label := fs.String("label", "", "客户端名称")
	mode := fs.String("mode", "read-only", "read-only 或 read-write")
	kind := fs.String("kind", "other", "codex、claude、cursor 或 other")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	if err := fs.Parse(args[1:]); err != nil {
		return flagError(err)
	}
	raw, err := c.do(context.Background(), http.MethodPost, "/ops/clients", map[string]any{"label": *label, "mode": *mode, "kind": *kind})
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func printResult(raw json.RawMessage, jsonOut bool) error {
	if jsonOut {
		fmt.Println(string(raw))
		return nil
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, raw, "", "  "); err != nil {
		fmt.Println(string(raw))
		return nil
	}
	fmt.Println(pretty.String())
	return nil
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("{}")
	}
	return json.RawMessage(encoded)
}

func newRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("cli-%d", time.Now().UnixNano())
	}
	return "cli-" + hex.EncodeToString(buf)
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }

func (s *stringList) Set(value string) error {
	*s = append(*s, value)
	return nil
}
