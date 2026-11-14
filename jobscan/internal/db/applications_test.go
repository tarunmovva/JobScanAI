package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"jobscan/internal/model"
)

// seedJobs creates count model.Job values for the given platform and queues them.
// Returns the created jobs.
func seedJobs(t *testing.T, db *sql.DB, count int, platform string) []model.Job {
	t.Helper()
	jobs := make([]model.Job, count)
	for i := 0; i < count; i++ {
		jobs[i] = model.Job{
			JobID:       fmt.Sprintf("job-%d", i+1),
			Platform:    platform,
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       fmt.Sprintf("Engineer %d", i+1),
			ApplyURL:    fmt.Sprintf("https://example.com/apply/%d", i+1),
		}
	}
	queued, _, err := QueueJobs(db, jobs)
	if err != nil {
		t.Fatalf("seedJobs: QueueJobs error = %v", err)
	}
	if queued != count {
		t.Fatalf("seedJobs: queued = %d, want %d", queued, count)
	}
	return jobs
}

// advanceToExtracted seeds one job, gets it to extracting state, then marks it extracted.
// Returns the Application in extracted state.
func advanceToExtracted(t *testing.T, db *sql.DB, platform string) model.Application {
	t.Helper()
	jobs := []model.Job{
		{
			JobID:       "adv-job-1",
			Platform:    platform,
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       "Advanced Engineer",
			ApplyURL:    "https://example.com/apply/adv",
		},
	}
	if _, _, err := QueueJobs(db, jobs); err != nil {
		t.Fatalf("advanceToExtracted: QueueJobs error = %v", err)
	}

	apps, err := GetExtractable(db, 1, platform)
	if err != nil {
		t.Fatalf("advanceToExtracted: GetExtractable error = %v", err)
	}
	if len(apps) != 1 {
		t.Fatalf("advanceToExtracted: got %d apps, want 1", len(apps))
	}

	if err := MarkExtracted(db, apps[0].ID, "/tmp/fields.json"); err != nil {
		t.Fatalf("advanceToExtracted: MarkExtracted error = %v", err)
	}
	apps[0].Status = model.StatusExtracted
	apps[0].ExtractedFieldsPath = "/tmp/fields.json"
	return apps[0]
}

func TestQueueJobs_NoDuplicates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	job := model.Job{
		JobID:       "job-1",
		Platform:    "ashby",
		CompanySlug: "acme",
		CompanyName: "Acme Inc",
		Title:       "Engineer",
		ApplyURL:    "https://example.com/apply/1",
	}

	// First call: should queue 1, skip 0.
	q1, s1, err := QueueJobs(db, []model.Job{job})
	if err != nil {
		t.Fatalf("first QueueJobs error = %v", err)
	}
	if q1 != 1 || s1 != 0 {
		t.Fatalf("first call: queued=%d skipped=%d, want queued=1 skipped=0", q1, s1)
	}

	// Second call with same job: should queue 0, skip 1.
	q2, s2, err := QueueJobs(db, []model.Job{job})
	if err != nil {
		t.Fatalf("second QueueJobs error = %v", err)
	}
	if q2 != 0 || s2 != 1 {
		t.Fatalf("second call: queued=%d skipped=%d, want queued=0 skipped=1", q2, s2)
	}
}

func TestQueueJobs_MultiPlatform(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	// Same job_id, different platforms.
	jobs := []model.Job{
		{
			JobID:       "job-1",
			Platform:    "ashby",
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       "Engineer",
			ApplyURL:    "https://ashby.example.com/apply/1",
		},
		{
			JobID:       "job-1",
			Platform:    "lever",
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       "Engineer",
			ApplyURL:    "https://lever.example.com/apply/1",
		},
	}

	queued, skipped, err := QueueJobs(db, jobs)
	if err != nil {
		t.Fatalf("QueueJobs error = %v", err)
	}
	if queued != 2 || skipped != 0 {
		t.Fatalf("queued=%d skipped=%d, want queued=2 skipped=0", queued, skipped)
	}

	// Verify both rows exist with correct platforms.
	rows, err := db.Query(`SELECT platform FROM applications WHERE job_id='job-1' ORDER BY platform`)
	if err != nil {
		t.Fatalf("query error = %v", err)
	}
	defer rows.Close()

	var platforms []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			t.Fatalf("scan error = %v", err)
		}
		platforms = append(platforms, p)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows error = %v", err)
	}

	if len(platforms) != 2 {
		t.Fatalf("got %d rows, want 2", len(platforms))
	}
	if platforms[0] != "ashby" || platforms[1] != "lever" {
		t.Fatalf("platforms = %v, want [ashby lever]", platforms)
	}
}

