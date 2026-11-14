package db

import (
	"database/sql"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestOpenKeepsOnlySearchCriticalIndexes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")

	seed, err := OpenForRebuild(path)
	if err != nil {
		t.Fatalf("OpenForRebuild() error = %v", err)
	}
	if _, err := seed.Exec(`
		CREATE INDEX idx_jobs_platform ON jobs(platform);
		CREATE INDEX idx_jobs_company ON jobs(company_slug);
		CREATE INDEX idx_jobs_workplace ON jobs(workplace_type);
		CREATE INDEX idx_jobs_dept ON jobs(department);
		CREATE INDEX idx_jobs_emp_type ON jobs(employment_type);
		CREATE INDEX idx_jobs_country ON jobs(country);
	`); err != nil {
		t.Fatalf("create legacy indexes: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer migrated.Close()

	got := indexNames(t, migrated, "jobs", "idx_jobs_%")
	want := []string{
		"idx_jobs_company_lower_posted",
		"idx_jobs_posted",
	}
	if !sameStrings(got, want) {
		t.Fatalf("job indexes = %v, want %v", got, want)
	}
}

func TestOpenCreatesCompaniesFetchCacheIndex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	got := indexNames(t, db, "companies", "idx_companies_%")
	want := []string{"idx_companies_fetch_cache"}
	if !sameStrings(got, want) {
		t.Fatalf("companies indexes = %v, want %v", got, want)
	}
}

func TestOpenCreatesJobMarketsIndexes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	got := indexNames(t, db, "job_markets", "idx_job_markets_%")
	want := []string{"idx_job_markets_job_id", "idx_job_markets_rowid"}
	if !sameStrings(got, want) {
		t.Fatalf("job_markets indexes = %v, want %v", got, want)
	}
}

func TestBackfillJobMarketsIfNeeded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	seed, err := OpenForRebuild(path)
	if err != nil {
		t.Fatalf("OpenForRebuild() error = %v", err)
	}
	if _, err := seed.Exec(`
		INSERT INTO jobs (
			id, platform, company_slug, company_name, job_id, title,
			location, department, employment_type, workplace_type, country,
			job_url, apply_url, posted_at, updated_at, description_plain, salary_raw, fetched_at
		)
		VALUES (
			'job-1', 'greenhouse', 'acme', 'Acme', '1', 'Software Engineer',
			'Austin', 'Engineering', 'Full-Time', 'Remote', 'United States',
			'https://example.com/job', 'https://example.com/apply', '2026-05-01T00:00:00Z',
			'2026-05-01T00:00:00Z', 'backend systems', '', '2026-05-01T00:00:00Z'
		);
	`); err != nil {
		t.Fatalf("seed jobs: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer migrated.Close()

	var count int
	if err := migrated.QueryRow(`SELECT COUNT(*) FROM job_markets WHERE market IN ('usa', 'north-america')`).Scan(&count); err != nil {
		t.Fatalf("query job markets: %v", err)
	}
	if count != 2 {
		t.Fatalf("job market count = %d, want 2", count)
	}
}

func TestOpenConfiguresFTSPageSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	var got string
	if err := db.QueryRow("SELECT v FROM jobs_fts_config WHERE k = 'pgsz'").Scan(&got); err != nil {
		t.Fatalf("query FTS page size: %v", err)
	}
	if got != "32768" {
		t.Fatalf("FTS page size = %q, want 32768", got)
	}
}

func TestOpenCreatesCompanySlugFTSColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	if !hasFTSColumn(t, db, "company_slug") {
		t.Fatalf("jobs_fts missing company_slug column")
	}
}

func TestOpenMigratesOldFTSSchemaToCompanySlug(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	seed, err := OpenForRebuild(path)
	if err != nil {
		t.Fatalf("OpenForRebuild() error = %v", err)
	}
	if _, err := seed.Exec(`
		INSERT INTO jobs (
			id, platform, company_slug, company_name, job_id, title,
			location, department, employment_type, workplace_type, country,
			job_url, apply_url, posted_at, updated_at, description_plain, salary_raw, fetched_at
		)
		VALUES (
			'job-1', 'greenhouse', 'acme', 'Acme', '1', 'Software Engineer',
			'Austin', 'Engineering', 'Full-Time', 'Remote', 'United States',
			'https://example.com/job', 'https://example.com/apply', '2026-05-01T00:00:00Z',
			'2026-05-01T00:00:00Z', 'backend systems', '', '2026-05-01T00:00:00Z'
		);
		CREATE VIRTUAL TABLE jobs_fts USING fts5(
			title,
			description_plain,
			company_name,
			location,
			department,
			employment_type,
			workplace_type,
			country,
			platform,
			content='jobs',
			content_rowid='rowid'
		);
	`); err != nil {
		t.Fatalf("seed old FTS schema: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatalf("Open() migrate error = %v", err)
	}
	defer migrated.Close()

	if !hasFTSColumn(t, migrated, "company_slug") {
		t.Fatalf("jobs_fts missing company_slug column after migration")
	}
	var count int
	if err := migrated.QueryRow("SELECT COUNT(*) FROM jobs_fts WHERE jobs_fts MATCH ?", `company_slug : "acme"`).Scan(&count); err != nil {
		t.Fatalf("query migrated FTS: %v", err)
	}
	if count != 1 {
		t.Fatalf("company_slug FTS count = %d, want 1", count)
	}
}

func TestOpenForRebuildUsesDisposablePragmas(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := OpenForRebuild(path)
	if err != nil {
		t.Fatalf("OpenForRebuild() error = %v", err)
	}
	defer db.Close()

	var journalMode string
	if err := db.QueryRow("PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatalf("query journal_mode: %v", err)
	}
	if !strings.EqualFold(journalMode, "off") {
		t.Fatalf("journal_mode = %q, want off", journalMode)
	}

	var lockingMode string
	if err := db.QueryRow("PRAGMA locking_mode").Scan(&lockingMode); err != nil {
		t.Fatalf("query locking_mode: %v", err)
	}
	if !strings.EqualFold(lockingMode, "exclusive") {
		t.Fatalf("locking_mode = %q, want exclusive", lockingMode)
	}
}

func indexNames(t *testing.T, db *sql.DB, table, like string) []string {
	t.Helper()

	rows, err := db.Query(`
		SELECT name
		FROM sqlite_master
		WHERE type = 'index'
		  AND tbl_name = ?
		  AND name LIKE ?
		ORDER BY name
	`, table, like)
	if err != nil {
		t.Fatalf("query indexes: %v", err)
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan index name: %v", err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("index rows: %v", err)
	}
	sort.Strings(names)
	return names
}

func hasFTSColumn(t *testing.T, db *sql.DB, column string) bool {
	t.Helper()

	rows, err := db.Query("PRAGMA table_info(jobs_fts)")
	if err != nil {
		t.Fatalf("query FTS columns: %v", err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid, notNull, pk int
		var name, colType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &colType, &notNull, &defaultValue, &pk); err != nil {
			t.Fatalf("scan FTS column: %v", err)
		}
		if name == column {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read FTS columns: %v", err)
	}
	return false
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
