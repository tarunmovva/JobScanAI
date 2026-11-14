package cmd

import (
	"crypto/rand"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"jobscan/internal/apply"
	"jobscan/internal/db"
	"jobscan/internal/model"
	"jobscan/internal/queryparser"
)

// ─── Parent command ────────────────────────────────────────────────────────────

var applyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Manage the job application pipeline",
}

func init() {
	rootCmd.AddCommand(applyCmd)
	registerQueueCmd()
	registerExtractCmd()
	registerClaimCmd()
	registerSubmitCmd()
	registerStatusCmd()
	registerListCmd()
}

// ─── apply queue ──────────────────────────────────────────────────────────────

var (
	queueJobIDs               string
	queueDesc                 bool
	queueRaw                  bool
	queueLocation             []string
	queueMarkets              []string
	queueTitleQuery           string
	queueKeyQuery             string
	queueExcludeKeyQuery      string
	queueExcludeTitlePhrases  []string
	queueRemote               bool
	queueHybrid               bool
	queueOnsite               bool
	queueSince                string
	queueBefore               string
	queuePlatforms            []string
	queueCompanies            []string
	queueDepartment           string
	queueType                 string
	queueCountry              string
	queueSort                 string
	queueLimit                int
	queueOffset               int
)

func registerQueueCmd() {
	cmd := &cobra.Command{
		Use:   "queue",
		Short: "Queue jobs for application",
		RunE:  runQueue,
	}

	cmd.Flags().StringVar(&queueJobIDs, "job-ids", "", "Comma-separated job IDs to queue (from 'jobscan search --format json')")

	// Search flags mirroring searchCmd but without format/output/count/fast
	cmd.Flags().BoolVarP(&queueDesc, "desc", "d", false, "Search in descriptions too (not just titles)")
	cmd.Flags().StringVar(&queueTitleQuery, "title-query", "", "Boolean title query")
	cmd.Flags().StringVarP(&queueKeyQuery, "key-query", "Q", "", "Boolean description query")
	cmd.Flags().StringVar(&queueExcludeKeyQuery, "exclude-key-query", "", "Boolean description query to exclude")
	cmd.Flags().StringSliceVar(&queueExcludeTitlePhrases, "exclude-title-phrase", nil, "Title phrases to exclude, comma-separated")
	cmd.Flags().BoolVar(&queueRaw, "raw", false, "Bypass FTS safety wrapper for raw FTS5 queries")
	cmd.Flags().StringSliceVar(&queueLocation, "location", nil, "Location text filter (comma-separated)")
	cmd.Flags().StringSliceVar(&queueMarkets, "market", nil, "Hiring market preset (comma-separated)")
	cmd.Flags().BoolVar(&queueRemote, "remote", false, "Show jobs marked remote")
	cmd.Flags().BoolVar(&queueHybrid, "hybrid", false, "Show jobs marked hybrid")
	cmd.Flags().BoolVar(&queueOnsite, "onsite", false, "Show jobs marked on-site")
	cmd.Flags().StringVar(&queueSince, "since", "", `Posted within: "7d", "30d", "2026-04-01"`)
	cmd.Flags().StringVar(&queueBefore, "before", "", "Posted before date: 2026-01-01")
	cmd.Flags().StringSliceVar(&queuePlatforms, "platform", nil, "Platform filter: greenhouse, lever, ashby")
	cmd.Flags().StringSliceVar(&queueCompanies, "company", nil, "Company slug filter (comma-separated)")
	cmd.Flags().StringVar(&queueDepartment, "department", "", "Department text filter")
	cmd.Flags().StringVar(&queueType, "type", "", "Employment type: full-time, intern, contract, temp")
	cmd.Flags().StringVar(&queueCountry, "country", "", "Source-provided country text filter")
	cmd.Flags().StringVar(&queueSort, "sort", "relevance", "Sort: relevance, newest, oldest, company, title")
	cmd.Flags().IntVar(&queueLimit, "limit", 25, "Max results (0 = all)")
	cmd.Flags().IntVar(&queueOffset, "offset", 0, "Pagination offset")

	applyCmd.AddCommand(cmd)
}