func TestQueueJobs_Empty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	queued, skipped, err := QueueJobs(db, []model.Job{})
	if err != nil {
		t.Fatalf("QueueJobs(empty) error = %v", err)
	}
	if queued != 0 || skipped != 0 {
		t.Fatalf("queued=%d skipped=%d, want 0 0", queued, skipped)
	}
}

func TestGetExtractable_AtomicMark(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	seedJobs(t, db, 5, "ashby")

	// First call: get 3 → those become extracting.
	apps1, err := GetExtractable(db, 3, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable(3) error = %v", err)
	}
	if len(apps1) != 3 {
		t.Fatalf("got %d apps, want 3", len(apps1))
	}
	for _, a := range apps1 {
		if a.Status != model.StatusExtracting {
			t.Errorf("status = %q, want extracting", a.Status)
		}
	}

	// Second call: get up to 5 → gets remaining 2 (the other 3 are extracting, not queued).
	apps2, err := GetExtractable(db, 5, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable(5) error = %v", err)
	}
	if len(apps2) != 2 {
		t.Fatalf("got %d apps, want 2", len(apps2))
	}

	// Third call: no more queued jobs → gets 0.
	apps3, err := GetExtractable(db, 5, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable(5) final error = %v", err)
	}
	if len(apps3) != 0 {
		t.Fatalf("got %d apps, want 0", len(apps3))
	}
}

func TestGetExtractable_PlatformFilter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	// Seed 3 ashby and 2 lever jobs.
	ashbyJobs := make([]model.Job, 3)
	for i := 0; i < 3; i++ {
		ashbyJobs[i] = model.Job{
			JobID:       fmt.Sprintf("ashby-job-%d", i+1),
			Platform:    "ashby",
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       fmt.Sprintf("Ashby Engineer %d", i+1),
			ApplyURL:    fmt.Sprintf("https://ashby.example.com/apply/%d", i+1),
		}
	}
	leverJobs := make([]model.Job, 2)
	for i := 0; i < 2; i++ {
		leverJobs[i] = model.Job{
			JobID:       fmt.Sprintf("lever-job-%d", i+1),
			Platform:    "lever",
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       fmt.Sprintf("Lever Engineer %d", i+1),
			ApplyURL:    fmt.Sprintf("https://lever.example.com/apply/%d", i+1),
		}
	}
	if _, _, err := QueueJobs(db, ashbyJobs); err != nil {
		t.Fatalf("QueueJobs ashby error = %v", err)
	}
	if _, _, err := QueueJobs(db, leverJobs); err != nil {
		t.Fatalf("QueueJobs lever error = %v", err)
	}

	// Get extractable for lever only → should get 2.
	apps, err := GetExtractable(db, 5, "lever")
	if err != nil {
		t.Fatalf("GetExtractable error = %v", err)
	}
	if len(apps) != 2 {
		t.Fatalf("got %d apps, want 2", len(apps))
	}
	for _, a := range apps {
		if a.Platform != "lever" {
			t.Errorf("platform = %q, want lever", a.Platform)
		}
	}
}

func TestClaimJobs_Atomic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	// Seed 10 jobs and advance all to extracted state.
	for i := 0; i < 10; i++ {
		job := model.Job{
			JobID:       fmt.Sprintf("conc-job-%d", i+1),
			Platform:    "ashby",
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       fmt.Sprintf("Engineer %d", i+1),
			ApplyURL:    fmt.Sprintf("https://example.com/apply/%d", i+1),
		}
		if _, _, err := QueueJobs(db, []model.Job{job}); err != nil {
			t.Fatalf("QueueJobs error = %v", err)
		}
	}

	// Advance all to extracted.
	apps, err := GetExtractable(db, 10, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable error = %v", err)
	}
	if len(apps) != 10 {
		t.Fatalf("got %d apps, want 10", len(apps))
	}
	for _, a := range apps {
		if err := MarkExtracted(db, a.ID, "/tmp/fields.json"); err != nil {
			t.Fatalf("MarkExtracted error = %v", err)
		}
	}

	// Spawn 5 goroutines, each claiming up to 3.
	type result struct {
		apps []model.Application
		err  error
	}
	results := make([]result, 5)
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			token := fmt.Sprintf("agent-%d", i)
			claimed, err := ClaimJobs(db, 3, token)
			results[i] = result{apps: claimed, err: err}
		}()
	}
	wg.Wait()

	// Collect all claimed IDs and verify no duplicates.
	seen := make(map[int64]bool)
	totalClaimed := 0
	for _, r := range results {
		if r.err != nil {
			t.Fatalf("ClaimJobs error = %v", r.err)
		}
		for _, a := range r.apps {
			if seen[a.ID] {
				t.Errorf("job ID %d claimed by more than one agent", a.ID)
			}
			seen[a.ID] = true
		}
		totalClaimed += len(r.apps)
	}

	// All 10 jobs should be claimed (no overflow, no under-claim).
	if totalClaimed != 10 {
		t.Fatalf("total claimed = %d, want 10", totalClaimed)
	}
}

