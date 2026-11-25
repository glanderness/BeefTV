package repository

import (
	"database/sql"
	"reflect"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// SQLiteSnapshotWatermark is an opaque proof produced by
// ResourceReferenceSnapshot on a single-connection SQLite database. It binds
// SQLite's connection identity and change counters to the exact user and
// candidate set scanned so DeleteDetachedResources can safely skip redundant
// full-table re-scans when no SQLite writes occurred in between.
type SQLiteSnapshotWatermark struct {
	valid            bool
	userID           string
	excludingAssetID string
	verifiedIDs      map[string]struct{}
	rawConn          any
	dataVersion      int64
	schemaVersion    int64
	totalChanges     int64
}

// covers reports whether this watermark proves a complete (non-excluding)
// snapshot that scanned every resource in resources for the same user.
func (w SQLiteSnapshotWatermark) covers(resources []model.Resource) bool {
	if !w.valid || w.excludingAssetID != "" || w.userID == "" || len(resources) == 0 || len(w.verifiedIDs) == 0 {
		return false
	}
	for _, resource := range resources {
		if resource.UserID != w.userID {
			return false
		}
		if _, ok := w.verifiedIDs[resource.ID]; !ok {
			return false
		}
	}
	return true
}

func (r *Repository) captureSQLiteWatermark(db *gorm.DB, userID string, excludingAssetIDs []string, candidateSet map[string]struct{}) SQLiteSnapshotWatermark {
	if r == nil || !r.SingleProcess() || db == nil || db.Dialector == nil || db.Dialector.Name() != "sqlite" || r.HoldsTransaction() {
		return SQLiteSnapshotWatermark{}
	}
	if userID == "" || len(excludingAssetIDs) > 0 || len(candidateSet) == 0 {
		return SQLiteSnapshotWatermark{}
	}
	sqlDB, err := db.DB()
	if err != nil || sqlDB.Stats().MaxOpenConnections != 1 {
		return SQLiteSnapshotWatermark{}
	}
	var wm SQLiteSnapshotWatermark
	if err := db.Connection(func(conn *gorm.DB) error {
		wm = readSQLiteWatermark(conn)
		return nil
	}); err != nil || !wm.valid {
		return SQLiteSnapshotWatermark{}
	}
	verified := make(map[string]struct{}, len(candidateSet))
	for id := range candidateSet {
		verified[id] = struct{}{}
	}
	wm.userID = userID
	wm.verifiedIDs = verified
	return wm
}

func (r *Repository) watermarkMatchesTx(tx *gorm.DB, expected SQLiteSnapshotWatermark) bool {
	if !expected.valid || expected.rawConn == nil || r == nil || !r.SingleProcess() || tx == nil || tx.Dialector == nil || tx.Dialector.Name() != "sqlite" {
		return false
	}
	sqlDB, err := r.db.DB()
	if err != nil || sqlDB.Stats().MaxOpenConnections != 1 {
		return false
	}
	current := readSQLiteWatermark(tx)
	return current.valid &&
		current.rawConn == expected.rawConn &&
		current.dataVersion == expected.dataVersion &&
		current.schemaVersion == expected.schemaVersion &&
		current.totalChanges == expected.totalChanges
}

func readSQLiteWatermark(db *gorm.DB) SQLiteSnapshotWatermark {
	sqlConn := extractSQLConn(db)
	if sqlConn == nil {
		return SQLiteSnapshotWatermark{}
	}
	var rawConn any
	if err := sqlConn.Raw(func(driverConn any) error {
		if driverConn != nil && reflect.TypeOf(driverConn).Comparable() {
			rawConn = driverConn
		}
		return nil
	}); err != nil || rawConn == nil {
		return SQLiteSnapshotWatermark{}
	}
	var dataVersion int64
	if err := db.Raw("PRAGMA data_version").Scan(&dataVersion).Error; err != nil || dataVersion <= 0 {
		return SQLiteSnapshotWatermark{}
	}
	var schemaVersion int64
	if err := db.Raw("PRAGMA schema_version").Scan(&schemaVersion).Error; err != nil || schemaVersion < 0 {
		return SQLiteSnapshotWatermark{}
	}
	var totalChanges int64
	if err := db.Raw("SELECT total_changes()").Scan(&totalChanges).Error; err != nil || totalChanges < 0 {
		return SQLiteSnapshotWatermark{}
	}
	return SQLiteSnapshotWatermark{
		valid:         true,
		rawConn:       rawConn,
		dataVersion:   dataVersion,
		schemaVersion: schemaVersion,
		totalChanges:  totalChanges,
	}
}

func extractSQLConn(db *gorm.DB) *sql.Conn {
	if db == nil {
		return nil
	}
	if db.Statement != nil {
		if conn, ok := db.Statement.ConnPool.(*sql.Conn); ok && conn != nil {
			return conn
		}
	}
	if db.Config != nil {
		if conn, ok := db.Config.ConnPool.(*sql.Conn); ok && conn != nil {
			return conn
		}
	}
	return nil
}
