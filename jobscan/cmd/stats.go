package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"jobscan/internal/db"
	"jobscan/internal/render"
)

var statsCmd = &cobra.Command{
	Use:   "stats",
	Short: "Show database statistics",
	Long:  `Display an overview of the local job database including counts by platform, department, and workplace type.`,
	RunE:  runStats,
}

func init() {
	rootCmd.AddCommand(statsCmd)
}

func runStats(cmd *cobra.Command, args []string) error {
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer sqlDB.Close()

	stats, err := db.GetStats(sqlDB, dbPath)
	if err != nil {
		return fmt.Errorf("getting stats: %w", err)
	}

	if stats.TotalJobs == 0 {
		fmt.Println("  Database is empty. Run `jobscan fetch` to populate it.")
		return nil
	}

	render.Stats(cmd.OutOrStdout(), stats, dbPath)
	return nil
}
