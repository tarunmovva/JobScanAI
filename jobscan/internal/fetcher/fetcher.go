package fetcher

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"jobscan/internal/db"
	"jobscan/internal/model"

	"github.com/vbauerster/mpb/v8"
	"github.com/vbauerster/mpb/v8/decor"
	"golang.org/x/sync/errgroup"
)

// Platform defines a job board platform configuration.
type Platform struct {
	Name        string
	Slugs       []string
	URLTemplate string
	ParseFn     func(slug string, body []byte, fetchedAt time.Time) ([]model.Job, error)
}

// Progress holds live counters for one platform's fetch progress.
type Progress struct {
	Done   atomic.Int64
	Jobs   atomic.Int64
	Errors atomic.Int64
	Total  int
	Bar    *mpb.Bar
}

// AggregateProgress holds run-wide live counters for machine-readable
// progress reporting. mpb bars render nothing when stdout is a pipe, so
// piped consumers (the Electron app) opt into plain PROGRESS lines fed by
// these counters instead.
type AggregateProgress struct {
	Done  atomic.Int64
	Jobs  atomic.Int64
	Total int64
}

// FetchOptions configures a fetch run.
type FetchOptions struct {
	Workers         int
	PlatformWorkers map[string]int
	Force           bool
	Rebuild         bool
	MaxAgeHours     int
	Quiet           bool
	Aggregate       *AggregateProgress // optional run-wide counters (see AggregateProgress)
}

// Result is the summary of a completed fetch.
type Result struct {
	Platform string
	Total    int
	Done     int
	Jobs     int
	Errors   int
	Empty    int
	Elapsed  time.Duration
}

// FetchAll fetches all platforms concurrently.
func FetchAll(ctx context.Context, sqlDB *sql.DB, platforms []Platform, opts FetchOptions) ([]Result, error) {
	if opts.Workers <= 0 {
		opts.Workers = 160
	}
	if opts.MaxAgeHours <= 0 {
		opts.MaxAgeHours = 2
	}

	results := make([]Result, len(platforms))
	g, ctx := errgroup.WithContext(ctx)
	writer := newFetchDBWriter(opts.Workers*len(platforms)*2, !opts.Rebuild)
	writerDone := make(chan error, 1)
	go func() {
		writerDone <- writer.run(sqlDB)
	}()

	var p *mpb.Progress
	if !opts.Quiet {
		p = mpb.NewWithContext(ctx, mpb.WithWidth(30), mpb.WithRefreshRate(180*time.Millisecond))
	}

	for i, plat := range platforms {
		i, plat := i, plat
		g.Go(func() error {
			r, err := fetchPlatform(ctx, sqlDB, plat, opts, p, writer)
			if err != nil {
				return err
			}
			results[i] = r
			return nil
		})
	}

	err := g.Wait()
	writer.close()
	if writerErr := <-writerDone; err == nil && writerErr != nil {
		err = writerErr
	}
	if p != nil {
		p.Wait()
	}
	return results, err
}

