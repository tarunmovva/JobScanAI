package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const ftsPageSize = 32768

// Open opens or creates the SQLite database at the given path,
// applies performance PRAGMAs, and ensures the schema is up to date.
func Open(path string) (*sql.DB, error) {
	return open(path, false)
}

// OpenForRebuild opens a SQLite database optimized for bulk rebuild loading.
// It creates only the base tables; callers should create indexes and FTS after
// all rows have been inserted.
func OpenForRebuild(path string) (*sql.DB, error) {
	return open(path, true)
}

func open(path string, rebuild bool) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// Single writer + multiple reader connection pool
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := applyPragmas(db, rebuild); err != nil {
		db.Close()
		return nil, err
	}

	if rebuild {
		if err := createBaseTables(db); err != nil {
			db.Close()
			return nil, err
		}
		return db, nil
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}

	return db, nil
}

func applyPragmas(db *sql.DB, rebuild bool) error {
	if rebuild {
		// Rebuild writes to a disposable temp DB that is atomically swapped in
		// only after success, so avoid WAL/checkpoint overhead during bulk load.
		return execPragmas(db, []string{
			"PRAGMA journal_mode=OFF",
			"PRAGMA synchronous=OFF",
			"PRAGMA locking_mode=EXCLUSIVE",
			"PRAGMA cache_size=-524288",   // 512MB page cache
			"PRAGMA mmap_size=2147483648", // 2GB memory-mapped I/O
			"PRAGMA threads=8",            // helper threads for operations SQLite can parallelize
			"PRAGMA busy_timeout=5000",    // 5s retry on lock
			"PRAGMA foreign_keys=ON",
			"PRAGMA temp_store=MEMORY", // temp tables in memory
		})
	}

	pragmas := []string{
		"PRAGMA journal_mode=WAL", // concurrent reads + writes
		"PRAGMA synchronous=NORMAL",
		"PRAGMA cache_size=-131072",  // 128MB page cache
		"PRAGMA mmap_size=536870912", // 512MB memory-mapped I/O
		"PRAGMA threads=8",           // helper threads for operations SQLite can parallelize
		"PRAGMA busy_timeout=5000",   // 5s retry on lock
		"PRAGMA foreign_keys=ON",
		"PRAGMA temp_store=MEMORY", // temp tables in memory
	}
	return execPragmas(db, pragmas)
}

func execPragmas(db *sql.DB, pragmas []string) error {
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			return fmt.Errorf("pragma %q: %w", p, err)
		}
	}
	return nil
}

func migrate(db *sql.DB) error {
	if err := createBaseTables(db); err != nil {
		return err
	}
	if err := BackfillJobMarketsIfNeeded(db); err != nil {
		return err
	}
	if err := CreateFTSTable(db); err != nil {
		return err
	}
	if err := CreateFTSTriggers(db); err != nil {
		return err
	}
	if err := DropLowValueIndexes(db); err != nil {
		return err
	}
	if err := CreateIndexes(db); err != nil {
		return err
	}
	return nil
}

func createBaseTables(db *sql.DB) error {
	_, err := db.Exec(`
	CREATE TABLE IF NOT EXISTS jobs (
		id               TEXT PRIMARY KEY,
		platform         TEXT NOT NULL,
		company_slug     TEXT NOT NULL,
		company_name     TEXT,
		job_id           TEXT NOT NULL,
		title            TEXT NOT NULL,
		location         TEXT,
		department       TEXT,
		team             TEXT,
		employment_type  TEXT,
		workplace_type   TEXT,
		country          TEXT,
		job_url          TEXT,
		apply_url        TEXT,
		posted_at        TEXT,
		updated_at       TEXT,
		description_plain TEXT,
		salary_raw       TEXT,
		fetched_at       TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS companies (
		slug          TEXT NOT NULL,
		platform      TEXT NOT NULL,
		job_count     INTEGER DEFAULT 0,
		last_fetched  TEXT,
		fetch_status  TEXT DEFAULT 'pending',
		error_message TEXT,
		PRIMARY KEY (slug, platform)
	);

	CREATE TABLE IF NOT EXISTS job_markets (
		market    TEXT NOT NULL,
		job_rowid INTEGER NOT NULL,
		job_id    TEXT NOT NULL,
		PRIMARY KEY (market, job_rowid),
		FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS applications (
		id                    INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id                TEXT NOT NULL,
		platform              TEXT NOT NULL,
		company_slug          TEXT NOT NULL,
		company_name          TEXT,
		job_title             TEXT,
		apply_url             TEXT NOT NULL,
		status                TEXT NOT NULL DEFAULT 'queued',
		extracted_fields_path TEXT,
		fill_payload_path     TEXT,
		fill_result           TEXT,
		claim_token           TEXT,
		claimed_at            DATETIME,
		error                 TEXT,
		created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(job_id, platform)
	);
	`)
	if err != nil {
		return fmt.Errorf("create base tables: %w", err)
	}
	return nil
}

