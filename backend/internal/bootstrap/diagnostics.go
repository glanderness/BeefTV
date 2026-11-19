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
	nowMs := time.Now().UTC().UnixMilli()
	r.clientHidden.Store(hidden)
	if busy {
		if !r.clientBusy.Swap(true) || r.clientBusySince.Load() == 0 {
			r.clientBusySince.Store(nowMs)
		}
	} else {
		r.clientBusy.Store(false)
		r.clientBusySince.Store(0)
	}
	r.lastClientHeartbeat.Store(nowMs)
}

func (r *Runtime) LastClientHeartbeat() (time.Time, bool, bool, time.Time) {
	if r == nil {
		return time.Time{}, false, false, time.Time{}
	}
	ms := r.lastClientHeartbeat.Load()
	if ms <= 0 {
		return time.Time{}, false, false, time.Time{}
	}
	var busySince time.Time
	if busyMs := r.clientBusySince.Load(); busyMs > 0 {
		busySince = time.UnixMilli(busyMs).UTC()
	}
	return time.UnixMilli(ms).UTC(), r.clientHidden.Load(), r.clientBusy.Load(), busySince
}

func (r *Runtime) RequestSafeMode(enabled bool) {
	if r == nil {
		return
	}
	r.safeModeRequested.Store(enabled)
}

func (r *Runtime) SafeModeRequested() bool {
	if r == nil {
		return false
	}
	return r.safeModeRequested.Load()
}
