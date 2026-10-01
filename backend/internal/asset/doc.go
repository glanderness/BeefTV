// Package asset owns durable local resource storage: upload identity, staged
// file publication, SQLite metadata, range reads, and deletion with live
// reference guards. FileStore is the only filesystem owner. This package must
// not import internal/app.
package asset
