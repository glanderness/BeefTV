package diagnostics

// Package diagnostics owns user-exported diagnostic ZIP bundles and secret
// redaction. Bundles contain a bounded, sanitized window of client events,
// tasks, task logs, and upstream call summaries. Request/response bodies stay
// out of the archive. This package must not import internal/app.
