package integration_test

import (
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	appdb "jobscan/internal/db"
	"jobscan/internal/apply"
	"jobscan/internal/model"
)

// testRepoRoot returns the repository root by going up 2 levels from
// the tests/integration/ directory.
func testRepoRoot() string {
	dir, _ := os.Getwd()
	return filepath.Join(dir, "..", "..")
}

// requirePython skips the test if python is not available in PATH.
// Also sets PYTHON env var to the found binary so runner.pythonBinary() uses it.
func requirePython(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("python"); err == nil {
		return
	}
	if _, err := exec.LookPath("python3"); err == nil {
		t.Setenv("PYTHON", "python3")
		return
	}
	t.Skip("python not in PATH")
}

// requirePythonPackage skips if the job_application_automator package is not present.
func requirePythonPackage(t *testing.T) {
	t.Helper()
	root := testRepoRoot()
	pkgDir := filepath.Join(root, "job_application_automator")
	if _, err := os.Stat(pkgDir); err != nil {
		t.Skipf("job_application_automator package not found at %s: %v", pkgDir, err)
	}
}

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

// makeTestJob creates a model.Job for use in tests.
func makeTestJob(id, platform string) model.Job {
	return model.Job{
		ID:          fmt.Sprintf("%s-%s-test", platform, id),
		JobID:       id,
		Platform:    platform,
		CompanySlug: "testco",
		CompanyName: "Test Co",
		Title:       "Test Engineer",
		ApplyURL:    "https://example.com/apply/" + id,
	}
}

// setupMockEnv configures mock mode environment variables for the test.
func setupMockEnv(t *testing.T) {
	t.Helper()
	t.Setenv("JOB_AUTOMATOR_MOCK", "1")
	t.Setenv("JOB_AUTOMATOR_PYTHON_DIR", testRepoRoot())
}

func TestFullFlow_HappyPath(t *testing.T) {
	requirePython(t)
	requirePythonPackage(t)
	setupMockEnv(t)

	db := makeFreshDB(t)

	// 1. Create 3 jobs and queue them.
	jobs := []model.Job{
		makeTestJob("job-001", "ashby"),
		makeTestJob("job-002", "ashby"),
		makeTestJob("job-003", "ashby"),
	}
	queued, skipped, err := appdb.QueueJobs(db, jobs)
	if err != nil {
		t.Fatalf("QueueJobs error = %v", err)
	}
	if queued != 3 || skipped != 0 {
		t.Fatalf("queued=%d skipped=%d, want queued=3 skipped=0", queued, skipped)
	}

	// 2. GetExtractable → RunExtractor (mock) for each → MarkExtracted.
	extractable, err := appdb.GetExtractable(db, 3, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable error = %v", err)
	}
	if len(extractable) != 3 {
		t.Fatalf("GetExtractable got %d apps, want 3", len(extractable))
	}

	for _, app := range extractable {
		outputDir := t.TempDir()
		fieldsPath, runErr := apply.RunExtractor(app.Platform, app.ApplyURL, outputDir, app.CompanySlug)
		if runErr != nil {
			t.Fatalf("RunExtractor error for %s: %v", app.JobID, runErr)
		}
		if err := appdb.MarkExtracted(db, app.ID, fieldsPath); err != nil {
			t.Fatalf("MarkExtracted error for %d: %v", app.ID, err)
		}
	}

	// 3. ClaimJobs(3, "agent1") → get 3 claimed apps.
	claimed, err := appdb.ClaimJobs(db, 3, "agent1")
	if err != nil {
		t.Fatalf("ClaimJobs error = %v", err)
	}
	if len(claimed) != 3 {
		t.Fatalf("ClaimJobs got %d apps, want 3", len(claimed))
	}
	for _, app := range claimed {
		if app.Status != model.StatusClaimed {
			t.Errorf("claimed app status = %q, want claimed", app.Status)
		}
		if app.ExtractedFieldsPath == "" {
			t.Errorf("claimed app %d has empty ExtractedFieldsPath", app.ID)
		}
	}

	// 4. For each claimed app: build dummy payload, MarkFilling, RunFillerAsync, WaitFiller, MarkSubmitted.
	for _, app := range claimed {
		outputDir := t.TempDir()

		// Write a dummy payload file.
		payloadPath := filepath.Join(outputDir, "fill_payload.json")
		if err := os.WriteFile(payloadPath, []byte(`{"mock":true}`), 0644); err != nil {
			t.Fatalf("write payload: %v", err)
		}

		if err := appdb.MarkFilling(db, app.ClaimToken, payloadPath); err != nil {
			t.Fatalf("MarkFilling error for %s: %v", app.ClaimToken, err)
		}

		// 5. RunFillerAsync (mock) → WaitFiller → MarkSubmitted.
		cmd, resultPath, runErr := apply.RunFillerAsync(app.Platform, payloadPath, outputDir, "", app.CompanySlug)
		if runErr != nil {
			t.Fatalf("RunFillerAsync error for %s: %v", app.ClaimToken, runErr)
		}

		resultJSON, waitErr := apply.WaitFiller(cmd, resultPath)
		if waitErr != nil {
			t.Fatalf("WaitFiller error for %s: %v", app.ClaimToken, waitErr)
		}
		if resultJSON == "" {
			t.Fatalf("WaitFiller returned empty result for %s", app.ClaimToken)
		}

		if err := appdb.MarkSubmitted(db, app.ClaimToken, resultJSON); err != nil {
			t.Fatalf("MarkSubmitted error for %s: %v", app.ClaimToken, err)
		}
	}

	// 6. GetStatusCounts → all 3 = submitted.
	counts, err := appdb.GetStatusCounts(db)
	if err != nil {
		t.Fatalf("GetStatusCounts error = %v", err)
	}
	if counts[model.StatusSubmitted] != 3 {
		t.Errorf("submitted count = %d, want 3; full counts = %v", counts[model.StatusSubmitted], counts)
	}
	// No other statuses should be present.
	for status, count := range counts {
		if status != model.StatusSubmitted {
			t.Errorf("unexpected status %q with count %d", status, count)
		}
	}
}

