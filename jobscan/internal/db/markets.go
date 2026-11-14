package db

import (
	"database/sql"
	"fmt"

	"jobscan/internal/market"
	"jobscan/internal/model"
)

type jobMarketRow struct {
	market   string
	jobRowID int64
	jobID    string
}

// BackfillJobMarketsIfNeeded populates job_markets for databases created before
// market membership was precomputed.
func BackfillJobMarketsIfNeeded(db *sql.DB) error {
	var jobCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM jobs").Scan(&jobCount); err != nil {
		return fmt.Errorf("count jobs for market backfill: %w", err)
	}
	if jobCount == 0 {
		return nil
	}

	var marketCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM job_markets").Scan(&marketCount); err != nil {
		return fmt.Errorf("count job markets for backfill: %w", err)
	}
	if marketCount > 0 {
		return nil
	}
	return RebuildJobMarkets(db)
}

// RebuildJobMarkets rebuilds the precomputed market membership table from jobs.
func RebuildJobMarkets(db *sql.DB) error {
	rows, err := db.Query(`
		SELECT rowid, id, location, country, workplace_type
		FROM jobs
	`)
	if err != nil {
		return fmt.Errorf("query jobs for market rebuild: %w", err)
	}
	defer rows.Close()

	memberships := make([]jobMarketRow, 0)
	for rows.Next() {
		var rowID int64
		var id string
		var location, country, workplace sql.NullString
		if err := rows.Scan(&rowID, &id, &location, &country, &workplace); err != nil {
			return fmt.Errorf("scan job for market rebuild: %w", err)
		}
		for _, marketID := range market.Classify(location.String, country.String, workplace.String) {
			memberships = append(memberships, jobMarketRow{
				market:   marketID,
				jobRowID: rowID,
				jobID:    id,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read jobs for market rebuild: %w", err)
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin market rebuild: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec("DELETE FROM job_markets"); err != nil {
		return fmt.Errorf("clear job markets: %w", err)
	}
	if err := insertJobMarketRows(tx, memberships); err != nil {
		return err
	}
	return tx.Commit()
}

func classifyJobMarkets(job model.Job, rowID int64) []jobMarketRow {
	markets := market.Classify(job.Location, job.Country, job.WorkplaceType)
	rows := make([]jobMarketRow, 0, len(markets))
	for _, marketID := range markets {
		rows = append(rows, jobMarketRow{
			market:   marketID,
			jobRowID: rowID,
			jobID:    job.ID,
		})
	}
	return rows
}

func insertJobMarketRows(tx *sql.Tx, rows []jobMarketRow) error {
	if len(rows) == 0 {
		return nil
	}
	stmt, err := tx.Prepare(`
		INSERT OR IGNORE INTO job_markets (market, job_rowid, job_id)
		VALUES (?, ?, ?)
	`)
	if err != nil {
		return fmt.Errorf("prepare job market insert: %w", err)
	}
	defer stmt.Close()

	for _, row := range rows {
		if _, err := stmt.Exec(row.market, row.jobRowID, row.jobID); err != nil {
			return fmt.Errorf("insert job market %s/%s: %w", row.market, row.jobID, err)
		}
	}
	return nil
}