func fetchPlatform(ctx context.Context, sqlDB *sql.DB, plat Platform, opts FetchOptions, progress *mpb.Progress, writer *fetchDBWriter) (Result, error) {
	start := time.Now()

	slugs := plat.Slugs
	if !opts.Force {
		stale, err := db.GetStaleSlugs(sqlDB, plat.Name, slugs, opts.MaxAgeHours)
		if err == nil {
			slugs = stale
		}
	}

	result := Result{
		Platform: plat.Name,
		Total:    len(plat.Slugs),
		Done:     len(plat.Slugs) - len(slugs), // already-cached
	}

	if len(slugs) == 0 {
		result.Elapsed = time.Since(start)
		if opts.Aggregate != nil {
			opts.Aggregate.Done.Add(int64(len(plat.Slugs)))
		}
		if progress != nil {
			name := fmt.Sprintf("  %-12s", plat.Name)
			bar, _ := progress.Add(int64(len(plat.Slugs)),
				mpb.BarStyle().Lbound("").Filler("█").Tip("█").Padding("░").Rbound("").Build(),
				mpb.PrependDecorators(
					decor.Name(name),
					decor.CountersNoUnit("%d / %d", decor.WCSyncWidth),
				),
				mpb.AppendDecorators(decor.Percentage()),
			)
			bar.IncrBy(len(plat.Slugs))
		}
		return result, nil
	}

	// Shared HTTP client per platform — connection pool tuned to worker count
	workers := workersForPlatform(plat.Name, opts)
	client := newClient(workers)

	// Progress bar
	var bar *mpb.Bar
	if progress != nil {
		name := fmt.Sprintf("  %-12s", plat.Name)
		bar, _ = progress.Add(int64(len(plat.Slugs)),
			mpb.BarStyle().Lbound("").Filler("█").Tip("█").Padding("░").Rbound("").Build(),
			mpb.PrependDecorators(
				decor.Name(name),
				decor.CountersNoUnit("%d / %d", decor.WCSyncWidth),
			),
			mpb.AppendDecorators(
				decor.Percentage(decor.WCSyncSpace),
				decor.OnComplete(
					decor.AverageETA(decor.ET_STYLE_GO), "done",
				),
			),
		)
		// Pre-fill already-done
		if result.Done > 0 {
			bar.IncrBy(result.Done)
		}
	}
	if opts.Aggregate != nil && result.Done > 0 {
		opts.Aggregate.Done.Add(int64(result.Done)) // already-cached boards count as done
	}

	var jobCount atomic.Int64
	var errorCount atomic.Int64
	var emptyCount atomic.Int64

	// Semaphore
	sem := make(chan struct{}, workers)
	var fetchWg sync.WaitGroup

	for _, slug := range slugs {
		slug := slug
		fetchWg.Add(1)
		sem <- struct{}{}

		go func() {
			defer fetchWg.Done()
			defer func() { <-sem }()

			select {
			case <-ctx.Done():
				return
			default:
			}

			apiURL := strings.ReplaceAll(plat.URLTemplate, "{slug}", url.PathEscape(slug))
			jobs, err := fetchWithRetry(ctx, client, plat, slug, apiURL)

			status := "done"
			errMsg := ""
			if err != nil {
				status = "error"
				errMsg = err.Error()
				errorCount.Add(1)
			} else if len(jobs) == 0 {
				status = "empty"
				emptyCount.Add(1)
			}

			_ = writer.writeStatus(ctx, model.CompanyStatus{
				Slug:         slug,
				Platform:     plat.Name,
				JobCount:     len(jobs),
				FetchStatus:  status,
				ErrorMessage: errMsg,
			})

			if len(jobs) > 0 {
				jobCount.Add(int64(len(jobs)))
				_ = writer.writeJobs(ctx, jobs)
				if opts.Aggregate != nil {
					opts.Aggregate.Jobs.Add(int64(len(jobs)))
				}
			}
			if bar != nil {
				bar.Increment()
			}
			if opts.Aggregate != nil {
				opts.Aggregate.Done.Add(1)
			}
		}()
	}

	fetchWg.Wait()

	result.Done = len(plat.Slugs)
	result.Jobs = int(jobCount.Load())
	result.Errors = int(errorCount.Load())
	result.Empty = int(emptyCount.Load())
	result.Elapsed = time.Since(start)

	return result, nil
}

func workersForPlatform(platform string, opts FetchOptions) int {
	if opts.PlatformWorkers != nil {
		if workers := opts.PlatformWorkers[strings.ToLower(platform)]; workers > 0 {
			return workers
		}
	}
	if opts.Workers > 0 {
		return opts.Workers
	}
	return 160
}

type fetchDBWriter struct {
	jobsCh   chan []model.Job
	statusCh chan model.CompanyStatus
	replace  bool
}

