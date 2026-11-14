package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"jobscan/internal/model"
)

// QueueJobs inserts jobs into the applications table.
// Uses INSERT OR IGNORE to skip duplicates (UNIQUE(job_id, platform)).
// Returns count of newly queued jobs and count of skipped duplicates.
func QueueJobs(db *sql.DB, jobs []model.Job) (queued, skipped int, err error) {
	if len(jobs) == 0 {
		return 0, 0, nil
	}

	tx, err := db.Begin()
	if err != nil {
		return 0, 0, fmt.Errorf("begin queue tx: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT OR IGNORE INTO applications (
			job_id, platform, company_slug, company_name, job_title, apply_url, status
		) VALUES (?, ?, ?, ?, ?, ?, 'queued')
	`)
	if err != nil {
		return 0, 0, fmt.Errorf("prepare queue stmt: %w", err)
	}
	defer stmt.Close()

	for _, j := range jobs {
		res, execErr := stmt.Exec(
			j.JobID,
			j.Platform,
			j.CompanySlug,
			j.CompanyName,
			j.Title,
			j.ApplyURL,
		)
		if execErr != nil {
			return 0, 0, fmt.Errorf("queue job %s/%s: %w", j.Platform, j.JobID, execErr)
		}
		n, _ := res.RowsAffected()
		if n == 1 {
			queued++
		} else {
			skipped++
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("commit queue tx: %w", err)
	}
	return queued, skipped, nil
}

// GetExtractable atomically marks up to `limit` queued jobs as extracting
// and returns them. Uses a transaction to prevent double-extraction.
func GetExtractable(db *sql.DB, limit int, platform string) ([]model.Application, error) {
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("get conn for extractable: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return nil, fmt.Errorf("begin immediate for extractable: %w", err)
	}
	rollback := true
	defer func() {
		if rollback {
			conn.ExecContext(ctx, "ROLLBACK")
		}
	}()

	// Select IDs of queued jobs to claim.
	var rows *sql.Rows
	if platform != "" {
		rows, err = conn.QueryContext(ctx, `
			SELECT id FROM applications
			WHERE status='queued' AND platform=?
			ORDER BY id LIMIT ?
		`, platform, limit)
	} else {
		rows, err = conn.QueryContext(ctx, `
			SELECT id FROM applications
			WHERE status='queued'
			ORDER BY id LIMIT ?
		`, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("select extractable ids: %w", err)
	}

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan extractable id: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read extractable ids: %w", err)
	}

	if len(ids) == 0 {
		rollback = false
		conn.ExecContext(ctx, "COMMIT")
		return nil, nil
	}

	// Update to extracting.
	placeholders := strings.Repeat("?,", len(ids))
	placeholders = placeholders[:len(placeholders)-1]
	updateSQL := fmt.Sprintf(`
		UPDATE applications
		SET status='extracting', updated_at=datetime('now')
		WHERE id IN (%s)
	`, placeholders)
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	if _, err := conn.ExecContext(ctx, updateSQL, args...); err != nil {
		return nil, fmt.Errorf("update extracting status: %w", err)
	}

	// Read back the updated rows.
	selectSQL := fmt.Sprintf(`
		SELECT id, job_id, platform, company_slug, company_name, job_title,
		       apply_url, status, extracted_fields_path, fill_payload_path,
		       fill_result, claim_token, claimed_at, error, created_at, updated_at
		FROM applications WHERE id IN (%s) ORDER BY id
	`, placeholders)
	appRows, err := conn.QueryContext(ctx, selectSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("select updated extractable rows: %w", err)
	}
	defer appRows.Close()

	apps, err := scanApplications(appRows)
	if err != nil {
		return nil, err
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return nil, fmt.Errorf("commit extractable tx: %w", err)
	}
	rollback = false
	return apps, nil
}

// MarkExtracted marks a single application as extracted with the path to the extracted fields JSON.
func MarkExtracted(db *sql.DB, id int64, fieldsPath string) error {
	_, err := db.Exec(`
		UPDATE applications
		SET status='extracted', extracted_fields_path=?, updated_at=datetime('now')
		WHERE id=? AND status='extracting'
	`, fieldsPath, id)
	if err != nil {
		return fmt.Errorf("mark extracted %d: %w", id, err)
	}
	return nil
}

// MarkFailed marks an application as failed with an error message.
// Works from any state.
func MarkFailed(db *sql.DB, id int64, errMsg string) error {
	_, err := db.Exec(`
		UPDATE applications
		SET status='failed', error=?, updated_at=datetime('now')
		WHERE id=?
	`, errMsg, id)
	if err != nil {
		return fmt.Errorf("mark failed %d: %w", id, err)
	}
	return nil
}

// ClaimJobs atomically claims up to `count` extracted jobs for an agent.
// Uses BEGIN IMMEDIATE transaction to prevent concurrent double-claims.
// Returns the claimed applications with their extracted fields paths.
// agentToken is stored as the claim_token (should be a UUID).
func ClaimJobs(db *sql.DB, count int, agentToken string) ([]model.Application, error) {
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("get conn for claim: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return nil, fmt.Errorf("begin immediate for claim: %w", err)
	}
	rollback := true
	defer func() {
		if rollback {
			conn.ExecContext(ctx, "ROLLBACK")
		}
	}()

	// Update extracted → claimed atomically.
	if _, err := conn.ExecContext(ctx, `
		UPDATE applications
		SET status='claimed', claim_token=?, claimed_at=datetime('now'), updated_at=datetime('now')
		WHERE id IN (
			SELECT id FROM applications WHERE status='extracted' ORDER BY id LIMIT ?
		)
	`, agentToken, count); err != nil {
		return nil, fmt.Errorf("claim jobs update: %w", err)
	}

	// Read back the claimed rows.
	appRows, err := conn.QueryContext(ctx, `
		SELECT id, job_id, platform, company_slug, company_name, job_title,
		       apply_url, status, extracted_fields_path, fill_payload_path,
		       fill_result, claim_token, claimed_at, error, created_at, updated_at
		FROM applications WHERE claim_token=? AND status='claimed' ORDER BY id
	`, agentToken)
	if err != nil {
		return nil, fmt.Errorf("read claimed jobs: %w", err)
	}
	defer appRows.Close()

	apps, err := scanApplications(appRows)
	if err != nil {
		return nil, err
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return nil, fmt.Errorf("commit claim tx: %w", err)
	}
	rollback = false
	return apps, nil
}

// GetFillingCount returns the number of applications currently in filling state.
// Used to enforce the max-5-parallel-fillers cap.
func GetFillingCount(db *sql.DB) (int, error) {
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM applications WHERE status='filling'`).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("get filling count: %w", err)
	}
	return count, nil
}

