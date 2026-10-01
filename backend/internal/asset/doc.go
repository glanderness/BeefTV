// Package asset owns durable local resource storage: upload identity, staged
// file publication, SQLite metadata, range reads, and deletion with live
// reference guards. FileStore is the only filesystem owner. This package must
// not import internal/app.
//
// Store and RetryOwned are the canonical write seams. They serialize every
// Service that shares a FileStore root on user-scoped upload/resource keys,
// load persisted owner rows before mutation, and never trust a caller-supplied
// Resource. Generation adapters should call RetryOwned for FAILED/PENDING
// leftovers. A second handle cannot reclaim an in-flight PENDING write.
package asset
