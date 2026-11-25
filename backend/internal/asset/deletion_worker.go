package asset

import (
	"context"
	"errors"
	"log"
	"math"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const resourceDeletionLease = 2 * time.Minute
const incompleteResourceRetention = time.Hour
const detachedReadyResourceRetention = 24 * time.Hour

var deletionRetryBase = 15 * time.Second
var detachedBusyRetryBase = 15 * time.Second
var detachedBusyRetryMax = 5 * time.Minute
var startupCleanupDelay = 20 * time.Second
var startupCleanupAfter = func(delay time.Duration) (<-chan time.Time, func()) {
	timer := time.NewTimer(delay)
	return timer.C, func() { timer.Stop() }
}

func stopTimer(timer *time.Timer) {
	if timer == nil {
		return
	}
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}

func resetTimer(timer **time.Timer, delay time.Duration) <-chan time.Time {
	if delay <= 0 {
		stopTimer(*timer)
		return nil
	}
	if *timer == nil {
		*timer = time.NewTimer(delay)
	} else {
		stopTimer(*timer)
		(*timer).Reset(delay)
	}
	return (*timer).C
}

func (s *Service) signalDeletionWorker() {
	if s == nil || s.deletionWake == nil {
		return
	}
	select {
	case s.deletionWake <- struct{}{}:
	default:
	}
}

func (s *Service) StartDeletionWorker(ctx context.Context, loop func(func(context.Context)) bool) {
	_ = ctx
	if loop == nil {
		return
	}
	loop(func(ctx context.Context) {
		var retryTimer *time.Timer
		var retryC <-chan time.Time
		defer func() { stopTimer(retryTimer) }()

		armRetry := func(delay time.Duration) {
			retryC = resetTimer(&retryTimer, delay)
		}

		runDrain := func() {
			more, _, drainErr := s.drainDeletionJobs(32)
			if drainErr != nil {
				armRetry(deletionRetryBase)
				return
			}
			if more {
				armRetry(50 * time.Millisecond)
				return
			}
			if s.repo == nil {
				armRetry(0)
				return
			}
			nextAt, err := s.repo.NextResourceDeletionWakeAt()
			if err != nil {
				log.Printf("resource deletion worker next-wake query failed: %v", err)
				armRetry(deletionRetryBase)
				return
			}
			if nextAt == nil {
				armRetry(0)
				return
			}
			delay := time.Until(*nextAt)
			if delay < 10*time.Millisecond {
				delay = 10 * time.Millisecond
			}
			armRetry(delay)
		}

		var cleanupRetryTimer *time.Timer
		var cleanupRetryC <-chan time.Time
		var cleanupBusyAttempts int
		defer func() { stopTimer(cleanupRetryTimer) }()

		armCleanupRetry := func() {
			cleanupBusyAttempts++
			delay := detachedBusyRetryBase
			for i := 1; i < cleanupBusyAttempts && delay < detachedBusyRetryMax; i++ {
				delay *= 2
			}
			if delay > detachedBusyRetryMax {
				delay = detachedBusyRetryMax
			}
			if delay <= 0 {
				delay = 10 * time.Millisecond
			}
			cleanupRetryC = resetTimer(&cleanupRetryTimer, delay)
		}

		runMaintenance := func() {
			s.CleanupExpiredArchivedAssets()
			if s.cleanupDetachedResources() {
				armCleanupRetry()
				return
			}
			cleanupBusyAttempts = 0
			cleanupRetryC = resetTimer(&cleanupRetryTimer, 0)
		}

		runDrain()
		// Defer full-workspace archive/orphan scans past the initial startup
		// window so the single SQLite connection stays free for UI bootstrap.
		var startupCleanupC <-chan time.Time
		if startupCleanupDelay > 0 {
			var stopStartupCleanup func()
			startupCleanupC, stopStartupCleanup = startupCleanupAfter(startupCleanupDelay)
			defer stopStartupCleanup()
		} else {
			runMaintenance()
		}
		hourlyTicker := time.NewTicker(time.Hour)
		defer hourlyTicker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-s.deletionWake:
				runDrain()
			case <-retryC:
				retryC = nil
				runDrain()
			case <-startupCleanupC:
				startupCleanupC = nil
				runMaintenance()
			case <-cleanupRetryC:
				cleanupRetryC = nil
				if s.cleanupDetachedResources() {
					armCleanupRetry()
				} else {
					cleanupBusyAttempts = 0
				}
			case <-hourlyTicker.C:
				runDrain()
				runMaintenance()
			}
		}
	})
}