func TestClaimJobs_Cap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	// Seed 3 jobs and advance to extracted.
	for i := 0; i < 3; i++ {
		job := model.Job{
			JobID:       fmt.Sprintf("cap-job-%d", i+1),
			Platform:    "ashby",
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       fmt.Sprintf("Engineer %d", i+1),
			ApplyURL:    fmt.Sprintf("https://example.com/apply/%d", i+1),
		}
		if _, _, err := QueueJobs(db, []model.Job{job}); err != nil {
			t.Fatalf("QueueJobs error = %v", err)
		}
	}
	apps, err := GetExtractable(db, 3, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable error = %v", err)
	}
	for _, a := range apps {
		if err := MarkExtracted(db, a.ID, "/tmp/fields.json"); err != nil {
			t.Fatalf("MarkExtracted error = %v", err)
		}
	}

	// Request 5 but only 3 available → get 3.
	claimed, err := ClaimJobs(db, 5, "agent-cap")
	if err != nil {
		t.Fatalf("ClaimJobs error = %v", err)
	}
	if len(claimed) != 3 {
		t.Fatalf("got %d claimed, want 3", len(claimed))
	}
}

func TestClaimJobs_OnlyExtracted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	// 1. A job in queued state.
	if _, _, err := QueueJobs(db, []model.Job{{
		JobID: "state-queued", Platform: "ashby",
		CompanySlug: "acme", CompanyName: "Acme",
		Title: "Queued Job", ApplyURL: "https://example.com/queued",
	}}); err != nil {
		t.Fatalf("queue queued job: %v", err)
	}

	// 2. A job in extracting state (get extractable but don't mark extracted).
	if _, _, err := QueueJobs(db, []model.Job{{
		JobID: "state-extracting", Platform: "ashby",
		CompanySlug: "acme", CompanyName: "Acme",
		Title: "Extracting Job", ApplyURL: "https://example.com/extracting",
	}}); err != nil {
		t.Fatalf("queue extracting job: %v", err)
	}
	extractingApps, err := GetExtractable(db, 1, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable for extracting job: %v", err)
	}
	if len(extractingApps) == 0 {
		t.Fatal("expected to get 1 extracting app")
	}

	// 3. Two jobs in extracted state.
	if _, _, err := QueueJobs(db, []model.Job{
		{JobID: "state-ext-1", Platform: "ashby",
			CompanySlug: "acme", CompanyName: "Acme",
			Title: "Extracted 1", ApplyURL: "https://example.com/ext1"},
		{JobID: "state-ext-2", Platform: "ashby",
			CompanySlug: "acme", CompanyName: "Acme",
			Title: "Extracted 2", ApplyURL: "https://example.com/ext2"},
	}); err != nil {
		t.Fatalf("queue extracted jobs: %v", err)
	}
	extApps, err := GetExtractable(db, 2, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable for extracted jobs: %v", err)
	}
	for _, a := range extApps {
		if err := MarkExtracted(db, a.ID, "/tmp/fields.json"); err != nil {
			t.Fatalf("MarkExtracted: %v", err)
		}
	}

	// 4. A job in filling state.
	if _, _, err := QueueJobs(db, []model.Job{{
		JobID: "state-filling", Platform: "ashby",
		CompanySlug: "acme", CompanyName: "Acme",
		Title: "Filling Job", ApplyURL: "https://example.com/filling",
	}}); err != nil {
		t.Fatalf("queue filling job: %v", err)
	}
	fillExtr, err := GetExtractable(db, 1, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable for filling job: %v", err)
	}
	if len(fillExtr) > 0 {
		if err := MarkExtracted(db, fillExtr[0].ID, "/tmp/fields.json"); err != nil {
			t.Fatalf("MarkExtracted for filling: %v", err)
		}
		fillClaimed, err := ClaimJobs(db, 1, "fill-agent")
		if err != nil {
			t.Fatalf("ClaimJobs for filling: %v", err)
		}
		if len(fillClaimed) > 0 {
			if err := MarkFilling(db, fillClaimed[0].ClaimToken, "/tmp/payload.json"); err != nil {
				t.Fatalf("MarkFilling: %v", err)
			}
		}
	}

	// 5. A failed job.
	if _, _, err := QueueJobs(db, []model.Job{{
		JobID: "state-failed", Platform: "ashby",
		CompanySlug: "acme", CompanyName: "Acme",
		Title: "Failed Job", ApplyURL: "https://example.com/failed",
	}}); err != nil {
		t.Fatalf("queue failed job: %v", err)
	}
	var failedID int64
	if err := db.QueryRow(`SELECT id FROM applications WHERE job_id='state-failed'`).Scan(&failedID); err != nil {
		t.Fatalf("query failed job id: %v", err)
	}
	if err := MarkFailed(db, failedID, "extraction error"); err != nil {
		t.Fatalf("MarkFailed: %v", err)
	}

	// Now ClaimJobs(5) should only claim the 2 extracted jobs.
	claimed, err := ClaimJobs(db, 5, "claim-agent")
	if err != nil {
		t.Fatalf("ClaimJobs error = %v", err)
	}
	if len(claimed) != 2 {
		t.Fatalf("got %d claimed, want 2 (only extracted jobs)", len(claimed))
	}
	for _, a := range claimed {
		if a.Status != model.StatusClaimed {
			t.Errorf("claimed app status = %q, want claimed", a.Status)
		}
	}
}

