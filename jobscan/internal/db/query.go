package db

import (
	"database/sql"
	"fmt"
	"os"
	"strings"
	"time"

	"jobscan/internal/model"
	"jobscan/internal/normalize"
)

const ftsRankExpression = "bm25(jobs_fts, 10.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)"

func SearchJobs(db *sql.DB, params model.SearchParams) ([]model.Job, int, int, error) {
	info := buildWhere(params)
	countInfo := info
	if len(params.Companies) > 0 {
		countInfo = buildWhereForCount(params)
	}

	total := -1
	if params.CountOnly || !params.SkipCount {
		var err error
		total, err = runCountQuery(db, "COUNT(*)", countInfo)
		if err != nil {
			return nil, 0, 0, fmt.Errorf("count query: %w", err)
		}
	}

	if params.CountOnly {
		// Also count distinct companies for the summary line
		var companies int
		companies, _ = runCountQuery(db, "COUNT(DISTINCT j.company_slug)", countInfo)
		return nil, total, companies, nil
	}

	// Sort
	orderBy := "j.posted_at DESC"
	switch strings.ToLower(params.SortBy) {
	case "oldest":
		orderBy = "j.posted_at ASC"
	case "company":
		orderBy = "j.company_name ASC, j.posted_at DESC"
	case "title":
		orderBy = "j.title ASC"
	case "relevance":
		if info.hasFTS {
			// Title match is 10x more important than description match.
			// FTS5 bm25 returns smaller (more negative) values for better matches.
			// 10 columns: title, description_plain, company_slug, company_name,
			// location, department, employment_type, workplace_type, country, platform
			// Recency tiebreaker. Eight of the ten bm25 weights are 0.0, so a
			// query whose only FTS content is company/location/platform/country
			// scores -0.0 on EVERY row and the top-N becomes arbitrary. The
			// sharp case: --company alone stays on the posted_at DESC path, but
			// adding --platform pushes company into the FTS expression, flips
			// hasFTS true, and silently swaps recency for an all-zero sort.
			orderBy = ftsRankExpression + " ASC, j.posted_at DESC"
		}
	}

	// Limit/offset
	limit := params.Limit
	if limit <= 0 {
		limit = 25
	}
	offset := params.Offset
	if offset < 0 {
		offset = 0
	}

	// A diversity filter DISCARDS rows, so asking SQL for exactly `limit` would
	// return fewer than requested -- the opposite of the point. Over-fetch, then
	// trim back to limit after filtering.
	fetchLimit := limit
	if diversityRequested(params) {
		fetchLimit = limit * diversityOverFetch
		if fetchLimit < limit+50 {
			fetchLimit = limit + 50
		}
	}

	// CTE path: when we have FTS + date filter + bm25 sort, compute bm25 from
	// the FTS index first (fast, no table I/O), then JOIN to main table only
	// for the date filter. This avoids random I/O to the 2GB+ table during
	// bm25 computation.
	usesCTE := info.hasFTS && info.hasDateFilter && strings.ToLower(params.SortBy) == "relevance"

	if usesCTE {
		// Build the FTS-only WHERE (just the MATCH clause)
		ftsWhere := "jobs_fts MATCH ?"
		// Build SQL-only filters for the outer query.
		postFTSWhere := strings.Join(info.postFTSClauses, " AND ")
		if postFTSWhere == "" {
			postFTSWhere = "1=1"
		}

		selectSQL := fmt.Sprintf(`
			WITH fts_ranked AS (
				SELECT rowid, %s AS rank
				FROM jobs_fts
				WHERE %s
			)
			SELECT j.id, j.platform, j.company_slug, j.company_name, j.job_id,
			       j.title, j.location, j.department, j.team,
			       j.employment_type, j.workplace_type, j.country,
			       j.job_url, j.apply_url, j.posted_at, j.updated_at,
			       j.description_plain, j.salary_raw, j.fetched_at
			FROM fts_ranked fr
			JOIN jobs j ON j.rowid = fr.rowid
			WHERE %s
			ORDER BY fr.rank ASC, j.posted_at DESC
			LIMIT ? OFFSET ?`, ftsRankExpression, ftsWhere, postFTSWhere)

		var allArgs []interface{}
		allArgs = append(allArgs, info.ftsArg)         // MATCH arg
		allArgs = append(allArgs, info.postFTSArgs...) // SQL-only filters
		allArgs = append(allArgs, fetchLimit, offset)

		rows, err := db.Query(selectSQL, allArgs...)
		if err != nil {
			return nil, 0, 0, fmt.Errorf("search query (CTE): %w", err)
		}
		defer rows.Close()

		var jobs []model.Job
		for rows.Next() {
			var j model.Job
			var descPlain, salaryRaw sql.NullString
			err := rows.Scan(
				&j.ID, &j.Platform, &j.CompanySlug, &j.CompanyName, &j.JobID,
				&j.Title, &j.Location, &j.Department, &j.Team,
				&j.EmploymentType, &j.WorkplaceType, &j.Country,
				&j.JobURL, &j.ApplyURL, &j.PostedAt, &j.UpdatedAt,
				&descPlain, &salaryRaw, &j.FetchedAt,
			)
			if err != nil {
				return nil, 0, 0, fmt.Errorf("scan row: %w", err)
			}
			j.DescriptionPlain = descPlain.String
			j.SalaryRaw = salaryRaw.String
			if j.CompanyName == "" {
				j.CompanyName = j.CompanySlug
			}
			jobs = append(jobs, j)
		}
		return diversify(jobs, params, limit), total, 0, rows.Err()
	}

	// Standard query path (no CTE needed)
	selectSQL := `
		SELECT j.id, j.platform, j.company_slug, j.company_name, j.job_id,
		       j.title, j.location, j.department, j.team,
		       j.employment_type, j.workplace_type, j.country,
		       j.job_url, j.apply_url, j.posted_at, j.updated_at,
		       j.description_plain, j.salary_raw, j.fetched_at
		FROM `

	if info.hasFTS {
		selectSQL += "jobs_fts fts JOIN jobs j ON j.rowid = fts.rowid"
	} else {
		selectSQL += "jobs j"
	}

	if info.where != "" {
		selectSQL += " WHERE " + info.where
	}
	selectSQL += fmt.Sprintf(" ORDER BY %s LIMIT ? OFFSET ?", orderBy)
	allArgs := append(info.allArgs, fetchLimit, offset)

	rows, err := db.Query(selectSQL, allArgs...)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("search query: %w", err)
	}
	defer rows.Close()

	var jobs []model.Job
	for rows.Next() {
		var j model.Job
		var descPlain, salaryRaw sql.NullString
		err := rows.Scan(
			&j.ID, &j.Platform, &j.CompanySlug, &j.CompanyName, &j.JobID,
			&j.Title, &j.Location, &j.Department, &j.Team,
			&j.EmploymentType, &j.WorkplaceType, &j.Country,
			&j.JobURL, &j.ApplyURL, &j.PostedAt, &j.UpdatedAt,
			&descPlain, &salaryRaw, &j.FetchedAt,
		)
		if err != nil {
			return nil, 0, 0, fmt.Errorf("scan row: %w", err)
		}
		j.DescriptionPlain = descPlain.String
		j.SalaryRaw = salaryRaw.String
		// Use slug as display name if company_name not populated
		if j.CompanyName == "" {
			j.CompanyName = j.CompanySlug
		}
		jobs = append(jobs, j)
	}
	return diversify(jobs, params, limit), total, 0, rows.Err()
}

