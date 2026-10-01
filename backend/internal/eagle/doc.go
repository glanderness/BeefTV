package eagle

// Package eagle owns the local Eagle HTTP protocol and filesystem path jail.
// The connector is an explicit user-local trust of 127.0.0.1/localhost/::1:41595.
// Callers must not reuse this client for general outbound HTTP.
// This package must not import internal/app.