func TestGetFillingCount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	// Seed 4 jobs and advance all to filling.
	jobs := make([]model.Job, 4)
	for i := 0; i < 4; i++ {
		jobs[i] = model.Job{
			JobID:       fmt.Sprintf("fill-job-%d", i+1),
			Platform:    "ashby",
			CompanySlug: "acme",
			CompanyName: "Acme Inc",
			Title:       fmt.Sprintf("Engineer %d", i+1),
			ApplyURL:    fmt.Sprintf("https://example.com/apply/%d", i+1),
		}
	}
	if _, _, err := QueueJobs(db, jobs); err != nil {
		t.Fatalf("QueueJobs error = %v", err)
	}
	apps, err := GetExtractable(db, 4, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable error = %v", err)
	}
	for _, a := range apps {
		if err := MarkExtracted(db, a.ID, "/tmp/fields.json"); err != nil {
			t.Fatalf("MarkExtracted error = %v", err)
		}
	}

	// Claim all 4 with separate tokens and mark each as filling.
	for i := 0; i < 4; i++ {
		token := fmt.Sprintf("fill-token-%d", i)
		claimed, err := ClaimJobs(db, 1, token)
		if err != nil {
			t.Fatalf("ClaimJobs error = %v", err)
		}
		if len(claimed) != 1 {
			t.Fatalf("got %d claimed, want 1", len(claimed))
		}
		if err := MarkFilling(db, token, "/tmp/payload.json"); err != nil {
			t.Fatalf("MarkFilling error = %v", err)
		}
	}

	count, err := GetFillingCount(db)
	if err != nil {
		t.Fatalf("GetFillingCount error = %v", err)
	}
	if count != 4 {
		t.Fatalf("filling count = %d, want 4", count)
	}

	// Mark 1 as submitted → filling count should be 3.
	if err := MarkSubmitted(db, "fill-token-0", `{"status":"submitted"}`); err != nil {
		t.Fatalf("MarkSubmitted error = %v", err)
	}

	count2, err := GetFillingCount(db)
	if err != nil {
		t.Fatalf("GetFillingCount after submit error = %v", err)
	}
	if count2 != 3 {
		t.Fatalf("filling count after submit = %d, want 3", count2)
	}
}