func newFetchDBWriter(buffer int, replace bool) *fetchDBWriter {
	if buffer < 16 {
		buffer = 16
	}
	return &fetchDBWriter{
		jobsCh:   make(chan []model.Job, buffer),
		statusCh: make(chan model.CompanyStatus, buffer),
		replace:  replace,
	}
}

func (w *fetchDBWriter) writeJobs(ctx context.Context, jobs []model.Job) error {
	if len(jobs) == 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case w.jobsCh <- jobs:
		return nil
	}
}

func (w *fetchDBWriter) writeStatus(ctx context.Context, status model.CompanyStatus) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case w.statusCh <- status:
		return nil
	}
}

func (w *fetchDBWriter) close() {
	close(w.jobsCh)
	close(w.statusCh)
}

func (w *fetchDBWriter) run(sqlDB *sql.DB) error {
	var firstErr error
	jobBuf := make([]model.Job, 0, db.JobBatchSize)
	statusBuf := make([]model.CompanyStatus, 0, db.StatusBatchSize)

	flushJobs := func() {
		if len(jobBuf) == 0 {
			return
		}
		if firstErr == nil {
			if err := db.BatchInsertJobs(sqlDB, jobBuf, w.replace); err != nil {
				firstErr = err
			}
		}
		jobBuf = jobBuf[:0]
	}
	flushStatuses := func() {
		if len(statusBuf) == 0 {
			return
		}
		if firstErr == nil {
			if err := db.BatchWriteCompanyStatuses(sqlDB, statusBuf, w.replace); err != nil {
				firstErr = err
			}
		}
		statusBuf = statusBuf[:0]
	}

	jobsCh := w.jobsCh
	statusCh := w.statusCh
	for jobsCh != nil || statusCh != nil {
		select {
		case jobs, ok := <-jobsCh:
			if !ok {
				jobsCh = nil
				flushJobs()
				continue
			}
			jobBuf = append(jobBuf, jobs...)
			if len(jobBuf) >= db.JobBatchSize {
				flushJobs()
			}
		case status, ok := <-statusCh:
			if !ok {
				statusCh = nil
				flushStatuses()
				continue
			}
			statusBuf = append(statusBuf, status)
			if len(statusBuf) >= db.StatusBatchSize {
				flushStatuses()
			}
		}
	}
	flushJobs()
	flushStatuses()
	return firstErr
}

func fetchWithRetry(ctx context.Context, client *http.Client, p Platform, slug, apiURL string) ([]model.Job, error) {
	var lastErr error
	backoffs := []time.Duration{0, 500 * time.Millisecond, 1 * time.Second}

	for attempt, backoff := range backoffs {
		if backoff > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		body, statusCode, err := doRequest(ctx, client, apiURL)
		if err != nil {
			lastErr = err
			continue
		}

		// Don't retry on 404
		if statusCode == 404 {
			return nil, fmt.Errorf("not found (404)")
		}

		// Retry on 429, 5xx
		if statusCode == 429 || (statusCode >= 500 && statusCode < 600) {
			lastErr = fmt.Errorf("HTTP %d", statusCode)
			if attempt < len(backoffs)-1 {
				continue
			}
			return nil, lastErr
		}

		if statusCode != 200 {
			return nil, fmt.Errorf("HTTP %d", statusCode)
		}

		jobs, err := p.ParseFn(slug, body, time.Now().UTC())
		if err != nil {
			return nil, err
		}
		return jobs, nil
	}
	return nil, lastErr
}

func doRequest(ctx context.Context, client *http.Client, apiURL string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "jobscan/1.0 (job board aggregator)")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

func newClient(workers int) *http.Client {
	return &http.Client{
		Timeout: 12 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:          workers + 20,
			MaxIdleConnsPerHost:   workers,
			MaxConnsPerHost:       workers + 10,
			IdleConnTimeout:       30 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
			DisableCompression:    false,
			ForceAttemptHTTP2:     true,
		},
	}
}