func runQueue(cmd *cobra.Command, args []string) error {
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer sqlDB.Close()

	var jobs []model.Job

	if queueJobIDs != "" {
		// Look up jobs by ID
		ids := splitTrim(queueJobIDs, ",")
		jobs, err = lookupJobsByID(sqlDB, ids)
		if err != nil {
			return fmt.Errorf("looking up jobs: %w", err)
		}
	} else {
		// Run search with the same flags as 'jobscan search'
		query := strings.Join(args, " ")

		companies := flattenCommaSeparated(queueCompanies)
		platforms := flattenCommaSeparated(queuePlatforms)
		locations := flattenCommaSeparated(queueLocation)
		markets := flattenCommaSeparated(queueMarkets)
		excludeTitlePhrases := flattenCommaSeparated(queueExcludeTitlePhrases)

		if err := validateSearchOptions(searchOptions{
			Remote:    queueRemote,
			Hybrid:    queueHybrid,
			Onsite:    queueOnsite,
			Since:     queueSince,
			Before:    queueBefore,
			Sort:      queueSort,
			Format:    "table", // dummy, not used
			Type:      queueType,
			Limit:     queueLimit,
			Offset:    queueOffset,
			Platforms: platforms,
			Markets:   markets,
		}); err != nil {
			return err
		}

		var marketFilters marketFilter
		if len(markets) > 0 {
			marketFilters, err = expandMarketFilters(markets)
			if err != nil {
				return err
			}
		}

		workplaceType := ""
		if queueRemote {
			workplaceType = "Remote"
		} else if queueHybrid {
			workplaceType = "Hybrid"
		} else if queueOnsite {
			workplaceType = "On-Site"
		}

		empType, err := normalizeSearchType(queueType)
		if err != nil {
			return err
		}

		limit := queueLimit
		if limit == 0 {
			limit = 100000
		}

		var expander queryparser.Expander
		if termExpander, err := db.NewTermExpander(sqlDB); err == nil && termExpander != nil {
			defer termExpander.Close()
			expander = termExpander
		}

		titleQueryFTS, err := compileBooleanFTSFlag("title-query", queueTitleQuery, "title", expander)
		if err != nil {
			return err
		}
		keyQueryFTS, err := compileBooleanFTSFlag("key-query", queueKeyQuery, "description_plain", expander)
		if err != nil {
			return err
		}
		excludeKeyQueryFTS, err := compileBooleanFTSFlag("exclude-key-query", queueExcludeKeyQuery, "description_plain", nil)
		if err != nil {
			return err
		}
		if excludeKeyQueryFTS != "" && !hasPositiveFTSAnchor(query, titleQueryFTS, keyQueryFTS, locations, marketFilters, workplaceType, empType, queueCountry, platforms, companies) {
			return fmt.Errorf("--exclude-key-query requires a positive search term or filter")
		}

		params := model.SearchParams{
			Query:               query,
			SearchDesc:          queueDesc,
			SearchRaw:           queueRaw,
			TitleQueryFTS:       titleQueryFTS,
			KeyQueryFTS:         keyQueryFTS,
			ExcludeKeyQueryFTS:  excludeKeyQueryFTS,
			ExcludeTitlePhrases: excludeTitlePhrases,
			Location:            locations,
			Markets:             marketFilters.Markets,
			MarketLocation:      marketFilters.LocationTerms,
			MarketCountry:       marketFilters.CountryTerms,
			WorkplaceType:       workplaceType,
			Since:               queueSince,
			Before:              queueBefore,
			Platforms:           platforms,
			Companies:           companies,
			Department:          queueDepartment,
			EmploymentType:      empType,
			Country:             queueCountry,
			SortBy:              strings.ToLower(strings.TrimSpace(queueSort)),
			Limit:               limit,
			Offset:              queueOffset,
			SkipCount:           true,
		}

		jobs, _, _, err = db.SearchJobs(sqlDB, params)
		if err != nil {
			return fmt.Errorf("search failed: %w", err)
		}
	}

	queued, skipped, err := db.QueueJobs(sqlDB, jobs)
	if err != nil {
		return fmt.Errorf("queueing jobs: %w", err)
	}

	fmt.Printf("Queued %d jobs (skipped %d duplicates)\n", queued, skipped)
	return nil
}