func TestMarkFailed_AnyState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	// Test: mark failed from queued state.
	if _, _, err := QueueJobs(db, []model.Job{{
		JobID: "fail-queued", Platform: "ashby",
		CompanySlug: "acme", CompanyName: "Acme",
		Title: "Queued Fail Job", ApplyURL: "https://example.com/fail-q",
	}}); err != nil {
		t.Fatalf("QueueJobs error = %v", err)
	}
	var queuedID int64
	if err := db.QueryRow(`SELECT id FROM applications WHERE job_id='fail-queued'`).Scan(&queuedID); err != nil {
		t.Fatalf("query queued id: %v", err)
	}
	if err := MarkFailed(db, queuedID, "queued error"); err != nil {
		t.Fatalf("MarkFailed from queued error = %v", err)
	}
	var qStatus, qErr string
	if err := db.QueryRow(`SELECT status, error FROM applications WHERE id=?`, queuedID).Scan(&qStatus, &qErr); err != nil {
		t.Fatalf("query after MarkFailed from queued: %v", err)
	}
	if qStatus != "failed" {
		t.Errorf("status = %q, want failed", qStatus)
	}
	if qErr != "queued error" {
		t.Errorf("error = %q, want 'queued error'", qErr)
	}

	// Test: mark failed from extracting state.
	if _, _, err := QueueJobs(db, []model.Job{{
		JobID: "fail-extracting", Platform: "ashby",
		CompanySlug: "acme", CompanyName: "Acme",
		Title: "Extracting Fail Job", ApplyURL: "https://example.com/fail-e",
	}}); err != nil {
		t.Fatalf("QueueJobs for extracting fail error = %v", err)
	}
	extApps, err := GetExtractable(db, 1, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable for extracting fail error = %v", err)
	}
	if len(extApps) == 0 {
		t.Fatal("expected at least 1 extracting app")
	}
	extApp := extApps[len(extApps)-1] // The one we just queued.
	if err := MarkFailed(db, extApp.ID, "extracting error"); err != nil {
		t.Fatalf("MarkFailed from extracting error = %v", err)
	}
	var eStatus, eErr string
	if err := db.QueryRow(`SELECT status, error FROM applications WHERE id=?`, extApp.ID).Scan(&eStatus, &eErr); err != nil {
		t.Fatalf("query after MarkFailed from extracting: %v", err)
	}
	if eStatus != "failed" {
		t.Errorf("status = %q, want failed", eStatus)
	}
	if eErr != "extracting error" {
		t.Errorf("error = %q, want 'extracting error'", eErr)
	}
}

func TestStatusTransitions_HappyPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	// Step 1: queue a job → status=queued.
	job := model.Job{
		JobID:       "happy-job-1",
		Platform:    "ashby",
		CompanySlug: "acme",
		CompanyName: "Acme Inc",
		Title:       "Happy Path Engineer",
		ApplyURL:    "https://example.com/happy/1",
	}
	if _, _, err := QueueJobs(db, []model.Job{job}); err != nil {
		t.Fatalf("QueueJobs error = %v", err)
	}
	checkStatus(t, db, "happy-job-1", "ashby", "queued")

	// Step 2: GetExtractable → status=extracting.
	apps, err := GetExtractable(db, 1, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable error = %v", err)
	}
	if len(apps) != 1 {
		t.Fatalf("got %d apps, want 1", len(apps))
	}
	appID := apps[0].ID
	checkStatus(t, db, "happy-job-1", "ashby", "extracting")

	// Step 3: MarkExtracted → status=extracted.
	if err := MarkExtracted(db, appID, "/tmp/fields.json"); err != nil {
		t.Fatalf("MarkExtracted error = %v", err)
	}
	checkStatus(t, db, "happy-job-1", "ashby", "extracted")

	// Step 4: ClaimJobs → status=claimed.
	claimed, err := ClaimJobs(db, 1, "happy-agent")
	if err != nil {
		t.Fatalf("ClaimJobs error = %v", err)
	}
	if len(claimed) != 1 {
		t.Fatalf("got %d claimed, want 1", len(claimed))
	}
	claimToken := claimed[0].ClaimToken
	checkStatus(t, db, "happy-job-1", "ashby", "claimed")

	// Step 5: MarkFilling → status=filling.
	if err := MarkFilling(db, claimToken, "/tmp/payload.json"); err != nil {
		t.Fatalf("MarkFilling error = %v", err)
	}
	checkStatus(t, db, "happy-job-1", "ashby", "filling")

	// Step 6: MarkSubmitted → status=submitted.
	if err := MarkSubmitted(db, claimToken, `{"submission":{"status":"submitted"}}`); err != nil {
		t.Fatalf("MarkSubmitted error = %v", err)
	}
	checkStatus(t, db, "happy-job-1", "ashby", "submitted")

	// Verify fill_result is stored.
	var fillResult string
	if err := db.QueryRow(`SELECT fill_result FROM applications WHERE job_id='happy-job-1'`).Scan(&fillResult); err != nil {
		t.Fatalf("query fill_result: %v", err)
	}
	if fillResult == "" {
		t.Error("fill_result should not be empty after MarkSubmitted")
	}
}