func TestFlow_ClaimBeforeExtract(t *testing.T) {
	db := makeFreshDB(t)

	// Queue jobs but don't extract.
	jobs := []model.Job{
		makeTestJob("job-001", "ashby"),
		makeTestJob("job-002", "ashby"),
	}
	if _, _, err := appdb.QueueJobs(db, jobs); err != nil {
		t.Fatalf("QueueJobs error = %v", err)
	}

	// ClaimJobs → should return empty (no extracted jobs).
	claimed, err := appdb.ClaimJobs(db, 5, "agent1")
	if err != nil {
		t.Fatalf("ClaimJobs error = %v", err)
	}
	if len(claimed) != 0 {
		t.Errorf("ClaimJobs got %d apps, want 0 (jobs are queued, not extracted)", len(claimed))
	}
}

func TestFlow_ExtractPartial_SomeFail(t *testing.T) {
	requirePython(t)
	requirePythonPackage(t)
	setupMockEnv(t)

	db := makeFreshDB(t)

	// Queue 5 jobs.
	jobs := make([]model.Job, 5)
	for i := 0; i < 5; i++ {
		jobs[i] = makeTestJob(fmt.Sprintf("job-%03d", i+1), "ashby")
	}
	if _, _, err := appdb.QueueJobs(db, jobs); err != nil {
		t.Fatalf("QueueJobs error = %v", err)
	}

	// Extract first 3 with mock (succeed).
	extractable, err := appdb.GetExtractable(db, 3, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable error = %v", err)
	}
	if len(extractable) != 3 {
		t.Fatalf("GetExtractable got %d apps, want 3", len(extractable))
	}
	for _, app := range extractable {
		outputDir := t.TempDir()
		fieldsPath, runErr := apply.RunExtractor(app.Platform, app.ApplyURL, outputDir, app.CompanySlug)
		if runErr != nil {
			t.Fatalf("RunExtractor error: %v", runErr)
		}
		if err := appdb.MarkExtracted(db, app.ID, fieldsPath); err != nil {
			t.Fatalf("MarkExtracted error: %v", err)
		}
	}

	// Get the remaining 2 into extracting state, then manually mark them failed.
	remaining, err := appdb.GetExtractable(db, 2, "ashby")
	if err != nil {
		t.Fatalf("GetExtractable for remaining error = %v", err)
	}
	if len(remaining) != 2 {
		t.Fatalf("GetExtractable for remaining got %d apps, want 2", len(remaining))
	}
	for _, app := range remaining {
		if err := appdb.MarkFailed(db, app.ID, "simulated extraction failure"); err != nil {
			t.Fatalf("MarkFailed error: %v", err)
		}
	}

	// ClaimJobs(5) → get only 3 (the extracted ones).
	claimed, err := appdb.ClaimJobs(db, 5, "agent1")
	if err != nil {
		t.Fatalf("ClaimJobs error = %v", err)
	}
	if len(claimed) != 3 {
		t.Errorf("ClaimJobs got %d apps, want 3", len(claimed))
	}

	// GetStatusCounts: claimed=3, failed=2.
	counts, err := appdb.GetStatusCounts(db)
	if err != nil {
		t.Fatalf("GetStatusCounts error = %v", err)
	}
	if counts[model.StatusClaimed] != 3 {
		t.Errorf("claimed count = %d, want 3; counts = %v", counts[model.StatusClaimed], counts)
	}
	if counts[model.StatusFailed] != 2 {
		t.Errorf("failed count = %d, want 2; counts = %v", counts[model.StatusFailed], counts)
	}
}

