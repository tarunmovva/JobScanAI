package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
	"jobscan/internal/db"
)

func init() {
	dbCmd := &cobra.Command{
		Use:   "db",
		Short: "Direct database operations (used by Electron main process)",
	}

	dbCmd.AddCommand(&cobra.Command{
		Use:   "exec <sql>",
		Short: "Execute a SQL statement, no output",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			sqlDB, err := db.Open(dbPath)
			if err != nil {
				return fmt.Errorf("opening database: %w", err)
			}
			defer sqlDB.Close()
			if _, err := sqlDB.Exec(args[0]); err != nil {
				return fmt.Errorf("exec: %w", err)
			}
			return nil
		},
	})

	dbCmd.AddCommand(&cobra.Command{
		Use:   "query <sql>",
		Short: "Execute a SQL query, print JSON array to stdout",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			sqlDB, err := db.Open(dbPath)
			if err != nil {
				return fmt.Errorf("opening database: %w", err)
			}
			defer sqlDB.Close()

			rows, err := sqlDB.Query(args[0])
			if err != nil {
				return fmt.Errorf("query: %w", err)
			}
			defer rows.Close()

			cols, err := rows.Columns()
			if err != nil {
				return err
			}

			var results []map[string]any
			for rows.Next() {
				vals := make([]any, len(cols))
				ptrs := make([]any, len(cols))
				for i := range vals {
					ptrs[i] = &vals[i]
				}
				if err := rows.Scan(ptrs...); err != nil {
					return err
				}
				row := make(map[string]any, len(cols))
				for i, col := range cols {
					row[col] = vals[i]
				}
				results = append(results, row)
			}
			if err := rows.Err(); err != nil {
				return err
			}
			if results == nil {
				results = []map[string]any{}
			}
			return json.NewEncoder(os.Stdout).Encode(results)
		},
	})

	dbCmd.AddCommand(&cobra.Command{
		Use:   "build-terms",
		Short: "Index the search vocabulary so queries find every spelling of a term",
		Long: `Materialise the FTS vocabulary into a lookup table.

The tokenizer treats '-' as a word character, so back-end, backend and
"back end" are three unrelated tokens. Searching one of them silently misses
the others -- --key-query fullstack reaches 646 postings where all spellings
together reach ~10,300.

This scans the index once (roughly 90s on a 2.6GB database) and records which
spellings actually occur, so search can widen a term into exactly the forms
this corpus contains. Re-run it after a fetch that adds many new postings.
Until it is run, search matches terms exactly, as before.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			sqlDB, err := db.Open(dbPath)
			if err != nil {
				return fmt.Errorf("opening database: %w", err)
			}
			defer sqlDB.Close()
			start := time.Now()
			n, err := db.BuildTermIndex(sqlDB)
			if err != nil {
				return err
			}
			fmt.Printf("  indexed %d search terms in %s\n", n, time.Since(start).Round(time.Second))
			return nil
		},
	})

	rootCmd.AddCommand(dbCmd)
}
