package cmd

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"jobscan/internal/config"
	"jobscan/internal/db"
	"jobscan/internal/fetcher"
	"jobscan/internal/loader"
	"jobscan/internal/parser"
)

var fetchCmd = &cobra.Command{
	Use:   "fetch",
	Short: "Scrape job boards and populate the local database",
	Long: `Fetch jobs from all companies in the data CSV files.

Source data:
  Reads company slugs from --data-dir CSV files.
  Default source directory is the bundled data directory.
  Supported platforms: greenhouse, lever, ashby.

Cache behavior:
  Boards fetched recently are skipped by the 2h cache.
  Use --force to refresh existing fetched boards and ignore the cache.

Examples:
  jobscan fetch                              # fetch all bundled companies
  jobscan fetch --platform greenhouse        # one platform only
  jobscan fetch --company anthropic,stripe   # specific companies
  jobscan fetch --force                      # ignore 2h cache
  jobscan fetch --rebuild                    # build a fresh optimized DB and swap it in
  jobscan fetch --workers 160               # override platform-specific concurrency`,
	RunE: runFetch,
}

var (
	fetchPlatforms     []string
	fetchCompanies     []string
	fetchForce         bool
	fetchRebuild       bool
	fetchWorkers       int
	fetchQuiet         bool
	fetchDataDir       string
	fetchProgressLines bool
)

func init() {
	rootCmd.AddCommand(fetchCmd)
	fetchCmd.Flags().StringSliceVar(&fetchPlatforms, "platform", nil,
		"Platforms to fetch: greenhouse, lever, ashby (default: all)")
	fetchCmd.Flags().StringSliceVar(&fetchCompanies, "company", nil,
		"Specific company slugs (comma-separated)")
	fetchCmd.Flags().BoolVar(&fetchForce, "force", false,
		"Ignore 2h cache and re-fetch everything")
	fetchCmd.Flags().BoolVar(&fetchRebuild, "rebuild", false,
		"Build a fresh optimized database and replace the current DB only after success")
	fetchCmd.Flags().IntVar(&fetchWorkers, "workers", config.DefaultWorkers,
		"Concurrent requests per platform; overrides platform-specific defaults")
	fetchCmd.Flags().BoolVarP(&fetchQuiet, "quiet", "q", false,
		"Suppress progress bars, print only summary")
	fetchCmd.Flags().StringVar(&fetchDataDir, "data-dir", config.DefaultDataDir(),
		"Path to directory containing the CSV files")
	fetchCmd.Flags().BoolVar(&fetchProgressLines, "progress-lines", false,
		"Print plain machine-readable progress lines (for piped consumers; suppresses progress bars)")
}