func TestFlow_SubmitInvalidToken(t *testing.T) {
	db := makeFreshDB(t)

	// MarkFilling with a random nonexistent token → no error, no rows affected.
	err := appdb.MarkFilling(db, "nonexistent-token-xyz", "/tmp/payload.json")
	if err != nil {
		t.Fatalf("MarkFilling with invalid token returned error: %v", err)
	}

	// GetFillingCount should still be 0.
	count, err := appdb.GetFillingCount(db)
	if err != nil {
		t.Fatalf("GetFillingCount error = %v", err)
	}
	if count != 0 {
		t.Errorf("GetFillingCount = %d, want 0", count)
	}
}

func TestFlow_SubmitAfterAlreadySubmitted(t *testing.T) {
	requirePython(t)
	requirePythonPackage(t)
	setupMockEnv(t)

	db := makeFreshDB(t)

	// Advance one job to submitted.
	job := makeTestJob("job-001", "ashby")
	if _, _, err := appdb.QueueJobs(db, []model.Job{job}); err != nil {
		t.Fatalf("QueueJobs error = %v", err)
	}

	extractable, err := appdb.GetExtractable(db, 1, "ashby")
	if err != nil || len(extractable) != 1 {
		t.Fatalf("GetExtractable error = %v, got %d apps", err, len(extractable))
	}

	outputDir := t.TempDir()
	fieldsPath, runErr := apply.RunExtractor(extractable[0].Platform, extractable[0].ApplyURL, outputDir, extractable[0].CompanySlug)
	if runErr != nil {
		t.Fatalf("RunExtractor error = %v", runErr)
	}
	if err := appdb.MarkExtracted(db, extractable[0].ID, fieldsPath); err != nil {
		t.Fatalf("MarkExtracted error = %v", err)
	}

	claimed, err := appdb.ClaimJobs(db, 1, "agent-submit-twice")
	if err != nil || len(claimed) != 1 {
		t.Fatalf("ClaimJobs error = %v, got %d apps", err, len(claimed))
	}
	claimToken := claimed[0].ClaimToken

	payloadPath := filepath.Join(outputDir, "fill_payload.json")
	if err := os.WriteFile(payloadPath, []byte(`{"mock":true}`), 0644); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	if err := appdb.MarkFilling(db, claimToken, payloadPath); err != nil {
		t.Fatalf("MarkFilling error = %v", err)
	}

	// First MarkSubmitted.
	if err := appdb.MarkSubmitted(db, claimToken, `{"submission":{"status":"submitted"}}`); err != nil {
		t.Fatalf("first MarkSubmitted error = %v", err)
	}

	// Second MarkSubmitted with same token → should be no-op (WHERE status='filling' already transitioned).
	if err := appdb.MarkSubmitted(db, claimToken, `{"submission":{"status":"submitted"}}`); err != nil {
		t.Fatalf("second MarkSubmitted returned error: %v", err)
	}

	// GetStatusCounts: still submitted=1, not 2.
	counts, err := appdb.GetStatusCounts(db)
	if err != nil {
		t.Fatalf("GetStatusCounts error = %v", err)
	}
	if counts[model.StatusSubmitted] != 1 {
		t.Errorf("submitted count = %d, want 1; counts = %v", counts[model.StatusSubmitted], counts)
	}
	total := 0
	for _, c := range counts {
		total += c
	}
	if total != 1 {
		t.Errorf("total applications = %d, want 1; counts = %v", total, counts)
	}
}

func TestFlow_DuplicateQueue(t *testing.T) {
	db := makeFreshDB(t)

	job := makeTestJob("job-001", "ashby")

	// Queue the same job twice.
	q1, s1, err := appdb.QueueJobs(db, []model.Job{job})
	if err != nil {
		t.Fatalf("first QueueJobs error = %v", err)
	}
	if q1 != 1 || s1 != 0 {
		t.Fatalf("first QueueJobs: queued=%d skipped=%d, want queued=1 skipped=0", q1, s1)
	}

	q2, s2, err := appdb.QueueJobs(db, []model.Job{job})
	if err != nil {
		t.Fatalf("second QueueJobs error = %v", err)
	}
	if q2 != 0 || s2 != 1 {
		t.Fatalf("second QueueJobs: queued=%d skipped=%d, want queued=0 skipped=1", q2, s2)
	}

	// Assert: only 1 row in applications table.
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM applications WHERE job_id=? AND platform=?`,
		job.JobID, job.Platform).Scan(&count); err != nil {
		t.Fatalf("count query error = %v", err)
	}
	if count != 1 {
		t.Errorf("application row count = %d, want 1", count)
	}
}
