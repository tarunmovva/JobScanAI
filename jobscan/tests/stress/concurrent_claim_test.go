package stress_test

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	appdb "jobscan/internal/db"
	"jobscan/internal/model"
)

// makeFreshDB creates a temporary SQLite database for each test.
func makeFreshDB(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := appdb.Open(path)
	if err != nil {
		t.Fatalf("makeFreshDB: Open error = %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// seedExtractedJobs creates `count` jobs, advances all to extracted state, and returns their apps.
func seedExtractedJobs(t *testing.T, db *sql.DB, count int, platform string) []model.Application {
	t.Helper()

	jobs := make([]model.Job, count)
	for i := 0; i < count; i++ {
		jobs[i] = model.Job{
			JobID:       fmt.Sprintf("stress-job-%d", i+1),
			Platform:    platform,
			CompanySlug: "stressco",
			CompanyName: "Stress Co",
			Title:       fmt.Sprintf("Stress Engineer %d", i+1),
			ApplyURL:    fmt.Sprintf("https://example.com/stress/%d", i+1),
		}
	}
	if _, _, err := appdb.QueueJobs(db, jobs); err != nil {
		t.Fatalf("seedExtractedJobs: QueueJobs error = %v", err)
	}

	apps, err := appdb.GetExtractable(db, count, platform)
	if err != nil {
		t.Fatalf("seedExtractedJobs: GetExtractable error = %v", err)
	}
	if len(apps) != count {
		t.Fatalf("seedExtractedJobs: got %d apps, want %d", len(apps), count)
	}

	for _, app := range apps {
		if err := appdb.MarkExtracted(db, app.ID, "/tmp/fields.json"); err != nil {
			t.Fatalf("seedExtractedJobs: MarkExtracted error = %v", err)
		}
	}

	return apps
}

func TestConcurrentClaim_NoDuplicates(t *testing.T) {
	db := makeFreshDB(t)

	// Setup: 10 jobs, all advanced to extracted state.
	const totalJobs = 10
	const numAgents = 5
	const claimPerAgent = 3

	seedExtractedJobs(t, db, totalJobs, "ashby")

	// Spawn 5 goroutines, each calls ClaimJobs(db, 3, "agent-N").
	type result struct {
		apps []model.Application
		err  error
	}

	results := make([]result, numAgents)
	var wg sync.WaitGroup

	for i := 0; i < numAgents; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			token := fmt.Sprintf("agent-%d", i)
			claimed, err := appdb.ClaimJobs(db, claimPerAgent, token)
			results[i] = result{apps: claimed, err: err}
		}()
	}
	wg.Wait()

	// Collect all claimed job IDs and verify no duplicates.
	seen := make(map[int64]bool)
	totalClaimed := 0

	for i, r := range results {
		if r.err != nil {
			t.Fatalf("agent-%d ClaimJobs error = %v", i, r.err)
		}
		for _, app := range r.apps {
			if seen[app.ID] {
				t.Errorf("job ID %d claimed by more than one agent (duplicate!)", app.ID)
			}
			seen[app.ID] = true
			if app.Status != model.StatusClaimed {
				t.Errorf("app %d status = %q, want claimed", app.ID, app.Status)
			}
		}
		totalClaimed += len(r.apps)
	}

	// All 10 jobs should be claimed (5 agents x up to 3 each, but capped at 10 total).
	if totalClaimed != totalJobs {
		t.Fatalf("total claimed = %d, want %d (no duplicate, no under-claim)", totalClaimed, totalJobs)
	}
}

func TestParallelFillCap(t *testing.T) {
	db := makeFreshDB(t)

	// Setup: 10 claimed jobs with different claim tokens.
	const totalJobs = 10
	seedExtractedJobs(t, db, totalJobs, "ashby")

	// Claim each job individually with its own token so we get distinct claim tokens.
	claimTokens := make([]string, totalJobs)
	for i := 0; i < totalJobs; i++ {
		token := fmt.Sprintf("fill-token-%d", i)
		claimed, err := appdb.ClaimJobs(db, 1, token)
		if err != nil {
			t.Fatalf("ClaimJobs for token %s error = %v", token, err)
		}
		if len(claimed) != 1 {
			t.Fatalf("ClaimJobs got %d apps for token %s, want 1", len(claimed), token)
		}
		claimTokens[i] = token
	}

	// Simulate concurrent MarkFilling calls in 10 goroutines.
	var wg sync.WaitGroup
	errs := make([]error, totalJobs)

	for i := 0; i < totalJobs; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = appdb.MarkFilling(db, claimTokens[i], fmt.Sprintf("/tmp/payload-%d.json", i))
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("MarkFilling[%d] error = %v", i, err)
		}
	}

	// After all: GetFillingCount == 10.
	count, err := appdb.GetFillingCount(db)
	if err != nil {
		t.Fatalf("GetFillingCount error = %v", err)
	}
	if count != totalJobs {
		t.Errorf("GetFillingCount = %d, want %d", count, totalJobs)
	}

	// Then simulate 10 concurrent MarkSubmitted calls.
	submitErrs := make([]error, totalJobs)
	var wg2 sync.WaitGroup

	for i := 0; i < totalJobs; i++ {
		i := i
		wg2.Add(1)
		go func() {
			defer wg2.Done()
			submitErrs[i] = appdb.MarkSubmitted(db, claimTokens[i], `{"submission":{"status":"submitted"}}`)
		}()
	}
	wg2.Wait()

	for i, err := range submitErrs {
		if err != nil {
			t.Errorf("MarkSubmitted[%d] error = %v", i, err)
		}
	}

	// After all: GetFillingCount == 0.
	count2, err := appdb.GetFillingCount(db)
	if err != nil {
		t.Fatalf("GetFillingCount after submitted error = %v", err)
	}
	if count2 != 0 {
		t.Errorf("GetFillingCount after submitted = %d, want 0", count2)
	}

	// Verify all 10 ended up as submitted.
	counts, err := appdb.GetStatusCounts(db)
	if err != nil {
		t.Fatalf("GetStatusCounts error = %v", err)
	}
	if counts[model.StatusSubmitted] != totalJobs {
		t.Errorf("submitted count = %d, want %d; counts = %v", counts[model.StatusSubmitted], totalJobs, counts)
	}
}