func runFetch(cmd *cobra.Command, args []string) error {
	companies := flattenCommaSeparated(fetchCompanies)
	selectedPlatforms := flattenCommaSeparated(fetchPlatforms)

	if err := validateFetchOptions(fetchOptions{
		Platforms: selectedPlatforms,
		Workers:   fetchWorkers,
	}); err != nil {
		return err
	}

	start := time.Now()

	// Open database
	activeDBPath := dbPath
	var rebuildTempPath string
	var sqlDB *sql.DB
	var err error
	if fetchRebuild {
		// Rebuild files a killed or crashed fetch left behind (hundreds of MB
		// each). One still being written is never older than a few seconds.
		cleanStaleRebuilds(dbPath, staleRebuildAge)
		rebuildTempPath = tempRebuildPath(dbPath)
		if err := removeDBFiles(rebuildTempPath); err != nil {
			return err
		}
		activeDBPath = rebuildTempPath
		sqlDB, err = db.OpenForRebuild(activeDBPath)
	} else {
		sqlDB, err = db.Open(activeDBPath)
	}
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer func() {
		if sqlDB != nil {
			sqlDB.Close()
		}
	}()
	// A rebuild that does not reach its swap is abandoned: its file removed,
	// the database it was to replace left exactly as it was.
	rebuildSwapped := false
	if fetchRebuild {
		defer func() {
			if rebuildSwapped {
				return
			}
			if sqlDB != nil {
				sqlDB.Close()
				sqlDB = nil
			}
			_ = removeDBFiles(rebuildTempPath)
		}()
	}

	// Load slugs from CSV files
	loadStart := time.Now()
	slugs, err := loader.LoadFromDir(fetchDataDir)
	if err != nil {
		return fmt.Errorf("loading company data: %w", err)
	}

	// Apply filters
	if len(fetchCompanies) > 0 {
		slugs = slugs.FilterBySlugs(companies)
	}
	if len(fetchPlatforms) > 0 {
		slugs = slugs.FilterByPlatforms(selectedPlatforms)
	}
	if fetchRebuild && !fetchQuiet {
		logFetchTiming("Loaded company data", time.Since(loadStart))
	}

	totalSlugs := len(slugs.Greenhouse) + len(slugs.Lever) + len(slugs.Ashby)
	if totalSlugs == 0 {
		fmt.Println("No companies found to fetch. Check your --company or --platform filters.")
		return nil
	}

	if !fetchQuiet {
		fmt.Printf("\n  Fetching %d companies across platforms...\n\n", totalSlugs)
	}

	// Build platform configs
	platforms := []fetcher.Platform{
		{
			Name:        "greenhouse",
			Slugs:       slugs.Greenhouse,
			URLTemplate: "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
			ParseFn:     parser.ParseGreenhouse,
		},
		{
			Name:        "lever",
			Slugs:       slugs.Lever,
			URLTemplate: "https://api.lever.co/v0/postings/{slug}?mode=json",
			ParseFn:     parser.ParseLever,
		},
		{
			Name:        "ashby",
			Slugs:       slugs.Ashby,
			URLTemplate: "https://api.ashbyhq.com/posting-api/job-board/{slug}",
			ParseFn:     parser.ParseAshby,
		},
	}

	// Remove empty platforms (when filtering)
	var activePlatforms []fetcher.Platform
	for _, p := range platforms {
		if len(p.Slugs) > 0 {
			activePlatforms = append(activePlatforms, p)
		}
	}

	// Handle Ctrl+C gracefully
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if !fetchRebuild {
		// Drop FTS triggers to drastically speed up bulk inserts.
		if err := db.DropFTSTriggers(sqlDB); err != nil {
			return fmt.Errorf("drop FTS triggers: %w", err)
		}
	}

	platformWorkers := map[string]int(nil)
	if !cmd.Flags().Changed("workers") {
		platformWorkers = config.DefaultPlatformWorkers()
	}

	// Machine-readable progress for piped consumers: mpb bars render nothing
	// on a pipe, so the Electron app passes --progress-lines and parses these.
	// Format is a stable contract: PROGRESS companies=<done>/<total> jobs=<n>
	var agg *fetcher.AggregateProgress
	var progressDone chan struct{}
	if fetchProgressLines {
		agg = &fetcher.AggregateProgress{Total: int64(totalSlugs)}
		progressDone = make(chan struct{})
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			var lastDone, lastJobs int64 = -1, -1
			for {
				select {
				case <-progressDone:
					return
				case <-ticker.C:
					done, jobs := agg.Done.Load(), agg.Jobs.Load()
					if done != lastDone || jobs != lastJobs {
						fmt.Printf("PROGRESS companies=%d/%d jobs=%d\n", done, agg.Total, jobs)
						lastDone, lastJobs = done, jobs
					}
				}
			}
		}()
	}

	fetchStart := time.Now()
	results, err := fetcher.FetchAll(ctx, sqlDB, activePlatforms, fetcher.FetchOptions{
		Workers:         fetchWorkers,
		PlatformWorkers: platformWorkers,
		Force:           fetchForce || fetchRebuild,
		Rebuild:         fetchRebuild,
		MaxAgeHours:     config.DefaultMaxAgeHours,
		Quiet:           fetchQuiet || fetchProgressLines,
		Aggregate:       agg,
	})
	if fetchProgressLines {
		close(progressDone)
		// Final line so consumers always see 100% + the definitive job count.
		fmt.Printf("PROGRESS companies=%d/%d jobs=%d\n", agg.Done.Load(), agg.Total, agg.Jobs.Load())
	}
	if err != nil {
		return fmt.Errorf("fetch failed: %w", err)
	}
	if fetchRebuild && !fetchQuiet {
		logFetchTiming("Network fetch + DB inserts", time.Since(fetchStart))
	}

	if fetchRebuild {
		// FetchAll stops on a cancel without an error: what it gathered is
		// partial and must never replace the database.
		err := finishRebuild(ctx, sqlDB, rebuildTempPath, dbPath, fetchQuiet)
		sqlDB = nil // finishRebuild closed it
		if err != nil {
			return err
		}
		rebuildSwapped = true
	} else {
		if !fetchQuiet {
			fmt.Printf("  Rebuilding full-text search index...\n")
		}
		// Rebuild FTS index from scratch (much faster than row-by-row triggers)
		if errRebuild := db.RebuildFTS(sqlDB); errRebuild != nil {
			return fmt.Errorf("rebuild FTS: %w", errRebuild)
		}
		// Recreate triggers for future row-level updates
		if errCreate := db.CreateFTSTriggers(sqlDB); errCreate != nil {
			return fmt.Errorf("create FTS triggers: %w", errCreate)
		}
	}

	elapsed := time.Since(start)

	// Summary
	totalJobs := 0
	totalErrors := 0
	totalEmpty := 0
	for _, r := range results {
		totalJobs += r.Jobs
		totalErrors += r.Errors
		totalEmpty += r.Empty
	}

	fmt.Printf("\n  ✓ Fetch complete in %s\n", elapsed.Round(time.Second))
	fmt.Printf("    %d jobs from companies\n", totalJobs)
	if totalErrors > 0 {
		fmt.Printf("    %d errors, %d empty boards\n", totalErrors, totalEmpty)
	}
	fmt.Printf("    Database: %s\n\n", dbPath)

	return nil
}