// checkStatus is a helper to assert the status of a job by job_id + platform.
func checkStatus(t *testing.T, db *sql.DB, jobID, platform, wantStatus string) {
	t.Helper()
	var status string
	if err := db.QueryRow(
		`SELECT status FROM applications WHERE job_id=? AND platform=?`,
		jobID, platform,
	).Scan(&status); err != nil {
		t.Fatalf("checkStatus query error: %v", err)
	}
	if status != wantStatus {
		t.Errorf("status = %q, want %q", status, wantStatus)
	}
}

func TestGetActiveFillingCount_RecoveryExempt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	seedJobs(t, db, 3, "greenhouse")
	// Advance all 3 to filling with payload paths in per-job temp dirs.
	apps, err := GetExtractable(db, 3, "")
	if err != nil || len(apps) != 3 {
		t.Fatalf("GetExtractable = %d apps, err %v", len(apps), err)
	}
	dirs := make([]string, 3)
	for i, a := range apps {
		if err := MarkExtracted(db, a.ID, "/tmp/fields.json"); err != nil {
			t.Fatalf("MarkExtracted: %v", err)
		}
		dirs[i] = t.TempDir()
	}
	claimed, err := ClaimJobs(db, 3, "tok-active")
	if err != nil || len(claimed) != 3 {
		t.Fatalf("ClaimJobs = %d, err %v", len(claimed), err)
	}
	for i, a := range claimed {
		if err := MarkFillingByID(db, a.ID, filepath.Join(dirs[i], "fill_payload.json")); err != nil {
			t.Fatalf("MarkFillingByID: %v", err)
		}
	}

	count, err := GetActiveFillingCount(db)
	if err != nil || count != 3 {
		t.Fatalf("active count = %d (err %v), want 3", count, err)
	}

	// Drop a recovery marker in one job's dir — it leaves the active count.
	if err := os.WriteFile(filepath.Join(dirs[0], ".recovery_active"), []byte("1"), 0644); err != nil {
		t.Fatalf("marker write: %v", err)
	}
	count, err = GetActiveFillingCount(db)
	if err != nil || count != 2 {
		t.Fatalf("active count with marker = %d (err %v), want 2", count, err)
	}
}

func TestReclaimStaleFilling(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	seedJobs(t, db, 2, "greenhouse")
	apps, err := GetExtractable(db, 2, "")
	if err != nil || len(apps) != 2 {
		t.Fatalf("GetExtractable = %d apps, err %v", len(apps), err)
	}
	for _, a := range apps {
		if err := MarkExtracted(db, a.ID, "/tmp/fields.json"); err != nil {
			t.Fatalf("MarkExtracted: %v", err)
		}
	}
	claimed, err := ClaimJobs(db, 2, "tok-stale")
	if err != nil || len(claimed) != 2 {
		t.Fatalf("ClaimJobs = %d, err %v", len(claimed), err)
	}
	for _, a := range claimed {
		if err := MarkFillingByID(db, a.ID, "/tmp/fill_payload.json"); err != nil {
			t.Fatalf("MarkFillingByID: %v", err)
		}
	}

	// Backdate one row 31 minutes.
	if _, err := db.Exec(`UPDATE applications SET updated_at=datetime('now','-31 minutes') WHERE id=?`, claimed[0].ID); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	reclaimed, err := ReclaimStaleFilling(db, 30)
	if err != nil || reclaimed != 1 {
		t.Fatalf("reclaimed = %d (err %v), want 1", reclaimed, err)
	}
	count, err := GetFillingCount(db)
	if err != nil || count != 1 {
		t.Fatalf("filling count after reclaim = %d (err %v), want 1", count, err)
	}
	var status, errMsg string
	if err := db.QueryRow(`SELECT status, COALESCE(error,'') FROM applications WHERE id=?`, claimed[0].ID).Scan(&status, &errMsg); err != nil {
		t.Fatalf("query reclaimed row: %v", err)
	}
	if status != "failed" || errMsg == "" {
		t.Fatalf("reclaimed row status=%q error=%q", status, errMsg)
	}
}