// CreateIndexes creates the normal SQL indexes used by search and stats.
func CreateIndexes(db *sql.DB) error {
	_, err := db.Exec(`
	CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs(posted_at DESC);
	CREATE INDEX IF NOT EXISTS idx_jobs_company_lower_posted ON jobs(LOWER(company_slug), posted_at DESC);
	CREATE INDEX IF NOT EXISTS idx_job_markets_job_id ON job_markets(job_id);
	CREATE INDEX IF NOT EXISTS idx_job_markets_rowid ON job_markets(job_rowid);
	CREATE INDEX IF NOT EXISTS idx_companies_fetch_cache ON companies(platform, fetch_status, last_fetched, slug);
	CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
	`)
	if err != nil {
		return fmt.Errorf("create indexes: %w", err)
	}
	return nil
}

// DropLowValueIndexes removes legacy indexes for filters now served by FTS.
func DropLowValueIndexes(db *sql.DB) error {
	queries := []string{
		"DROP INDEX IF EXISTS idx_jobs_platform;",
		"DROP INDEX IF EXISTS idx_jobs_company;",
		"DROP INDEX IF EXISTS idx_jobs_workplace;",
		"DROP INDEX IF EXISTS idx_jobs_dept;",
		"DROP INDEX IF EXISTS idx_jobs_emp_type;",
		"DROP INDEX IF EXISTS idx_jobs_country;",
	}
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

// DropIndexes removes normal SQL indexes for faster bulk inserts.
func DropIndexes(db *sql.DB) error {
	queries := []string{
		"DROP INDEX IF EXISTS idx_jobs_platform;",
		"DROP INDEX IF EXISTS idx_jobs_company;",
		"DROP INDEX IF EXISTS idx_jobs_posted;",
		"DROP INDEX IF EXISTS idx_jobs_company_lower_posted;",
		"DROP INDEX IF EXISTS idx_companies_fetch_cache;",
		"DROP INDEX IF EXISTS idx_job_markets_job_id;",
		"DROP INDEX IF EXISTS idx_job_markets_rowid;",
		"DROP INDEX IF EXISTS idx_jobs_workplace;",
		"DROP INDEX IF EXISTS idx_jobs_dept;",
		"DROP INDEX IF EXISTS idx_jobs_emp_type;",
		"DROP INDEX IF EXISTS idx_jobs_country;",
	}
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

// CreateFTSTable creates the FTS5 table without triggers.
func CreateFTSTable(db *sql.DB) error {
	exists, hasCompanySlug, err := ftsSchemaStatus(db)
	if err != nil {
		return err
	}
	if exists && !hasCompanySlug {
		if err := DropFTSTriggers(db); err != nil {
			return fmt.Errorf("drop stale FTS triggers: %w", err)
		}
		if _, err := db.Exec("DROP TABLE IF EXISTS jobs_fts"); err != nil {
			return fmt.Errorf("drop stale FTS table: %w", err)
		}
		if err := createJobsFTSTable(db); err != nil {
			return err
		}
		if err := configureFTSPageSize(db); err != nil {
			return err
		}
		if err := RebuildFTS(db); err != nil {
			return fmt.Errorf("rebuild FTS after schema migration: %w", err)
		}
		return nil
	}

	if !exists {
		if err := createJobsFTSTable(db); err != nil {
			return err
		}
		return configureFTSPageSize(db)
	}
	return nil
}

func ftsSchemaStatus(db *sql.DB) (bool, bool, error) {
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'jobs_fts'").Scan(&count); err != nil {
		return false, false, fmt.Errorf("check FTS table: %w", err)
	}
	if count == 0 {
		return false, false, nil
	}

	rows, err := db.Query("PRAGMA table_info(jobs_fts)")
	if err != nil {
		return true, false, fmt.Errorf("inspect FTS columns: %w", err)
	}
	defer rows.Close()

	hasCompanySlug := false
	for rows.Next() {
		var cid, notNull, pk int
		var name, colType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &colType, &notNull, &defaultValue, &pk); err != nil {
			return true, false, fmt.Errorf("scan FTS columns: %w", err)
		}
		if name == "company_slug" {
			hasCompanySlug = true
		}
	}
	if err := rows.Err(); err != nil {
		return true, false, fmt.Errorf("read FTS columns: %w", err)
	}
	return true, hasCompanySlug, nil
}

