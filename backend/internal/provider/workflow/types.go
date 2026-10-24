package workflow

import (
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

// Config is the workflow-needed slice of providerConfig. Shared providerConfig
// remains owned by the provider worker; this is the mapping seam.
type Config struct {
	InterfaceType         string
	BaseURL               string
	APIKey                string
	Headers               []outbound.OutboundHeader
	Model                 string
	Size                  string
	Quality               string
	TransparentBackground string
	Count                 string
	VideoSeconds          string
	VQuality              string
	VideoGenerateAudio    string
	VideoWatermark        string
	AudioVoice            string
	AudioFormat           string
	AudioSpeed            string
	AudioInstructions     string
	SystemPrompt          string
	WorkflowID            string
	WebappID              string
	WorkflowJSON          map[string]interface{}
	WorkflowFields        []Field
	RunningHubUploadKey   string
	AuthType              string
	AuthHeader            string
	NegativePrompt        string
	Seed                  string
	ComfyUI               *ComfyWorkflow
}

// ComfyWorkflow 是待扩展宿主接入的协议配置，不注册内置渠道或持久化格式。
type ComfyWorkflow struct {
	Graph        map[string]any `json:"graph"`
	Fields       []Field        `json:"fields"`
	OutputNodeID string         `json:"outputNodeId"`
	OutputField  string         `json:"outputField"`
}

// Media is the workflow-needed slice of providerMedia.
type Media struct {
	ID       string
	Name     string
	Type     string
	DataURL  string
	URL      string
	MimeType string
}

// Input is the workflow-needed slice of canvasGenerationInput.
type Input struct {
	Mode             string
	Prompt           string
	Config           Config
	ReferenceImages  []Media
	ReferenceVideos  []Media
	ReferenceAudios  []Media
	Mask             *Media
	ResumedRequestID string
	LocalWorkspace   bool
	ClientID         string
}

// FetchRequest is the exported workflow-settings fetch contract.
type FetchRequest struct {
	BaseURL      string `json:"baseUrl"`
	APIKey       string `json:"apiKey"`
	WalletAPIKey string `json:"walletApiKey"`
	UseWallet    bool   `json:"useWallet"`
	WorkflowID   string `json:"workflowId"`
	WebappID     string `json:"webappId,omitempty"`
	Title        string `json:"title,omitempty"`
	Capability   string `json:"capability,omitempty"`
}

// IsRunningHubInterface reports whether the channel interface is a RunningHub workflow.
func IsRunningHubInterface(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case string(model.ChannelInterfaceRunningHubImage),
		string(model.ChannelInterfaceRunningHubVideo),
		string(model.ChannelInterfaceRunningHubAudio):
		return true
	default:
		return false
	}
}

// IsProviderInterface reports whether the interface is a workflow provider.
func IsProviderInterface(value string) bool {
	return IsRunningHubInterface(value)
}

func isRunningHubInterface(value string) bool {
	return IsRunningHubInterface(value)
}

func isWorkflowProviderInterface(value string) bool {
	return IsProviderInterface(value)
}

func workflowInterfaceSupportsMode(interfaceType string, mode string) bool {
	switch mode {
	case "image":
		return interfaceType == string(model.ChannelInterfaceRunningHubImage)
	case "video":
		return interfaceType == string(model.ChannelInterfaceRunningHubVideo)
	case "audio":
		return interfaceType == string(model.ChannelInterfaceRunningHubAudio)
	default:
		return false
	}
}

// ValidateConfig checks mode, interface, API key, outbound URL, and workflow identity.
func ValidateConfig(mode string, config Config) error {
	if mode != "image" && mode != "video" && mode != "audio" {
		return errf("工作流协议暂不支持%s生成", mode)
	}
	interfaceType := strings.ToLower(strings.TrimSpace(config.InterfaceType))
	if !workflowInterfaceSupportsMode(interfaceType, mode) {
		return errf("接口类型 %s 不支持%s生成", config.InterfaceType, mode)
	}
	if isRunningHubInterface(config.InterfaceType) {
		if APIKey(config) == "" {
			return errText("RunningHub 工作流缺少积分 API Key")
		}
		if _, err := outbound.ValidateOutboundURL(RootURL(config.BaseURL)); err != nil {
			return err
		}
		if strings.TrimSpace(config.WorkflowID) == "" && strings.TrimSpace(config.WebappID) == "" && strings.TrimSpace(config.Model) == "" {
			return errText("RunningHub 缺少 workflowId 或 webappId")
		}
		return nil
	}
	return errText("未知工作流协议")
}