// errFetchCancelled: the fetch was stopped (Ctrl+C, or the app's cancel).
var errFetchCancelled = errors.New("fetch cancelled: the database was left as it was")

// staleRebuildAge: a rebuild file untouched this long is a leftover.
const staleRebuildAge = 15 * time.Minute

// finishRebuild indexes the freshly fetched database and swaps it in for
// finalPath -- unless ctx is cancelled first: it is checked before every
// stage and once more just before the swap, and a cancelled or failed
// rebuild is abandoned (its files removed; finalPath untouched). sqlDB is
// always closed on return. The progress lines are the ones the app parses.
func finishRebuild(ctx context.Context, sqlDB *sql.DB, tempPath, finalPath string, quiet bool) (err error) {
	closed := false
	defer func() {
		if !closed {
			sqlDB.Close()
		}
		if err != nil {
			_ = removeDBFiles(tempPath)
		}
	}()
	stage := func(label string, fn func(*sql.DB) error) error {
		if ctx.Err() != nil {
			return errFetchCancelled
		}
		started := time.Now()
		if err := fn(sqlDB); err != nil {
			return fmt.Errorf("%s: %w", strings.ToLower(label), err)
		}
		if !quiet {
			logFetchTiming(label, time.Since(started))
		}
		return nil
	}

	if ctx.Err() != nil {
		return errFetchCancelled
	}
	if !quiet {
		fmt.Printf("  Building full-text search index...\n")
	}
	if err := stage("Created FTS table", db.CreateFTSTable); err != nil {
		return err
	}
	if err := stage("Rebuilt FTS index", db.RebuildFTS); err != nil {
		return err
	}
	if err := stage("Created FTS triggers", db.CreateFTSTriggers); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return errFetchCancelled
	}
	if !quiet {
		fmt.Printf("  Creating database indexes...\n")
	}
	if err := stage("Created SQL indexes", db.CreateIndexes); err != nil {
		return err
	}
	if err := stage("Checkpointed database", db.Checkpoint); err != nil {
		return err
	}
	if err := sqlDB.Close(); err != nil {
		return fmt.Errorf("close rebuild database: %w", err)
	}
	closed = true
	// The last moment to stop: past this line the swap always completes.
	if ctx.Err() != nil {
		return errFetchCancelled
	}
	started := time.Now()
	if err := db.ReplaceDatabase(tempPath, finalPath); err != nil {
		return err
	}
	if !quiet {
		logFetchTiming("Swapped database", time.Since(started))
	}
	return nil
}

// cleanStaleRebuilds removes rebuild files of finalPath (".<name>.rebuild-
// <stamp>.tmp" and its -wal/-shm) not modified for olderThan: what a killed
// or crashed fetch left behind. Windows ends a cancelled fetch by force, so
// it cannot clean up after itself there. Best effort.
func cleanStaleRebuilds(finalPath string, olderThan time.Duration) {
	dir := filepath.Dir(finalPath)
	prefix := "." + filepath.Base(finalPath) + ".rebuild-"
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-olderThan)
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, prefix) {
			continue
		}
		rest := strings.TrimPrefix(name, prefix)
		if !(strings.HasSuffix(rest, ".tmp") || strings.HasSuffix(rest, ".tmp-wal") || strings.HasSuffix(rest, ".tmp-shm")) {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, name))
	}
}

func logFetchTiming(label string, elapsed time.Duration) {
	fmt.Printf("  %-30s %s\n", label+":", elapsed.Round(time.Millisecond))
}

func tempRebuildPath(path string) string {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	return filepath.Join(dir, fmt.Sprintf(".%s.rebuild-%s.tmp", base, time.Now().Format("20060102150405")))
}

func removeDBFiles(path string) error {
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		if err := os.Remove(candidate); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove temp db file %s: %w", candidate, err)
		}
	}
	return nil
}
