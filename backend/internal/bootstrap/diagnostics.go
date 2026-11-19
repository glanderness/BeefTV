package bootstrap

import (
	"errors"
	"time"

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

func (r *Runtime) RecordClientHeartbeat(hidden, busy bool) {
	if r == nil {
		return
	}
	r.clientHidden.Store(hidden)
	r.clientBusy.Store(busy)
	r.lastClientHeartbeat.Store(time.Now().UTC().UnixMilli())
}

func (r *Runtime) LastClientHeartbeat() (time.Time, bool, bool) {
	if r == nil {
		return time.Time{}, false, false
	}
	ms := r.lastClientHeartbeat.Load()
	if ms <= 0 {
		return time.Time{}, false, false
	}
	return time.UnixMilli(ms).UTC(), r.clientHidden.Load(), r.clientBusy.Load()
}