// GetActiveFillingCount counts filling applications whose deterministic
// filler is actively driving the browser. Jobs that have entered the AI
// recovery phase drop a ".recovery_active" marker next to their payload
// (they mostly wait on the model, not the browser) and are exempt from
// the parallel-fillers cap.
func GetActiveFillingCount(db *sql.DB) (int, error) {
	rows, err := db.Query(`SELECT COALESCE(fill_payload_path, '') FROM applications WHERE status='filling'`)
	if err != nil {
		return 0, fmt.Errorf("get active filling count: %w", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var payloadPath string
		if err := rows.Scan(&payloadPath); err != nil {
			return 0, fmt.Errorf("scan filling row: %w", err)
		}
		if payloadPath != "" {
			marker := filepath.Join(filepath.Dir(payloadPath), ".recovery_active")
			if _, statErr := os.Stat(marker); statErr == nil {
				continue // in recovery — slot is free for the queue
			}
		}
		count++
	}
	return count, rows.Err()
}

// ReclaimStaleFilling fails 'filling' rows untouched for longer than
// olderThanMin minutes — their filler process is presumed dead. Frees the
// slots so the submit queue can never deadlock behind a crashed fill.
// Returns the number of reclaimed rows.
func ReclaimStaleFilling(db *sql.DB, olderThanMin int) (int64, error) {
	res, err := db.Exec(fmt.Sprintf(`
		UPDATE applications
		SET status='failed',
		    error='stale filling reclaimed after %d min (filler presumed dead)',
		    updated_at=datetime('now')
		WHERE status='filling' AND updated_at < datetime('now', '-%d minutes')
	`, olderThanMin, olderThanMin))
	if err != nil {
		return 0, fmt.Errorf("reclaim stale filling: %w", err)
	}
	return res.RowsAffected()
}

// MarkFilling marks all applications with the given claim_token as filling.
// Sets fill_payload_path. Only transitions from claimed→filling.
func MarkFilling(db *sql.DB, claimToken string, payloadPath string) error {
	_, err := db.Exec(`
		UPDATE applications
		SET status='filling', fill_payload_path=?, updated_at=datetime('now')
		WHERE claim_token=? AND status='claimed'
	`, payloadPath, claimToken)
	if err != nil {
		return fmt.Errorf("mark filling %s: %w", claimToken, err)
	}
	return nil
}

// MarkSubmitted marks all applications with the given claim_token as submitted.
// Stores the fill result JSON.
func MarkSubmitted(db *sql.DB, claimToken string, fillResultJSON string) error {
	_, err := db.Exec(`
		UPDATE applications
		SET status='submitted', fill_result=?, updated_at=datetime('now')
		WHERE claim_token=? AND status='filling'
	`, fillResultJSON, claimToken)
	if err != nil {
		return fmt.Errorf("mark submitted %s: %w", claimToken, err)
	}
	return nil
}

// MarkFillingByID marks a single application by ID as filling.
func MarkFillingByID(db *sql.DB, id int64, payloadPath string) error {
	_, err := db.Exec(`
		UPDATE applications
		SET status='filling', fill_payload_path=?, updated_at=datetime('now')
		WHERE id=? AND status='claimed'
	`, payloadPath, id)
	if err != nil {
		return fmt.Errorf("mark filling id=%d: %w", id, err)
	}
	return nil
}

// MarkSubmittedByID marks a single application by ID as submitted.
func MarkSubmittedByID(db *sql.DB, id int64, fillResultJSON string) error {
	_, err := db.Exec(`
		UPDATE applications
		SET status='submitted', fill_result=?, updated_at=datetime('now')
		WHERE id=? AND status='filling'
	`, fillResultJSON, id)
	if err != nil {
		return fmt.Errorf("mark submitted id=%d: %w", id, err)
	}
	return nil
}

// ApplicationFilter holds filter options for ListApplications.
type ApplicationFilter struct {
	Statuses []model.ApplicationStatus
	Platform string
	Company  string
	Limit    int
	Offset   int
}

// ListApplications returns applications matching the filter.
func ListApplications(db *sql.DB, f ApplicationFilter) ([]model.Application, error) {
	var clauses []string
	var args []interface{}

	if len(f.Statuses) > 0 {
		placeholders := strings.Repeat("?,", len(f.Statuses))
		placeholders = placeholders[:len(placeholders)-1]
		clauses = append(clauses, fmt.Sprintf("status IN (%s)", placeholders))
		for _, s := range f.Statuses {
			args = append(args, string(s))
		}
	}
	if f.Platform != "" {
		clauses = append(clauses, "platform=?")
		args = append(args, f.Platform)
	}
	if f.Company != "" {
		clauses = append(clauses, "company_slug=?")
		args = append(args, f.Company)
	}

	query := `
		SELECT id, job_id, platform, company_slug, company_name, job_title,
		       apply_url, status, extracted_fields_path, fill_payload_path,
		       fill_result, claim_token, claimed_at, error, created_at, updated_at
		FROM applications`
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	query += " ORDER BY id"

	offset := f.Offset
	if offset < 0 {
		offset = 0
	}
	if f.Limit > 0 {
		query += fmt.Sprintf(" LIMIT ? OFFSET ?")
		args = append(args, f.Limit, offset)
	}

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list applications: %w", err)
	}
	defer rows.Close()

	return scanApplications(rows)
}