func runCountQuery(db *sql.DB, countExpr string, info whereInfo) (int, error) {
	countSQL := "SELECT " + countExpr + " FROM jobs j"
	if info.hasFTS {
		countSQL = "SELECT " + countExpr + " FROM jobs_fts fts JOIN jobs j ON j.rowid = fts.rowid"
	}
	if info.where != "" {
		countSQL += " WHERE " + info.where
	}

	var count int
	if err := db.QueryRow(countSQL, info.allArgs...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// whereInfo holds the structured output of buildWhere for clean separation
// of FTS, date, and SQL components.
type whereInfo struct {
	where          string        // full WHERE string (all clauses joined)
	allArgs        []interface{} // all args for the full WHERE
	hasFTS         bool
	hasDateFilter  bool
	ftsArg         interface{}   // the single FTS MATCH argument
	postFTSClauses []string      // SQL clauses applied after the FTS rowid set
	postFTSArgs    []interface{} // args for post-FTS clauses only
}

type whereOptions struct {
	pushCompanyIntoFTS bool
}

func buildWhere(params model.SearchParams) whereInfo {
	return buildWhereWithOptions(params, whereOptions{pushCompanyIntoFTS: true})
}

func buildWhereForCount(params model.SearchParams) whereInfo {
	return buildWhereWithOptions(params, whereOptions{pushCompanyIntoFTS: false})
}

func buildWhereWithOptions(params model.SearchParams, opts whereOptions) whereInfo {
	var clauses []string
	var args []interface{}
	var postFTSClauses []string
	var postFTSArgs []interface{}
	var companies []string

	for _, c := range params.Companies {
		if company := strings.ToLower(strings.TrimSpace(c)); company != "" {
			companies = append(companies, company)
		}
	}

	addSQLClause := func(clause string, clauseArgs ...interface{}) {
		clauses = append(clauses, clause)
		args = append(args, clauseArgs...)
		postFTSClauses = append(postFTSClauses, clause)
		postFTSArgs = append(postFTSArgs, clauseArgs...)
	}

	// FTS query
	var ftsQueryParts []string

	if params.Query != "" {
		if params.SearchRaw {
			// Parenthesise: every part here is joined with " AND ", and FTS5 binds
			// AND tighter than OR. Bare, --raw "a OR b" --platform lever parses as
			// a OR (b AND platform:lever) -- 118 rows where 32 match.
			ftsQueryParts = append(ftsQueryParts, "("+params.Query+")")
		} else if params.SearchDesc {
			ftsQueryParts = append(ftsQueryParts, fts5Escape(params.Query))
		} else {
			ftsQueryParts = append(ftsQueryParts, "title : "+fts5Escape(params.Query))
		}
	}

	if params.TitleQueryFTS != "" {
		ftsQueryParts = append(ftsQueryParts, "("+params.TitleQueryFTS+")")
	}

	if params.KeyQueryFTS != "" {
		ftsQueryParts = append(ftsQueryParts, "("+params.KeyQueryFTS+")")
	}

	if len(params.Location) > 0 {
		var locFts []string
		for _, loc := range params.Location {
			locFts = append(locFts, fts5Escape(loc))
		}
		ftsQueryParts = append(ftsQueryParts, "location : ("+strings.Join(locFts, " OR ")+")")
	}

	if len(params.Markets) == 0 && (len(params.MarketLocation) > 0 || len(params.MarketCountry) > 0) {
		var marketParts []string
		if len(params.MarketLocation) > 0 {
			var locFts []string
			for _, loc := range params.MarketLocation {
				locFts = append(locFts, fts5Escape(loc))
			}
			marketParts = append(marketParts, "location : ("+strings.Join(locFts, " OR ")+")")
		}
		if len(params.MarketCountry) > 0 {
			var countryFts []string
			for _, country := range params.MarketCountry {
				countryFts = append(countryFts, fts5Escape(country))
			}
			marketParts = append(marketParts, "country : ("+strings.Join(countryFts, " OR ")+")")
		}
		ftsQueryParts = append(ftsQueryParts, "("+strings.Join(marketParts, " OR ")+")")
	}

	if params.Department != "" {
		ftsQueryParts = append(ftsQueryParts, "department : "+fts5Escape(params.Department))
	}

	// Push filter columns into FTS MATCH (avoids expensive table JOIN)
	if params.WorkplaceType != "" {
		if strings.EqualFold(strings.TrimSpace(params.WorkplaceType), "Remote") {
			ftsQueryParts = append(ftsQueryParts, "(workplace_type : "+fts5Escape("Remote")+" OR location : "+fts5Escape("Remote")+")")
		} else {
			ftsQueryParts = append(ftsQueryParts, "workplace_type : "+fts5Escape(params.WorkplaceType))
		}
	}
	if params.EmploymentType != "" {
		ftsQueryParts = append(ftsQueryParts, "employment_type : "+fts5Escape(params.EmploymentType))
	}
	if params.Country != "" {
		ftsQueryParts = append(ftsQueryParts, "country : "+fts5Escape(params.Country))
	}
	if len(params.Platforms) > 0 {
		var platFts []string
		for _, p := range params.Platforms {
			platFts = append(platFts, fts5Escape(strings.ToLower(p)))
		}
		ftsQueryParts = append(ftsQueryParts, "platform : ("+strings.Join(platFts, " OR ")+")")
	}
	if opts.pushCompanyIntoFTS && len(companies) > 0 && (len(ftsQueryParts) > 0 || params.ExcludeKeyQueryFTS != "") {
		var companyFts []string
		for _, c := range companies {
			companyFts = append(companyFts, fts5Escape(c))
		}
		ftsQueryParts = append(ftsQueryParts, "company_slug : ("+strings.Join(companyFts, " OR ")+")")
	}

	ftsQueryStr := strings.Join(ftsQueryParts, " AND ")
	if params.ExcludeKeyQueryFTS != "" && ftsQueryStr != "" {
		ftsQueryStr = "(" + ftsQueryStr + ") NOT (" + params.ExcludeKeyQueryFTS + ")"
	}
	var ftsArg interface{}
	if ftsQueryStr != "" {
		clauses = append(clauses, "jobs_fts MATCH ?")
		args = append(args, ftsQueryStr)
		ftsArg = ftsQueryStr
	}

	hasFTS := ftsQueryStr != ""

	// Date filters (these MUST remain as SQL WHERE — FTS5 can't do range queries)
	hasDateFilter := false
	// Since (posted_at >=)
	if params.Since != "" {
		t := normalize.ParseSinceFlag(params.Since)
		if !t.IsZero() {
			dateClause := "j.posted_at >= ?"
			dateVal := t.Format(time.RFC3339)
			addSQLClause(dateClause, dateVal)
			hasDateFilter = true
		}
	}

	// Before (posted_at <)
	if params.Before != "" {
		t := normalize.ParseSinceFlag(params.Before)
		if !t.IsZero() {
			dateClause := "j.posted_at < ?"
			dateVal := t.Format(time.RFC3339)
			addSQLClause(dateClause, dateVal)
			hasDateFilter = true
		}
	}

	// Company filter (stays as SQL WHERE — slug matching, not text search)
	if len(companies) > 0 {
		placeholders := strings.Repeat("?,", len(companies))
		placeholders = placeholders[:len(placeholders)-1]
		companyClause := fmt.Sprintf("LOWER(j.company_slug) IN (%s)", placeholders)
		clauses = append(clauses, companyClause)
		postFTSClauses = append(postFTSClauses, companyClause)
		for _, company := range companies {
			args = append(args, company)
			postFTSArgs = append(postFTSArgs, company)
		}
	}

	if len(params.Markets) > 0 {
		markets := make([]string, 0, len(params.Markets))
		seenMarkets := map[string]bool{}
		for _, market := range params.Markets {
			market = strings.ToLower(strings.TrimSpace(market))
			if market == "" || seenMarkets[market] {
				continue
			}
			seenMarkets[market] = true
			markets = append(markets, market)
		}
		if len(markets) > 0 {
			placeholders := strings.Repeat("?,", len(markets))
			placeholders = placeholders[:len(placeholders)-1]
			marketClause := fmt.Sprintf("j.rowid IN (SELECT job_rowid FROM job_markets WHERE market IN (%s))", placeholders)
			clauses = append(clauses, marketClause)
			postFTSClauses = append(postFTSClauses, marketClause)
			for _, market := range markets {
				args = append(args, market)
				postFTSArgs = append(postFTSArgs, market)
			}
		}
	}

	if params.ExcludeKeyQueryFTS != "" && !hasFTS && len(params.Markets) > 0 {
		addSQLClause("j.rowid NOT IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)", params.ExcludeKeyQueryFTS)
	}

	for _, phrase := range params.ExcludeTitlePhrases {
		pattern := titlePhrasePattern(phrase)
		if pattern == "" {
			continue
		}
		addSQLClause("LOWER(j.title) NOT LIKE ? ESCAPE '\\'", pattern)
	}

	return whereInfo{
		where:          strings.Join(clauses, " AND "),
		allArgs:        args,
		hasFTS:         hasFTS,
		hasDateFilter:  hasDateFilter,
		ftsArg:         ftsArg,
		postFTSClauses: postFTSClauses,
		postFTSArgs:    postFTSArgs,
	}
}

func titlePhrasePattern(phrase string) string {
	phrase = strings.ToLower(strings.TrimSpace(phrase))
	if phrase == "" {
		return ""
	}
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(phrase) + "%"
}

// fts5Escape prepares a user query string for FTS5 MATCH.
// Wraps queries in quotes for exact phrase/token matching.
func fts5Escape(q string) string {
	q = strings.TrimSpace(q)
	// If user already provided quotes, pass through
	if strings.HasPrefix(q, `"`) {
		return q
	}
	return `"` + strings.ReplaceAll(q, `"`, `""`) + `"`
}

// GetStats returns aggregate statistics about the database.
func GetStats(db *sql.DB, dbPath string) (*model.Stats, error) {
	stats := &model.Stats{}

	// DB file size
	if info, err := os.Stat(dbPath); err == nil {
		stats.DBSizeBytes = info.Size()
	}

	// Last fetch time
	db.QueryRow(`SELECT MAX(last_fetched) FROM companies WHERE fetch_status = 'done'`).Scan(&stats.LastFetch)

	// Per-platform stats
	rows, err := db.Query(`
		SELECT platform,
		       COUNT(DISTINCT company_slug) as companies,
		       COUNT(*) as jobs
		FROM jobs GROUP BY platform
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	platMap := make(map[string]*model.PlatformStat)
	for rows.Next() {
		var ps model.PlatformStat
		if err := rows.Scan(&ps.Platform, &ps.Companies, &ps.Jobs); err != nil {
			return nil, err
		}
		platMap[ps.Platform] = &ps
		stats.TotalJobs += ps.Jobs
	}

	// Empty/error counts per platform
	rows2, err := db.Query(`
		SELECT platform, fetch_status, COUNT(*) as cnt
		FROM companies
		WHERE fetch_status IN ('empty','error')
		GROUP BY platform, fetch_status
	`)
	if err != nil {
		return nil, err
	}
	defer rows2.Close()
	for rows2.Next() {
		var platform, status string
		var cnt int
		rows2.Scan(&platform, &status, &cnt)
		if ps, ok := platMap[platform]; ok {
			ps.Empty += cnt
		}
	}

	for _, ps := range platMap {
		stats.TotalCompanies += ps.Companies
		stats.Platforms = append(stats.Platforms, *ps)
	}

	// Top departments
	stats.Departments, _ = aggregateQuery(db, `
		SELECT department, COUNT(*) as cnt FROM jobs
		WHERE department != '' AND department IS NOT NULL
		GROUP BY department ORDER BY cnt DESC LIMIT 10
	`)

	// Workplace types
	stats.WorkplaceTypes, _ = aggregateQuery(db, `
		SELECT COALESCE(workplace_type,'Unknown'), COUNT(*) as cnt
		FROM jobs GROUP BY workplace_type ORDER BY cnt DESC
	`)

	// Employment types
	stats.EmploymentTypes, _ = aggregateQuery(db, `
		SELECT COALESCE(employment_type,'Unknown'), COUNT(*) as cnt
		FROM jobs GROUP BY employment_type ORDER BY cnt DESC
	`)

	// Top companies
	stats.TopCompanies, _ = aggregateQuery(db, `
		SELECT company_name, COUNT(*) as cnt FROM jobs
		WHERE company_name != '' AND company_name IS NOT NULL
		GROUP BY company_name ORDER BY cnt DESC LIMIT 10
	`)

	return stats, nil
}

func aggregateQuery(db *sql.DB, q string) ([]model.NameCount, error) {
	rows, err := db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var results []model.NameCount
	for rows.Next() {
		var nc model.NameCount
		if err := rows.Scan(&nc.Name, &nc.Count); err != nil {
			return nil, err
		}
		results = append(results, nc)
	}
	return results, nil
}
