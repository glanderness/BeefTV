package app

import "infinite-canvas/backend/internal/diagnostics"

type DiagnosticClientEvent = diagnostics.ClientEvent
type DiagnosticRuntime = diagnostics.Runtime
type DiagnosticExportRequest = diagnostics.ExportRequest
type DiagnosticPreview = diagnostics.Preview
type DiagnosticBundle = diagnostics.Bundle

type diagnosticBrand struct {
	svc *Service
}

func (b diagnosticBrand) NameAndSlug() (string, string) {
	if b.svc == nil {
		return "", ""
	}
	return b.svc.appearanceIdentity()
}

func (s *Service) DiagnosticsDomain() *diagnostics.Service {
	if s == nil {
		return diagnostics.New(diagnostics.Dependencies{})
	}
	s.diagnosticsOnce.Do(func() {
		s.diagnostics = diagnostics.New(diagnostics.Dependencies{Store: s.repo, Brand: diagnosticBrand{svc: s}})
	})
	return s.diagnostics
}

func (s *Service) PreviewDiagnosticBundle(userID string, req DiagnosticExportRequest) (*DiagnosticPreview, error) {
	return s.DiagnosticsDomain().Preview(userID, req)
}

func (s *Service) ExportDiagnosticBundle(userID string, req DiagnosticExportRequest) (*DiagnosticBundle, error) {
	return s.DiagnosticsDomain().Export(userID, req)
}