func (s *Service) CleanupDetachedResources() {
	_ = s.cleanupDetachedResources()
}

func (s *Service) cleanupDetachedResources() bool {
	if s == nil || s.repo == nil {
		return false
	}
	now := time.Now()
	candidates, err := s.repo.ResourceCleanupCandidates(
		now.Add(-incompleteResourceRetention),
		now.Add(-detachedReadyResourceRetention),
		500,
	)
	if err != nil {
		log.Printf("detached resource cleanup query failed: %v", err)
		return false
	}
	byUser := map[string][]model.Resource{}
	for _, resource := range candidates {
		byUser[resource.UserID] = append(byUser[resource.UserID], resource)
	}
	deferred := false
	for userID, resources := range byUser {
		if err := s.CleanupDetachedUserResources(userID, resources); err != nil {
			if errors.Is(err, repository.ErrResourceCleanupSnapshotStale) {
				log.Printf("detached resource cleanup deferred for user %s: workspace busy", userID)
				deferred = true
				continue
			}
			log.Printf("detached resource cleanup failed for user %s: %v", userID, err)
		}
	}
	return deferred
}

func (s *Service) CleanupDetachedUserResources(userID string, candidates []model.Resource) error {
	if s == nil || s.repo == nil {
		return ResourceMissing()
	}
	if len(candidates) == 0 {
		return nil
	}
	// Run the read-only chunked snapshot scan outside storageMu so canvas saves
	// and asset writes are never blocked. DeleteDetachedResources verifies the
	// snapshot watermark under BEGIN IMMEDIATE and exits immediately with
	// ErrResourceCleanupSnapshotStale on concurrent writes so the worker loop
	// can back off and retry later instead of holding locks during a scan.
	resourceIDs := make([]string, 0, len(candidates))
	candidateSet := make(map[string]struct{}, len(candidates))
	for _, resource := range candidates {
		resourceIDs = append(resourceIDs, resource.ID)
		candidateSet[resource.ID] = struct{}{}
	}
	snapshot, err := s.repo.ResourceReferenceSnapshot(userID, "", resourceIDs)
	if err != nil {
		return err
	}
	referenced := map[string]struct{}{}
	if s.lifecycle != nil {
		for resourceID := range s.lifecycle.AppearanceReferencedIDs(resourceIDs) {
			referenced[resourceID] = struct{}{}
		}
	}
	for _, reference := range snapshot.Direct {
		if _, exists := candidateSet[reference.ResourceID]; exists {
			referenced[reference.ResourceID] = struct{}{}
		}
	}
	for _, document := range snapshot.Documents {
		if document.PrimaryMatchedIDs != nil || document.SecondaryMatchedIDs != nil {
			for _, resourceID := range document.PrimaryMatchedIDs {
				if _, exists := candidateSet[resourceID]; exists {
					referenced[resourceID] = struct{}{}
				}
			}
			for _, resourceID := range document.SecondaryMatchedIDs {
				if _, exists := candidateSet[resourceID]; exists {
					referenced[resourceID] = struct{}{}
				}
			}
			continue
		}
		for resourceID := range assets.DocumentReferencedIDs(document.PrimaryJSON, candidateSet) {
			referenced[resourceID] = struct{}{}
		}
		for resourceID := range assets.DocumentReferencedIDs(document.SecondaryJSON, candidateSet) {
			referenced[resourceID] = struct{}{}
		}
	}
	detached := make([]model.Resource, 0, len(candidates))
	for _, resource := range candidates {
		if _, exists := referenced[resource.ID]; !exists {
			detached = append(detached, resource)
		}
	}
	if len(detached) == 0 {
		return nil
	}
	var deletionJobs []model.ResourceDeletionJob
	commit := func() error {
		if s.lifecycle != nil {
			detachedIDs := make([]string, 0, len(detached))
			for _, resource := range detached {
				detachedIDs = append(detachedIDs, resource.ID)
			}
			appearanceRefs := s.lifecycle.AppearanceReferencedIDs(detachedIDs)
			if len(appearanceRefs) > 0 {
				filtered := make([]model.Resource, 0, len(detached))
				for _, resource := range detached {
					if _, exists := appearanceRefs[resource.ID]; !exists {
						filtered = append(filtered, resource)
					}
				}
				detached = filtered
			}
		}
		if len(detached) == 0 {
			return nil
		}
		detachedIDs := make([]string, 0, len(detached))
		for _, resource := range detached {
			detachedIDs = append(detachedIDs, resource.ID)
		}
		physicalObjects := map[string]*model.Resource{}
		for index := range detached {
			resource := &detached[index]
			if strings.TrimSpace(resource.ObjectKey) == "" {
				continue
			}
			sharedCount, countErr := s.repo.ResourceStorageReferenceCount(resource, detachedIDs)
			if countErr != nil {
				return countErr
			}
			if sharedCount == 0 {
				physicalObjects[StorageIdentity(resource)] = resource
			}
		}
		deletionJobs = DeletionJobs(userID, physicalObjects)
		return s.repo.DeleteDetachedResources(detached, deletionJobs, snapshot.Watermark)
	}
	var commitErr error
	if s.lifecycle != nil {
		commitErr = s.lifecycle.WithStorageLock(commit)
	} else {
		commitErr = commit()
	}
	if commitErr != nil {
		return commitErr
	}
	if len(detached) == 0 {
		return nil
	}
	log.Printf("detached resource cleanup: removed %d resource rows for user %s", len(detached), userID)
	if len(deletionJobs) > 0 {
		s.signalDeletionWorker()
		s.runBackground(func() { s.DrainDeletionJobs(len(deletionJobs)) })
	}
	return nil
}