func createJobsFTSTable(db *sql.DB) error {
	if _, err := db.Exec(`
	CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
		title,
		description_plain,
		company_slug,
		company_name,
		location,
		department,
		employment_type,
		workplace_type,
		country,
		platform,
		content='jobs',
		content_rowid='rowid',
		tokenize='unicode61 tokenchars ''+#-.@'''
	);
	`); err != nil {
		return fmt.Errorf("create FTS table: %w", err)
	}
	return nil
}

func configureFTSPageSize(db *sql.DB) error {
	if _, err := db.Exec("INSERT INTO jobs_fts(jobs_fts, rank) VALUES('pgsz', ?)", ftsPageSize); err != nil {
		return fmt.Errorf("configure FTS page size: %w", err)
	}
	return nil
}

// DropFTSTriggers drops the FTS update triggers to speed up bulk inserts.
func DropFTSTriggers(db *sql.DB) error {
	queries := []string{
		"DROP TRIGGER IF EXISTS jobs_ai;",
		"DROP TRIGGER IF EXISTS jobs_ad;",
		"DROP TRIGGER IF EXISTS jobs_au;",
	}
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

// CreateFTSTriggers creates the FTS update triggers.
func CreateFTSTriggers(db *sql.DB) error {
	_, err := db.Exec(`
	CREATE TRIGGER IF NOT EXISTS jobs_ai AFTER INSERT ON jobs BEGIN
		INSERT INTO jobs_fts(rowid, title, description_plain, company_slug, company_name, location, department, employment_type, workplace_type, country, platform)
		VALUES (new.rowid, new.title, new.description_plain, new.company_slug, new.company_name, new.location, new.department, new.employment_type, new.workplace_type, new.country, new.platform);
	END;

	CREATE TRIGGER IF NOT EXISTS jobs_ad AFTER DELETE ON jobs BEGIN
		INSERT INTO jobs_fts(jobs_fts, rowid, title, description_plain, company_slug, company_name, location, department, employment_type, workplace_type, country, platform)
		VALUES ('delete', old.rowid, old.title, old.description_plain, old.company_slug, old.company_name, old.location, old.department, old.employment_type, old.workplace_type, old.country, old.platform);
	END;

	CREATE TRIGGER IF NOT EXISTS jobs_au AFTER UPDATE ON jobs BEGIN
		INSERT INTO jobs_fts(jobs_fts, rowid, title, description_plain, company_slug, company_name, location, department, employment_type, workplace_type, country, platform)
		VALUES ('delete', old.rowid, old.title, old.description_plain, old.company_slug, old.company_name, old.location, old.department, old.employment_type, old.workplace_type, old.country, old.platform);
		INSERT INTO jobs_fts(rowid, title, description_plain, company_slug, company_name, location, department, employment_type, workplace_type, country, platform)
		VALUES (new.rowid, new.title, new.description_plain, new.company_slug, new.company_name, new.location, new.department, new.employment_type, new.workplace_type, new.country, new.platform);
	END;
	`)
	return err
}

// RebuildFTS rebuilds the entire FTS index in one go.
func RebuildFTS(db *sql.DB) error {
	_, err := db.Exec("INSERT INTO jobs_fts(jobs_fts) VALUES('rebuild')")
	return err
}

// Checkpoint truncates WAL data into the main database file.
func Checkpoint(db *sql.DB) error {
	_, err := db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	return err
}

// ReplaceDatabase atomically swaps a completed temp database into finalPath.
// Existing final DB sidecar files are removed only after the main DB has been
// moved aside, so a failed swap can restore the previous main database.
func ReplaceDatabase(tempPath, finalPath string) error {
	if err := os.MkdirAll(filepath.Dir(finalPath), 0755); err != nil {
		return fmt.Errorf("create final db dir: %w", err)
	}

	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(tempPath + suffix)
	}

	backupPath := fmt.Sprintf("%s.bak-%s", finalPath, time.Now().Format("20060102150405"))
	finalExists := false
	if _, err := os.Stat(finalPath); err == nil {
		finalExists = true
		if err := os.Rename(finalPath, backupPath); err != nil {
			return fmt.Errorf("backup existing db: %w", err)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("stat existing db: %w", err)
	}

	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(finalPath + suffix)
	}

	if err := os.Rename(tempPath, finalPath); err != nil {
		if finalExists {
			_ = os.Rename(backupPath, finalPath)
		}
		return fmt.Errorf("replace db: %w", err)
	}

	if finalExists {
		_ = os.Remove(backupPath)
	}
	return nil
}