// lookupJobsByID fetches jobs from the DB by their composite ID (jobs.id TEXT PRIMARY KEY).
func lookupJobsByID(sqlDB *sql.DB, ids []string) ([]model.Job, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	placeholders := strings.Repeat("?,", len(ids))
	placeholders = placeholders[:len(placeholders)-1]
	query := fmt.Sprintf(
		`SELECT id, platform, company_slug, company_name, job_id, title, apply_url
		 FROM jobs WHERE id IN (%s)`, placeholders)

	args := make([]interface{}, len(ids))
	for i, id := range ids {
		args[i] = id
	}

	rows, err := sqlDB.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query jobs by id: %w", err)
	}
	defer rows.Close()

	var jobs []model.Job
	for rows.Next() {
		var j model.Job
		var companyName sql.NullString
		if err := rows.Scan(&j.ID, &j.Platform, &j.CompanySlug, &companyName, &j.JobID, &j.Title, &j.ApplyURL); err != nil {
			return nil, fmt.Errorf("scan job row: %w", err)
		}
		j.CompanyName = companyName.String
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

// ─── apply extract ────────────────────────────────────────────────────────────

var (
	extractWorkers  int
	extractLimit    int
	extractPlatform string
)

func registerExtractCmd() {
	cmd := &cobra.Command{
		Use:   "extract",
		Short: "Run extractors to scrape application forms for queued jobs",
		RunE:  runExtract,
	}

	cmd.Flags().IntVar(&extractWorkers, "workers", 1, "Parallel extractors (max 3)")
	cmd.Flags().IntVar(&extractLimit, "limit", 20, "Max jobs to extract per run")
	cmd.Flags().StringVar(&extractPlatform, "platform", "", "Filter to specific platform")

	applyCmd.AddCommand(cmd)
}

func runExtract(cmd *cobra.Command, args []string) error {
	if extractWorkers < 1 {
		extractWorkers = 1
	}
	if extractWorkers > 3 {
		extractWorkers = 3
	}

	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer sqlDB.Close()

	apps, err := db.GetExtractable(sqlDB, extractLimit, extractPlatform)
	if err != nil {
		return fmt.Errorf("getting extractable jobs: %w", err)
	}

	if len(apps) == 0 {
		fmt.Println("No queued jobs to extract.")
		return nil
	}

	type result struct {
		app       model.Application
		fieldsPath string
		err       error
	}

	extracted := 0
	failed := 0

	// Process in batches of workers size
	for i := 0; i < len(apps); i += extractWorkers {
		end := i + extractWorkers
		if end > len(apps) {
			end = len(apps)
		}
		batch := apps[i:end]

		results := make(chan result, len(batch))
		for _, a := range batch {
			a := a
			go func() {
				outputDir := apply.JobOutputDir(a.Platform, a.JobID)
				fieldsPath, runErr := apply.RunExtractor(a.Platform, a.ApplyURL, outputDir, a.CompanySlug)
				results <- result{app: a, fieldsPath: fieldsPath, err: runErr}
			}()
		}

		for range batch {
			r := <-results
			type extractLine struct {
				Platform string `json:"platform"`
				Company  string `json:"company"`
				JobID    string `json:"job_id"`
				Title    string `json:"title"`
				ApplyURL string `json:"apply_url"`
				Status   string `json:"status"`
				Error    string `json:"error,omitempty"`
			}
			line := extractLine{
				Platform: r.app.Platform,
				Company:  r.app.CompanySlug,
				JobID:    r.app.JobID,
				Title:    r.app.JobTitle,
				ApplyURL: r.app.ApplyURL,
			}
			if r.err != nil {
				failed++
				line.Status = "failed"
				line.Error = r.err.Error()
				_ = db.MarkFailed(sqlDB, r.app.ID, r.err.Error())
			} else {
				extracted++
				line.Status = "extracted"
				_ = db.MarkExtracted(sqlDB, r.app.ID, r.fieldsPath)
			}
			if b, err := json.Marshal(line); err == nil {
				fmt.Println(string(b))
			}
		}
	}

	fmt.Printf("Extracted: %d, Failed: %d\n", extracted, failed)
	return nil
}

// ─── apply claim ──────────────────────────────────────────────────────────────

var (
	claimCount   int
	claimAgentID string
	claimFormat  string
)

func registerClaimCmd() {
	cmd := &cobra.Command{
		Use:   "claim",
		Short: "Claim extracted jobs for an agent to fill",
		RunE:  runClaim,
	}

	cmd.Flags().IntVar(&claimCount, "count", 5, "Jobs to claim per agent batch (max 15)")
	cmd.Flags().StringVar(&claimAgentID, "agent-id", "agent", "Agent identifier (stored as claim_token prefix)")
	cmd.Flags().StringVar(&claimFormat, "format", "json", "Output format: json (default) | table")

	applyCmd.AddCommand(cmd)
}

type claimOutput struct {
	ApplicationID   int64           `json:"application_id"`
	JobID           string          `json:"job_id"`
	Platform        string          `json:"platform"`
	CompanySlug     string          `json:"company_slug"`
	JobTitle        string          `json:"job_title"`
	ApplyURL        string          `json:"apply_url"`
	ClaimToken      string          `json:"claim_token"`
	ExtractedFields json.RawMessage `json:"extracted_fields"`
}

func runClaim(cmd *cobra.Command, args []string) error {
	if claimCount > 15 {
		return fmt.Errorf("--count cannot exceed 15 (got %d)", claimCount)
	}
	if claimCount < 1 {
		claimCount = 1
	}

	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer sqlDB.Close()

	claimToken := generateClaimToken(claimAgentID)

	claimedApps, err := db.ClaimJobs(sqlDB, claimCount, claimToken)
	if err != nil {
		return fmt.Errorf("claiming jobs: %w", err)
	}

	if len(claimedApps) == 0 {
		fmt.Println("No extracted jobs available to claim.")
		return nil
	}

	format := strings.ToLower(strings.TrimSpace(claimFormat))

	switch format {
	case "table":
		fmt.Printf("%-40s  %-40s  %-20s  %-12s\n", "CLAIM_TOKEN", "JOB_TITLE", "COMPANY_SLUG", "PLATFORM")
		fmt.Println(strings.Repeat("-", 118))
		for _, a := range claimedApps {
			fmt.Printf("%-40s  %-40s  %-20s  %-12s\n",
				truncate(a.ClaimToken, 40),
				truncate(a.JobTitle, 40),
				truncate(a.CompanySlug, 20),
				a.Platform,
			)
		}
	default: // json
		var outputs []claimOutput
		for _, a := range claimedApps {
			var fields json.RawMessage
			if a.ExtractedFieldsPath != "" {
				data, readErr := os.ReadFile(a.ExtractedFieldsPath)
				if readErr == nil {
					fields = json.RawMessage(data)
				} else {
					fields = json.RawMessage(`{}`)
				}
			} else {
				fields = json.RawMessage(`{}`)
			}
			outputs = append(outputs, claimOutput{
				ApplicationID:   a.ID,
				JobID:           a.JobID,
				Platform:        a.Platform,
				CompanySlug:     a.CompanySlug,
				JobTitle:        a.JobTitle,
				ApplyURL:        a.ApplyURL,
				ClaimToken:      a.ClaimToken,
				ExtractedFields: fields,
			})
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(outputs); err != nil {
			return fmt.Errorf("encoding JSON: %w", err)
		}
	}

	return nil
}

func generateClaimToken(agentID string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%s-%x-%x-%x-%x-%x", agentID, b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ─── apply submit ─────────────────────────────────────────────────────────────

var (
	submitClaimToken  string
	submitPayloadFile string
	submitOTPMailbox  string
	submitDetach      bool
	submitJobID       string
)

func registerSubmitCmd() {
	cmd := &cobra.Command{
		Use:   "submit",
		Short: "Submit filled answers and run the filler for claimed jobs",
		RunE:  runSubmit,
	}

	cmd.Flags().StringVar(&submitClaimToken, "claim-token", "", "Claim token from 'apply claim' (required)")
	cmd.Flags().StringVar(&submitPayloadFile, "payload-file", "", "Path to JSON file with answers (required)")
	cmd.Flags().StringVar(&submitOTPMailbox, "otp-mailbox", "", "OTP mailbox for greenhouse, e.g. gmail:user@example.com")
	cmd.Flags().BoolVar(&submitDetach, "detach", false, "Don't wait for filler to complete")
	cmd.Flags().StringVar(&submitJobID, "job-id", "", "Target specific job_id when claim token covers multiple jobs")
	_ = cmd.MarkFlagRequired("claim-token")
	_ = cmd.MarkFlagRequired("payload-file")

	applyCmd.AddCommand(cmd)
}

func runSubmit(cmd *cobra.Command, args []string) error {
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer sqlDB.Close()

	// 1. Validate: look up applications with this claim_token, status must be 'claimed'
	claimedApps, err := getApplicationsByClaimToken(sqlDB, submitClaimToken)
	if err != nil {
		return fmt.Errorf("looking up claimed applications: %w", err)
	}
	if len(claimedApps) == 0 {
		return fmt.Errorf("no applications found with claim_token %q (or wrong status)", submitClaimToken)
	}
	// When --job-id is given, narrow to that specific job within the batch.
	if submitJobID != "" {
		var filtered []model.Application
		for _, a := range claimedApps {
			if a.JobID == submitJobID {
				filtered = append(filtered, a)
			}
		}
		if len(filtered) == 0 {
			return fmt.Errorf("no claimed application found for job_id %q with this claim token", submitJobID)
		}
		claimedApps = filtered
	}
	for _, a := range claimedApps {
		if a.Status != model.StatusClaimed {
			return fmt.Errorf("application %d has status %q, expected %q", a.ID, a.Status, model.StatusClaimed)
		}
	}

	// Use the first application for platform/jobID
	ref := claimedApps[0]

	// 2. Filling-slot queue: wait as long as it takes for one of the 5
	// active-fill slots (recovery-phase jobs are exempt — see
	// GetActiveFillingCount). No timeout: submits queue until the run
	// drains. Stale 'filling' rows from dead fillers are reclaimed every
	// minute so a crashed fill can never deadlock the queue.
	printedWaiting := false
	waitStart := time.Now()
	lastMaintenance := time.Now()
	for {
		count, countErr := db.GetActiveFillingCount(sqlDB)
		if countErr != nil {
			return fmt.Errorf("checking fill count: %w", countErr)
		}
		if count < 5 {
			break
		}
		if !printedWaiting {
			fmt.Println("5 jobs already filling; queued — waiting for a slot...")
			printedWaiting = true
		}
		if time.Since(lastMaintenance) >= time.Minute {
			lastMaintenance = time.Now()
			if reclaimed, reclaimErr := db.ReclaimStaleFilling(sqlDB, 30); reclaimErr == nil && reclaimed > 0 {
				fmt.Printf("reclaimed %d stale filling slot(s) from dead fillers\n", reclaimed)
			}
			fmt.Printf("still waiting for a filling slot (%d active fills, waited %dm)\n",
				count, int(time.Since(waitStart).Minutes()))
		}
		time.Sleep(2 * time.Second)
	}

	// 3. Copy payload to job output dir
	outputDir := apply.JobOutputDir(ref.Platform, ref.JobID)
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return fmt.Errorf("creating output dir: %w", err)
	}
	payloadDest := filepath.Join(outputDir, "fill_payload.json")
	payloadData, err := os.ReadFile(submitPayloadFile)
	if err != nil {
		return fmt.Errorf("reading payload file: %w", err)
	}
	if err := os.WriteFile(payloadDest, payloadData, 0644); err != nil {
		return fmt.Errorf("copying payload file: %w", err)
	}

	// 4. Mark filling — only the targeted job (ref), not the whole batch.
	if err := db.MarkFillingByID(sqlDB, ref.ID, payloadDest); err != nil {
		return fmt.Errorf("marking filling: %w", err)
	}

	// 5. Launch filler
	fillerCmd, resultPath, err := apply.RunFillerAsync(ref.Platform, payloadDest, outputDir, submitOTPMailbox, ref.CompanySlug)
	if err != nil {
		return fmt.Errorf("starting filler: %w", err)
	}

	// 6. Handle detach
	if submitDetach {
		fmt.Println("Filler started (detached). Check 'apply status' for results.")
		return nil
	}

	// 7. Wait for filler — WaitFiller returns (content, err) where content may be
	// non-empty even when err != nil (partial result file written before subprocess crash).
	resultJSON, waitErr := apply.WaitFiller(fillerCmd, resultPath)

	// 8. Parse result and update DB.
	// Dispatch is keyed on fill_result content, not subprocess exit code.
	var fillResult map[string]interface{}
	if resultJSON != "" {
		_ = json.Unmarshal([]byte(resultJSON), &fillResult)
	}

	// Prefer submission.status (greenhouse/ashby/lever write real outcome there).
	// Fall back to top-level status for any platform that writes it directly.
	fillStatus := ""
	if sub, ok := fillResult["submission"].(map[string]interface{}); ok {
		if ss, ok := sub["status"].(string); ok && ss != "" {
			fillStatus = ss
		}
	}
	if fillStatus == "" {
		if s, ok := fillResult["status"].(string); ok {
			fillStatus = s
		}
	}

	// Only a detector-confirmed 'submitted' counts. The old optimistic set
	// (not_confirmed/otp_*) predates AI recovery and mislabeled captcha- and
	// OTP-blocked applications as submitted, polluting the app's applied
	// history and hiding the AI failure diagnosis carried in fill_result.
	submittedStatuses := map[string]bool{
		"submitted": true,
	}
	if submittedStatuses[fillStatus] {
		if err := db.MarkSubmittedByID(sqlDB, ref.ID, resultJSON); err != nil {
			return fmt.Errorf("marking submitted: %w", err)
		}
		fmt.Printf("Submission result: %s\n", fillStatus)
	} else {
		// Subprocess error or unrecognized status → mark failed
		errMsg := waitErr
		if errMsg == nil {
			errMsg = fmt.Errorf("filler returned status %q", fillStatus)
		}
		_ = db.MarkFailed(sqlDB, ref.ID, errMsg.Error())
		if waitErr != nil {
			return fmt.Errorf("filler failed: %w", waitErr)
		}
		fmt.Printf("Submission failed with status: %s\n", fillStatus)
	}

	return nil
}

// getApplicationsByClaimToken returns applications matching a claim token.
func getApplicationsByClaimToken(sqlDB *sql.DB, claimToken string) ([]model.Application, error) {
	rows, err := sqlDB.Query(`
		SELECT id, job_id, platform, company_slug, company_name, job_title,
		       apply_url, status, extracted_fields_path, fill_payload_path,
		       fill_result, claim_token, claimed_at, error, created_at, updated_at
		FROM applications WHERE claim_token=?
	`, claimToken)
	if err != nil {
		return nil, fmt.Errorf("query applications by claim_token: %w", err)
	}
	defer rows.Close()

	var apps []model.Application
	for rows.Next() {
		var a model.Application
		var extractedFieldsPath, fillPayloadPath, fillResult, ct, errStr sql.NullString
		var claimedAt, createdAt, updatedAt sql.NullTime

		err := rows.Scan(
			&a.ID, &a.JobID, &a.Platform, &a.CompanySlug, &a.CompanyName, &a.JobTitle,
			&a.ApplyURL, &a.Status,
			&extractedFieldsPath, &fillPayloadPath, &fillResult,
			&ct, &claimedAt, &errStr, &createdAt, &updatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan application: %w", err)
		}
		a.ExtractedFieldsPath = extractedFieldsPath.String
		a.FillPayloadPath = fillPayloadPath.String
		a.FillResult = fillResult.String
		a.ClaimToken = ct.String
		a.Error = errStr.String
		if claimedAt.Valid {
			t := claimedAt.Time
			a.ClaimedAt = &t
		}
		if createdAt.Valid {
			a.CreatedAt = createdAt.Time
		}
		if updatedAt.Valid {
			a.UpdatedAt = updatedAt.Time
		}
		apps = append(apps, a)
	}
	return apps, rows.Err()
}

// ─── apply status ─────────────────────────────────────────────────────────────

var (
	statusPlatform string
	statusCompany  string
	statusFormat   string
	statusVerbose  bool
)

func registerStatusCmd() {
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show application pipeline counts by status",
		RunE:  runStatus,
	}

	cmd.Flags().StringVar(&statusPlatform, "platform", "", "Filter by platform")
	cmd.Flags().StringVar(&statusCompany, "company", "", "Filter by company slug")
	cmd.Flags().StringVar(&statusFormat, "format", "table", "Output format: table (default) | json")
	cmd.Flags().BoolVar(&statusVerbose, "verbose", false, "List individual jobs per status")

	applyCmd.AddCommand(cmd)
}

var statusOrder = []model.ApplicationStatus{
	model.StatusQueued,
	model.StatusExtracting,
	model.StatusExtracted,
	model.StatusClaimed,
	model.StatusFilling,
	model.StatusSubmitted,
	model.StatusFailed,
}

func runStatus(cmd *cobra.Command, args []string) error {
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer sqlDB.Close()

	// If platform or company filter is active, compute filtered counts inline.
	// GetStatusCounts has no filter args, so we query directly.
	var counts map[model.ApplicationStatus]int
	if statusPlatform != "" || statusCompany != "" {
		counts, err = getFilteredStatusCounts(sqlDB, statusPlatform, statusCompany)
	} else {
		counts, err = db.GetStatusCounts(sqlDB)
	}
	if err != nil {
		return fmt.Errorf("getting status counts: %w", err)
	}

	format := strings.ToLower(strings.TrimSpace(statusFormat))

	switch format {
	case "json":
		out := make(map[string]int)
		for _, s := range statusOrder {
			out[string(s)] = counts[s]
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	default: // table
		fmt.Printf("%-14s  %5s\n", "STATUS", "COUNT")
		fmt.Println(strings.Repeat("-", 22))
		for _, s := range statusOrder {
			fmt.Printf("%-14s  %5d\n", string(s), counts[s])
		}
	}

	if statusVerbose {
		for _, s := range statusOrder {
			if counts[s] == 0 {
				continue
			}
			fmt.Printf("\n── %s ──\n", string(s))
			filter := db.ApplicationFilter{
				Statuses: []model.ApplicationStatus{s},
				Platform: statusPlatform,
				Company:  statusCompany,
				Limit:    100,
			}
			apps, listErr := db.ListApplications(sqlDB, filter)
			if listErr != nil {
				fmt.Printf("  (error listing: %v)\n", listErr)
				continue
			}
			for _, a := range apps {
				fmt.Printf("  [%d] %s/%s — %s\n", a.ID, a.Platform, a.CompanySlug, a.JobTitle)
			}
		}
	}

	return nil
}

// ─── apply list ───────────────────────────────────────────────────────────────

var (
	listStatus string
	listLimit  int
	listFormat string
)

func registerListCmd() {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List applications with optional filtering",
		RunE:  runList,
	}

	cmd.Flags().StringVar(&listStatus, "status", "", "Comma-separated statuses: queued,extracted,claimed,filling,submitted,failed")
	cmd.Flags().IntVar(&listLimit, "limit", 25, "Max results")
	cmd.Flags().StringVar(&listFormat, "format", "table", "Output format: table (default) | json | csv")

	applyCmd.AddCommand(cmd)
}

func runList(cmd *cobra.Command, args []string) error {
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer sqlDB.Close()

	// Parse statuses
	var statuses []model.ApplicationStatus
	if listStatus != "" {
		for _, s := range splitTrim(listStatus, ",") {
			statuses = append(statuses, model.ApplicationStatus(s))
		}
	}

	filter := db.ApplicationFilter{
		Statuses: statuses,
		Limit:    listLimit,
	}

	apps, err := db.ListApplications(sqlDB, filter)
	if err != nil {
		return fmt.Errorf("listing applications: %w", err)
	}

	if len(apps) == 0 {
		fmt.Println("No applications found.")
		return nil
	}

	format := strings.ToLower(strings.TrimSpace(listFormat))

	switch format {
	case "json":
		type appJSON struct {
			ID          int64  `json:"id"`
			Title       string `json:"title"`
			Company     string `json:"company"`
			Platform    string `json:"platform"`
			Status      string `json:"status"`
			Updated     string `json:"updated"`
			ApplyURL    string `json:"apply_url"`
			ClaimToken  string `json:"claim_token,omitempty"`
			Error       string `json:"error,omitempty"`
		}
		var out []appJSON
		for _, a := range apps {
			out = append(out, appJSON{
				ID:         a.ID,
				Title:      a.JobTitle,
				Company:    a.CompanySlug,
				Platform:   a.Platform,
				Status:     string(a.Status),
				Updated:    a.UpdatedAt.Format(time.RFC3339),
				ApplyURL:   a.ApplyURL,
				ClaimToken: a.ClaimToken,
				Error:      a.Error,
			})
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)

	case "csv":
		w := csv.NewWriter(os.Stdout)
		_ = w.Write([]string{"ID", "TITLE", "COMPANY", "PLATFORM", "STATUS", "UPDATED"})
		for _, a := range apps {
			_ = w.Write([]string{
				fmt.Sprintf("%d", a.ID),
				a.JobTitle,
				a.CompanySlug,
				a.Platform,
				string(a.Status),
				a.UpdatedAt.Format(time.RFC3339),
			})
		}
		w.Flush()
		return w.Error()

	default: // table
		fmt.Printf("%-5s  %-40s  %-20s  %-12s  %-12s  %-20s\n",
			"ID", "TITLE", "COMPANY", "PLATFORM", "STATUS", "UPDATED")
		fmt.Println(strings.Repeat("-", 115))
		for _, a := range apps {
			fmt.Printf("%-5d  %-40s  %-20s  %-12s  %-12s  %-20s\n",
				a.ID,
				truncate(a.JobTitle, 40),
				truncate(a.CompanySlug, 20),
				a.Platform,
				string(a.Status),
				a.UpdatedAt.Format("2006-01-02 15:04"),
			)
		}
	}

	return nil
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func splitTrim(s, sep string) []string {
	var out []string
	for _, part := range strings.Split(s, sep) {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-3] + "..."
}

// getFilteredStatusCounts returns status counts filtered by platform and/or company slug.
func getFilteredStatusCounts(sqlDB *sql.DB, platform, company string) (map[model.ApplicationStatus]int, error) {
	var clauses []string
	var args []interface{}
	if platform != "" {
		clauses = append(clauses, "platform=?")
		args = append(args, platform)
	}
	if company != "" {
		clauses = append(clauses, "company_slug=?")
		args = append(args, company)
	}
	query := `SELECT status, COUNT(*) FROM applications`
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	query += " GROUP BY status"

	rows, err := sqlDB.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("filtered status counts: %w", err)
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