// GetStatusCounts returns a map of status → count for all applications.
func GetStatusCounts(db *sql.DB) (map[model.ApplicationStatus]int, error) {
	rows, err := db.Query(`SELECT status, COUNT(*) FROM applications GROUP BY status`)
	if err != nil {
		return nil, fmt.Errorf("get status counts: %w", err)
	}
	defer rows.Close()

	counts := make(map[model.ApplicationStatus]int)
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, fmt.Errorf("scan status count: %w", err)
		}
		counts[model.ApplicationStatus(status)] = count
	}
	return counts, rows.Err()
}

// scanApplications reads *sql.Rows into a slice of Application.
// Expects columns: id, job_id, platform, company_slug, company_name, job_title,
// apply_url, status, extracted_fields_path, fill_payload_path, fill_result,
// claim_token, claimed_at, error, created_at, updated_at
func scanApplications(rows *sql.Rows) ([]model.Application, error) {
	var apps []model.Application
	for rows.Next() {
		var a model.Application
		var extractedFieldsPath, fillPayloadPath, fillResult, claimToken, errStr sql.NullString
		var claimedAt sql.NullTime
		var createdAt, updatedAt sql.NullTime

		err := rows.Scan(
			&a.ID,
			&a.JobID,
			&a.Platform,
			&a.CompanySlug,
			&a.CompanyName,
			&a.JobTitle,
			&a.ApplyURL,
			&a.Status,
			&extractedFieldsPath,
			&fillPayloadPath,
			&fillResult,
			&claimToken,
			&claimedAt,
			&errStr,
			&createdAt,
			&updatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan application row: %w", err)
		}

		a.ExtractedFieldsPath = extractedFieldsPath.String
		a.FillPayloadPath = fillPayloadPath.String
		a.FillResult = fillResult.String
		a.ClaimToken = claimToken.String
		a.Error = errStr.String

		if claimedAt.Valid {
			t := claimedAt.Time
			a.ClaimedAt = &t
		}
		if createdAt.Valid {
			a.CreatedAt = createdAt.Time
		} else {
			a.CreatedAt = time.Time{}
		}
		if updatedAt.Valid {
			a.UpdatedAt = updatedAt.Time
		} else {
			a.UpdatedAt = time.Time{}
		}

		apps = append(apps, a)
	}
	return apps, nil
}
