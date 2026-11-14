package db

import (
	"database/sql"
	"fmt"
	"strings"

	"jobscan/internal/model"
)

const (
	JobBatchSize    = 5000
	StatusBatchSize = 1000
)

// BatchInsert inserts a slice of jobs using batched transactions.
// Uses INSERT OR REPLACE for idempotency.
func BatchInsert(db *sql.DB, jobs []model.Job) error {
	return BatchInsertJobs(db, jobs, true)
}

// BatchInsertJobs inserts a slice of jobs using batched transactions.
// When replace is false, plain INSERT is used for fresh rebuild databases.
func BatchInsertJobs(db *sql.DB, jobs []model.Job, replace bool) error {
	if len(jobs) == 0 {
		return nil
	}

	for i := 0; i < len(jobs); i += JobBatchSize {
		end := i + JobBatchSize
		if end > len(jobs) {
			end = len(jobs)
		}
		if err := insertBatch(db, jobs[i:end], replace); err != nil {
			return err
		}
	}
	return nil
}

func insertBatch(db *sql.DB, jobs []model.Job, replace bool) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	verb := "INSERT"
	if replace {
		verb = "INSERT OR REPLACE"
	}
	stmt, err := tx.Prepare(`
		` + verb + ` INTO jobs (
			id, platform, company_slug, company_name, job_id, title,
			location, department, team, employment_type, workplace_type,
			country, job_url, apply_url, posted_at, updated_at,
			description_plain, salary_raw, fetched_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return fmt.Errorf("prepare stmt: %w", err)
	}
	defer stmt.Close()

	var deleteMarkets *sql.Stmt
	if replace {
		deleteMarkets, err = tx.Prepare(`DELETE FROM job_markets WHERE job_id = ?`)
		if err != nil {
			return fmt.Errorf("prepare job market delete: %w", err)
		}
		defer deleteMarkets.Close()
	}

	marketRows := make([]jobMarketRow, 0, len(jobs)*2)
	for _, j := range jobs {
		if deleteMarkets != nil {
			if _, err := deleteMarkets.Exec(j.ID); err != nil {
				return fmt.Errorf("delete job markets %s: %w", j.ID, err)
			}
		}
		res, err := stmt.Exec(
			j.ID, j.Platform, j.CompanySlug, j.CompanyName, j.JobID, j.Title,
			j.Location, j.Department, j.Team, j.EmploymentType, j.WorkplaceType,
			j.Country, j.JobURL, j.ApplyURL, j.PostedAt, j.UpdatedAt,
			j.DescriptionPlain, j.SalaryRaw, j.FetchedAt,
		)
		if err != nil {
			return fmt.Errorf("insert job %s: %w", j.ID, err)
		}
		rowID, err := res.LastInsertId()
		if err != nil || rowID == 0 {
			if scanErr := tx.QueryRow(`SELECT rowid FROM jobs WHERE id = ?`, j.ID).Scan(&rowID); scanErr != nil {
				return fmt.Errorf("lookup rowid for job %s: %w", j.ID, scanErr)
			}
		}
		marketRows = append(marketRows, classifyJobMarkets(j, rowID)...)
	}
	if err := insertJobMarketRows(tx, marketRows); err != nil {
		return err
	}

	return tx.Commit()
}

// UpsertCompanyStatus updates fetch tracking for a company.
func UpsertCompanyStatus(db *sql.DB, slug, platform, status string, jobCount int, errMsg string) error {
	return BatchWriteCompanyStatuses(db, []model.CompanyStatus{{
		Slug:         slug,
		Platform:     platform,
		JobCount:     jobCount,
		FetchStatus:  status,
		ErrorMessage: errMsg,
	}}, true)
}

// BatchWriteCompanyStatuses writes company fetch statuses in batched transactions.
// When replace is false, plain INSERT is used for fresh rebuild databases.
func BatchWriteCompanyStatuses(db *sql.DB, statuses []model.CompanyStatus, replace bool) error {
	if len(statuses) == 0 {
		return nil
	}

	for i := 0; i < len(statuses); i += StatusBatchSize {
		end := i + StatusBatchSize
		if end > len(statuses) {
			end = len(statuses)
		}
		if err := writeStatusBatch(db, statuses[i:end], replace); err != nil {
			return err
		}
	}
	return nil
}

func writeStatusBatch(db *sql.DB, statuses []model.CompanyStatus, replace bool) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin status tx: %w", err)
	}
	defer tx.Rollback()

	verb := "INSERT"
	if replace {
		verb = "INSERT OR REPLACE"
	}
	stmt, err := tx.Prepare(`
		` + verb + ` INTO companies (slug, platform, job_count, last_fetched, fetch_status, error_message)
		VALUES (?, ?, ?, datetime('now'), ?, ?)
	`)
	if err != nil {
		return fmt.Errorf("prepare status stmt: %w", err)
	}
	defer stmt.Close()

	for _, status := range statuses {
		_, err := stmt.Exec(
			strings.TrimSpace(status.Slug),
			strings.TrimSpace(status.Platform),
			status.JobCount,
			strings.TrimSpace(status.FetchStatus),
			status.ErrorMessage,
		)
		if err != nil {
			return fmt.Errorf("write status %s/%s: %w", status.Platform, status.Slug, err)
		}
	}
	return tx.Commit()
}

// GetStaleSlugs returns slugs that haven't been fetched in the last maxAgeHours hours.
func GetStaleSlugs(db *sql.DB, platform string, allSlugs []string, maxAgeHours int) ([]string, error) {
	if len(allSlugs) == 0 {
		return nil, nil
	}

	// Get already-fetched slugs within maxAge
	rows, err := db.Query(`
		SELECT slug FROM companies
		WHERE platform = ?
		  AND fetch_status = 'done'
		  AND last_fetched > datetime('now', ? || ' hours')
	`, platform, fmt.Sprintf("-%d", maxAgeHours))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	fresh := make(map[string]bool)
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		fresh[slug] = true
	}

	stale := make([]string, 0, len(allSlugs))
	for _, s := range allSlugs {
		if !fresh[s] {
			stale = append(stale, s)
		}
	}
	return stale, nil
}

// DeleteJobsByCompany removes all jobs for a company before re-fetching.
func DeleteJobsByCompany(db *sql.DB, platform, slug string) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin delete jobs: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`
		DELETE FROM job_markets
		WHERE job_id IN (
			SELECT id FROM jobs WHERE platform = ? AND company_slug = ?
		)
	`, platform, slug); err != nil {
		return fmt.Errorf("delete job markets for company: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM jobs WHERE platform = ? AND company_slug = ?`, platform, slug); err != nil {
		return fmt.Errorf("delete jobs for company: %w", err)
	}
	return tx.Commit()
}