func (s *Service) CleanupExpiredArchivedAssets() {
	if s == nil || s.lifecycle == nil {
		return
	}
	retentionDays, err := s.lifecycle.RecycleRetentionDays()
	if err != nil || retentionDays <= 0 {
		return
	}
	cutoff := time.Now().Add(-time.Duration(retentionDays) * 24 * time.Hour)
	expired, err := s.repo.FindExpiredArchivedAssets(cutoff, 100)
	if err != nil {
		log.Printf("expired archived assets query failed: %v", err)
		return
	}
	deleted := 0
	for _, asset := range expired {
		if err := s.lifecycle.DeleteUserAsset(asset.UserID, asset.ID); err != nil {
			log.Printf("expired archived asset delete failed for %s: %v", asset.ID, err)
			continue
		}
		deleted++
	}
	if deleted > 0 {
		log.Printf("recycle bin cleanup: deleted %d expired assets (retention: %d days)", deleted, retentionDays)
	}
}

func (s *Service) DrainDeletionJobs(limit int) {
	more, hasRetry, drainErr := s.drainDeletionJobs(limit)
	if more || hasRetry || drainErr != nil {
		s.signalDeletionWorker()
	}
}

func (s *Service) drainDeletionJobs(limit int) (bool, bool, error) {
	if s == nil || s.repo == nil || limit <= 0 {
		return false, false, nil
	}
	owner := s.workerID()
	hasRetry := false
	var firstErr error
	for index := 0; index < limit; index++ {
		job, err := s.repo.ClaimNextResourceDeletionJob(owner, resourceDeletionLease)
		if err != nil {
			log.Printf("resource deletion worker claim failed: %v", err)
			return false, hasRetry, err
		}
		if job == nil {
			return false, hasRetry, firstErr
		}
		if err := s.deleteOutboxObject(job); err != nil {
			hasRetry = true
			delay := deletionRetryDelay(job.Attempts)
			if retryErr := s.repo.RetryResourceDeletionJob(job.ID, owner, err.Error(), time.Now().Add(delay)); retryErr != nil {
				log.Printf("resource deletion worker retry update failed for %s: %v", job.ID, retryErr)
				if firstErr == nil {
					firstErr = retryErr
				}
			}
			continue
		}
		if err := s.repo.CompleteResourceDeletionJob(job.ID, owner); err != nil {
			log.Printf("resource deletion worker completion failed for %s: %v", job.ID, err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return true, hasRetry, firstErr
}

func deletionRetryDelay(attempts int) time.Duration {
	exponent := math.Min(float64(max(attempts-1, 0)), 8)
	return time.Duration(math.Pow(2, exponent)) * deletionRetryBase
}
