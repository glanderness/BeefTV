package bootstrap

import (
	"errors"

	"infinite-canvas/backend/internal/diagnostics"
)

// ExportDiagnosticsBundle builds a full runtime diagnostic bundle directly in
// Go without traversing HTTP or renderer memory.
func (r *Runtime) ExportDiagnosticsBundle(req diagnostics.ExportRequest) (*diagnostics.Bundle, error) {
	if r == nil || r.service == nil {
		return nil, errors.New("本地后端尚未就绪")
	}
	owner, err := r.service.LocalWorkspaceOwner()
	if err != nil || owner == nil {
		if err == nil {
			err = errors.New("本地工作区尚未初始化")
		}
		return nil, err
	}
	return r.service.DiagnosticsDomain().Export(owner.ID, req)
}

func (r *Runtime) RequestSafeMode(enabled bool) {
	if r == nil {
		return
	}
	r.safeModeRequested.Store(enabled)
}

func (r *Runtime) SafeModeRequested() bool {
	return r != nil && r.safeModeRequested.Load()
}

// ConsumeSafeMode reads and clears a one-shot safe-mode request when the
// reloaded renderer queries StartupState().
func (r *Runtime) ConsumeSafeMode() bool {
	if r == nil {
		return false
	}
	return r.safeModeRequested.Swap(false)
}
