package db

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"jobscan/internal/market"
	"jobscan/internal/model"
	"jobscan/internal/queryparser"
)

func TestBuildWhereIncludesKeyQuery(t *testing.T) {
	info := buildWhere(model.SearchParams{
		Query:       "engineer",
		KeyQueryFTS: `(description_plain : "Go") OR ((description_plain : "Rust") AND (description_plain : "C++"))`,
	})

	if !info.hasFTS {
		t.Fatalf("expected FTS query")
	}

	want := `title : "engineer" AND ((description_plain : "Go") OR ((description_plain : "Rust") AND (description_plain : "C++")))`
	if info.ftsArg != want {
		t.Fatalf("ftsArg = %q, want %q", info.ftsArg, want)
	}

	if info.where != "jobs_fts MATCH ?" {
		t.Fatalf("where = %q, want jobs_fts MATCH ?", info.where)
	}
}

func TestBuildWhereIncludesTitleAndExcludeKeyQueries(t *testing.T) {
	info := buildWhere(model.SearchParams{
		TitleQueryFTS:      `(title : "software engineer") OR (title : "backend engineer")`,
		ExcludeKeyQueryFTS: `(description_plain : "security clearance") OR (description_plain : "embedded systems")`,
	})

	want := `(((title : "software engineer") OR (title : "backend engineer"))) NOT ((description_plain : "security clearance") OR (description_plain : "embedded systems"))`
	if info.ftsArg != want {
		t.Fatalf("ftsArg = %q, want %q", info.ftsArg, want)
	}
}

func TestBuildWhereIncludesExcludeTitlePhrases(t *testing.T) {
	info := buildWhere(model.SearchParams{
		Query: "software engineer",
		ExcludeTitlePhrases: []string{
			" Senior Software Engineer ",
			"",
			"100% Software_Engineer",
		},
	})

	wantWhere := "jobs_fts MATCH ? AND LOWER(j.title) NOT LIKE ? ESCAPE '\\' AND LOWER(j.title) NOT LIKE ? ESCAPE '\\'"
	if info.where != wantWhere {
		t.Fatalf("where = %q, want %q", info.where, wantWhere)
	}

	wantArgs := []interface{}{
		`title : "software engineer"`,
		`%senior software engineer%`,
		`%100\% software\_engineer%`,
	}
	assertArgs(t, info.allArgs, wantArgs)
	assertArgs(t, info.postFTSArgs, wantArgs[1:])
}

func TestBuildWhereFTSClauses(t *testing.T) {
	tests := []struct {
		name   string
		params model.SearchParams
		want   string
	}{
		{
			name:   "raw query passes through, parenthesised",
			params: model.SearchParams{Query: `title : "engineer"`, SearchRaw: true},
			want:   `(title : "engineer")`,
		},
		{
			name:   "desc query has no title prefix",
			params: model.SearchParams{Query: "machine learning", SearchDesc: true},
			want:   `"machine learning"`,
		},
		{
			name:   "location values are ORed",
			params: model.SearchParams{Query: "engineer", Location: []string{"Amsterdam", "Dublin"}},
			want:   `title : "engineer" AND location : ("Amsterdam" OR "Dublin")`,
		},
		{
			name: "market terms match location or country",
			params: model.SearchParams{
				Query:          "engineer",
				MarketLocation: []string{"United States", "Remote US", "Austin"},
				MarketCountry:  []string{"United States", "USA", "US"},
			},
			want: `title : "engineer" AND (location : ("United States" OR "Remote US" OR "Austin") OR country : ("United States" OR "USA" OR "US"))`,
		},
		{
			name:   "workplace employment country platform department filters",
			params: model.SearchParams{Query: "engineer", WorkplaceType: "Remote", EmploymentType: "Full-Time", Country: "United States", Platforms: []string{"GreenHouse", "Lever"}, Department: "Engineering"},
			want:   `title : "engineer" AND department : "Engineering" AND (workplace_type : "Remote" OR location : "Remote") AND employment_type : "Full-Time" AND country : "United States" AND platform : ("greenhouse" OR "lever")`,
		},
		{
			name:   "hybrid workplace filter stays explicit",
			params: model.SearchParams{Query: "engineer", WorkplaceType: "Hybrid"},
			want:   `title : "engineer" AND workplace_type : "Hybrid"`,
		},
		{
			// Every part is joined with " AND " and FTS5 binds AND tighter than
			// OR, so a bare raw query with a top-level OR escaped every other
			// filter: --raw "title:kubernetes OR title:golang" --platform lever
			// returned 118 rows where 32 match.
			name:   "a raw query is parenthesised so its OR cannot escape the filters",
			params: model.SearchParams{Query: "title : kubernetes OR title : golang", SearchRaw: true, Platforms: []string{"lever"}},
			want:   `(title : kubernetes OR title : golang) AND platform : ("lever")`,
		},
		{
			// --location is ANDed in on its own and must survive --market.
			name:   "an explicit location ANDs with a market",
			params: model.SearchParams{Query: "engineer", Location: []string{"Austin"}, Markets: []string{"usa"}},
			want:   `title : "engineer" AND location : ("Austin")`,
		},
		{
			name:   "onsite workplace filter stays explicit",
			params: model.SearchParams{Query: "engineer", WorkplaceType: "On-Site"},
			want:   `title : "engineer" AND workplace_type : "On-Site"`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := buildWhere(tt.params)
			if info.ftsArg != tt.want {
				t.Fatalf("ftsArg = %q, want %q", info.ftsArg, tt.want)
			}
		})
	}
}

func TestBuildWhereSQLClauses(t *testing.T) {
	info := buildWhere(model.SearchParams{
		Query:     "engineer",
		Since:     "2026-04-01",
		Before:    "2026-05-01",
		Companies: []string{"Acme", "Stripe"},
	})

	wantWhere := "jobs_fts MATCH ? AND j.posted_at >= ? AND j.posted_at < ? AND LOWER(j.company_slug) IN (?,?)"
	if info.where != wantWhere {
		t.Fatalf("where = %q, want %q", info.where, wantWhere)
	}
	if len(info.postFTSClauses) != 3 {
		t.Fatalf("postFTSClauses = %v, want date/date/company clauses", info.postFTSClauses)
	}
	wantArgs := []interface{}{
		`title : "engineer" AND company_slug : ("acme" OR "stripe")`,
		"2026-04-01T00:00:00Z",
		"2026-05-01T00:00:00Z",
		"acme",
		"stripe",
	}
	assertArgs(t, info.allArgs, wantArgs)
}

func TestBuildWhereCompanyOnlyUsesSQL(t *testing.T) {
	info := buildWhere(model.SearchParams{
		Companies: []string{" Acme "},
	})

	if info.hasFTS {
		t.Fatalf("company-only filter should not force FTS")
	}
	if info.where != "LOWER(j.company_slug) IN (?)" {
		t.Fatalf("where = %q, want company SQL filter", info.where)
	}
	assertArgs(t, info.allArgs, []interface{}{"acme"})
}

func TestBuildWhereMarketsUseSQLMembership(t *testing.T) {
	info := buildWhere(model.SearchParams{
		Query:   "engineer",
		Markets: []string{" usa ", "europe", "USA"},
	})

	if !info.hasFTS {
		t.Fatalf("expected title query to use FTS")
	}
	wantWhere := "jobs_fts MATCH ? AND j.rowid IN (SELECT job_rowid FROM job_markets WHERE market IN (?,?))"
	if info.where != wantWhere {
		t.Fatalf("where = %q, want %q", info.where, wantWhere)
	}
	wantArgs := []interface{}{`title : "engineer"`, "usa", "europe"}
	assertArgs(t, info.allArgs, wantArgs)
	assertArgs(t, info.postFTSArgs, wantArgs[1:])
}

func TestBuildWhereCompanyCanAnchorExcludeKeyQuery(t *testing.T) {
	info := buildWhere(model.SearchParams{
		Companies:          []string{"Acme"},
		ExcludeKeyQueryFTS: `(description_plain : "firmware")`,
	})

	if !info.hasFTS {
		t.Fatalf("company + exclude-key should use FTS")
	}
	wantFTS := `(company_slug : ("acme")) NOT ((description_plain : "firmware"))`
	if info.ftsArg != wantFTS {
		t.Fatalf("ftsArg = %q, want %q", info.ftsArg, wantFTS)
	}
	wantWhere := "jobs_fts MATCH ? AND LOWER(j.company_slug) IN (?)"
	if info.where != wantWhere {
		t.Fatalf("where = %q, want %q", info.where, wantWhere)
	}
}

func TestSearchJobsTitleQueryAndExcludeKeyQuerySemantics(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	titleNode, err := queryparser.Parse(`('software engineer' OR 'backend engineer' OR 'platform engineer') AND NOT ('senior software engineer' OR 'staff software engineer' OR 'staff backend engineer' OR manager)`)
	if err != nil {
		t.Fatalf("Parse(title) error = %v", err)
	}
	excludeNode, err := queryparser.Parse(`'security clearance' OR firmware OR 'embedded systems' OR wordpress`)
	if err != nil {
		t.Fatalf("Parse(exclude) error = %v", err)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJob("job-1", "Software Engineer", "distributed systems with Go and Kafka", now),
		testJob("job-2", "Backend Engineer", "distributed backend services with Python", now),
		testJob("job-3", "Platform Engineer", "Kubernetes infrastructure", now),
		testJob("job-4", "Senior Software Engineer", "distributed systems with Go", now),
		testJob("job-5", "Staff Backend Engineer", "distributed systems with Go", now),
		testJob("job-6", "Software Engineering Manager", "distributed systems with Go", now),
		testJob("job-7", "Software Engineer", "active security clearance required", now),
		testJob("job-8", "Backend Engineer", "firmware and embedded systems", now),
		testJob("job-9", "Data Engineer", "distributed systems with Go", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, total, _, err := SearchJobs(db, model.SearchParams{
		TitleQueryFTS:      queryparser.CompileFTSForColumn(titleNode, "title"),
		ExcludeKeyQueryFTS: queryparser.CompileFTSForColumn(excludeNode, "description_plain"),
		SortBy:             "title",
		Limit:              25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}
	assertJobIDs(t, gotJobs, []string{"job-1", "job-2", "job-3"})
	if total != 3 {
		t.Fatalf("total = %d, want 3; ids=%v", total, jobIDs(gotJobs))
	}
}

func TestSearchJobsRemoteMatchesWorkplaceTypeOrLocation(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJobWith("job-1", "Software Engineer", "ashby", "acme", "Austin, TX", "Engineering", "Full-Time", "Remote", "United States", "backend systems", now),
		testJobWith("job-2", "Software Engineer", "greenhouse", "acme", "Remote - United States", "Engineering", "", "", "", "backend systems", now),
		testJobWith("job-3", "Software Engineer", "greenhouse", "acme", "Austin, TX", "Engineering", "", "", "", "backend systems", now),
		testJobWith("job-4", "Software Engineer", "lever", "acme", "Dublin, Ireland", "Engineering", "Full-Time", "Hybrid", "Ireland", "backend systems", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, total, _, err := SearchJobs(db, model.SearchParams{
		Query:         "software engineer",
		WorkplaceType: "Remote",
		SortBy:        "title",
		Limit:         25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2", total)
	}
	assertJobIDs(t, gotJobs, []string{"job-1", "job-2"})
}

func TestSearchJobsRemoteFallbackWorksInCTEPath(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC()
	postedAt := now.Format(time.RFC3339)
	oldPostedAt := now.AddDate(-2, 0, 0).Format(time.RFC3339)
	jobs := []model.Job{
		testJobWith("job-1", "Software Engineer", "ashby", "acme", "Austin, TX", "Engineering", "Full-Time", "Remote", "United States", "distributed systems Kafka", postedAt),
		testJobWith("job-2", "Software Engineer", "greenhouse", "acme", "Remote - United States", "Engineering", "", "", "", "distributed systems Kafka", postedAt),
		testJobWith("job-3", "Software Engineer", "greenhouse", "acme", "Austin, TX", "Engineering", "", "", "", "distributed systems Kafka", postedAt),
		testJobWith("job-4", "Software Engineer", "greenhouse", "acme", "Remote - United States", "Engineering", "", "", "", "distributed systems Kafka", oldPostedAt),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, total, _, err := SearchJobs(db, model.SearchParams{
		Query:         "software engineer",
		KeyQueryFTS:   `(description_plain : "distributed systems")`,
		WorkplaceType: "Remote",
		Since:         "365d",
		SortBy:        "relevance",
		Limit:         25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2", total)
	}
	assertJobIDs(t, gotJobs, []string{"job-1", "job-2"})
}

func TestSearchJobsWithMarketTermsAndRemoteSemantics(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	resolved, err := market.Resolve([]string{"usa"})
	if err != nil {
		t.Fatalf("market.Resolve() error = %v", err)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJobWith("job-1", "Software Engineer", "ashby", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "distributed systems", now),
		testJobWith("job-2", "Software Engineer", "greenhouse", "acme", "Remote - US", "Engineering", "", "", "", "distributed systems", now),
		testJobWith("job-3", "Software Engineer", "greenhouse", "acme", "Remote", "Engineering", "", "", "", "distributed systems", now),
		testJobWith("job-4", "Software Engineer", "greenhouse", "acme", "Remote - Germany", "Engineering", "", "", "", "distributed systems", now),
		testJobWith("job-5", "Software Engineer", "lever", "acme", "Berlin, Germany", "Engineering", "Full-Time", "Remote", "Germany", "distributed systems", now),
		testJobWith("job-6", "Software Engineer", "greenhouse", "acme", "Boise, Idaho", "Engineering", "", "", "", "distributed systems", now),
		testJobWith("job-7", "Software Engineer", "lever", "acme", "Remote", "Engineering", "Full-Time", "Remote", "United States", "distributed systems", now),
		testJobWith("job-8", "Software Engineer", "lever", "acme", "Remote", "Engineering", "Full-Time", "Remote", "Germany", "distributed systems", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, total, _, err := SearchJobs(db, model.SearchParams{
		Query:          "software engineer",
		MarketLocation: resolved.LocationTerms,
		MarketCountry:  resolved.CountryTerms,
		SortBy:         "title",
		Limit:          25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() market-only error = %v", err)
	}
	if total != 4 {
		t.Fatalf("market-only total = %d, want 4", total)
	}
	assertJobIDs(t, gotJobs, []string{"job-1", "job-2", "job-6", "job-7"})

	gotJobs, total, _, err = SearchJobs(db, model.SearchParams{
		Query:          "software engineer",
		MarketLocation: resolved.LocationTerms,
		MarketCountry:  resolved.CountryTerms,
		WorkplaceType:  "Remote",
		SortBy:         "title",
		Limit:          25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() market remote error = %v", err)
	}
	if total != 3 {
		t.Fatalf("market remote total = %d, want 3", total)
	}
	assertJobIDs(t, gotJobs, []string{"job-1", "job-2", "job-7"})
}

func TestSearchJobsWithPrecomputedMarkets(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJobWith("job-1", "Software Engineer", "ashby", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "distributed systems", now),
		testJobWith("job-2", "Software Engineer", "greenhouse", "acme", "Remote - US", "Engineering", "", "", "", "distributed systems", now),
		testJobWith("job-3", "Software Engineer", "greenhouse", "acme", "Remote", "Engineering", "", "", "", "distributed systems", now),
		testJobWith("job-4", "Software Engineer", "greenhouse", "acme", "Remote - Germany", "Engineering", "", "", "", "distributed systems", now),
		testJobWith("job-5", "Software Engineer", "lever", "acme", "Berlin, Germany", "Engineering", "Full-Time", "Remote", "Germany", "distributed systems", now),
		testJobWith("job-6", "Software Engineer", "greenhouse", "acme", "Boise, Idaho", "Engineering", "", "", "", "distributed systems", now),
		testJobWith("job-7", "Software Engineer", "lever", "acme", "Remote", "Engineering", "Full-Time", "Remote", "United States", "distributed systems", now),
		testJobWith("job-8", "Software Engineer", "lever", "acme", "Remote", "Engineering", "Full-Time", "Remote", "Germany", "distributed systems", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, total, _, err := SearchJobs(db, model.SearchParams{
		Query:   "software engineer",
		Markets: []string{"usa"},
		SortBy:  "title",
		Limit:   25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() market error = %v", err)
	}
	if total != 4 {
		t.Fatalf("market total = %d, want 4", total)
	}
	assertJobIDs(t, gotJobs, []string{"job-1", "job-2", "job-6", "job-7"})

	gotJobs, total, _, err = SearchJobs(db, model.SearchParams{
		Query:   "software engineer",
		Markets: []string{"remote-global", "usa"},
		SortBy:  "title",
		Limit:   25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() multi-market error = %v", err)
	}
	if total != 5 {
		t.Fatalf("multi-market total = %d, want 5", total)
	}
	assertJobIDs(t, gotJobs, []string{"job-1", "job-2", "job-3", "job-6", "job-7"})
}

func TestSearchJobsKeyQueryPhraseAndBooleanSemantics(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		{
			ID:               "job-1",
			Platform:         "greenhouse",
			CompanySlug:      "acme",
			CompanyName:      "Acme",
			JobID:            "1",
			Title:            "Software Engineer",
			DescriptionPlain: "distributed systems with Go and Kafka",
			PostedAt:         now,
			UpdatedAt:        now,
			FetchedAt:        now,
		},
		{
			ID:               "job-2",
			Platform:         "greenhouse",
			CompanySlug:      "acme",
			CompanyName:      "Acme",
			JobID:            "2",
			Title:            "Software Engineer",
			DescriptionPlain: "Rust backend services with Kafka",
			PostedAt:         now,
			UpdatedAt:        now,
			FetchedAt:        now,
		},
		{
			ID:               "job-3",
			Platform:         "greenhouse",
			CompanySlug:      "acme",
			CompanyName:      "Acme",
			JobID:            "3",
			Title:            "Software Engineer",
			DescriptionPlain: "distributed platform engineering",
			PostedAt:         now,
			UpdatedAt:        now,
			FetchedAt:        now,
		},
		{
			ID:               "job-4",
			Platform:         "greenhouse",
			CompanySlug:      "acme",
			CompanyName:      "Acme",
			JobID:            "4",
			Title:            "Data Engineer",
			DescriptionPlain: "distributed systems with Go and Kafka",
			PostedAt:         now,
			UpdatedAt:        now,
			FetchedAt:        now,
		},
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	tests := []struct {
		name        string
		keyQueryFTS string
		wantIDs     []string
	}{
		{
			name:        "phrase matches exact phrase",
			keyQueryFTS: `(description_plain : "distributed systems")`,
			wantIDs:     []string{"job-1"},
		},
		{
			name:        "phrase or boolean branch keeps matches",
			keyQueryFTS: `(description_plain : "distributed systems") OR (((description_plain : "Go") OR (description_plain : "Rust") OR (description_plain : "C++")) AND ((description_plain : "Kafka") OR (description_plain : "event-driven")))`,
			wantIDs:     []string{"job-1", "job-2"},
		},
		{
			name:        "boolean branch excludes missing term",
			keyQueryFTS: `((description_plain : "Go") OR (description_plain : "Rust") OR (description_plain : "C++")) AND ((description_plain : "Kafka") OR (description_plain : "event-driven"))`,
			wantIDs:     []string{"job-1", "job-2"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotJobs, _, _, err := SearchJobs(db, model.SearchParams{
				Query:       "software engineer",
				KeyQueryFTS: tt.keyQueryFTS,
				Limit:       25,
			})
			if err != nil {
				t.Fatalf("SearchJobs() error = %v", err)
			}

			var gotIDs []string
			for _, job := range gotJobs {
				gotIDs = append(gotIDs, job.ID)
			}

			if len(gotIDs) != len(tt.wantIDs) {
				t.Fatalf("got IDs %v, want %v", gotIDs, tt.wantIDs)
			}
			for i := range gotIDs {
				if gotIDs[i] != tt.wantIDs[i] {
					t.Fatalf("got IDs %v, want %v", gotIDs, tt.wantIDs)
				}
			}
		})
	}
}

func TestSearchJobsWithCompiledPhraseBooleanQuery(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		{
			ID:               "job-1",
			Platform:         "greenhouse",
			CompanySlug:      "acme",
			CompanyName:      "Acme",
			JobID:            "1",
			Title:            "Software Engineer",
			DescriptionPlain: "distributed systems with Go and Kafka",
			PostedAt:         now,
			UpdatedAt:        now,
			FetchedAt:        now,
		},
		{
			ID:               "job-2",
			Platform:         "greenhouse",
			CompanySlug:      "acme",
			CompanyName:      "Acme",
			JobID:            "2",
			Title:            "Software Engineer",
			DescriptionPlain: "Rust backend services with Kafka",
			PostedAt:         now,
			UpdatedAt:        now,
			FetchedAt:        now,
		},
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	node, err := queryparser.Parse(`"distributed systems" OR ((Go OR Rust OR C++) AND (Kafka OR event-driven))`)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}

	gotJobs, _, _, err := SearchJobs(db, model.SearchParams{
		Query:       "software engineer",
		KeyQueryFTS: queryparser.CompileFTS(node),
		Limit:       25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}

	gotIDs := make([]string, 0, len(gotJobs))
	for _, job := range gotJobs {
		gotIDs = append(gotIDs, job.ID)
	}

	wantIDs := []string{"job-1", "job-2"}
	if len(gotIDs) != len(wantIDs) {
		t.Fatalf("got IDs %v, want %v", gotIDs, wantIDs)
	}
	for i := range gotIDs {
		if gotIDs[i] != wantIDs[i] {
			t.Fatalf("got IDs %v, want %v", gotIDs, wantIDs)
		}
	}
}

func TestSearchJobsExcludeTitlePhrases(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJob("job-1", "Software Engineer", "backend distributed systems C++ Go Kafka", now),
		testJob("job-2", "Senior Software Engineer", "backend distributed systems C++ Go Kafka", now),
		testJob("job-3", "Staff Software Engineer", "backend distributed systems C++ Go Kafka", now),
		testJob("job-4", "Principal Software Engineer", "backend distributed systems C++ Go Kafka", now),
		testJob("job-5", "Member of Technical Staff, Software Engineer", "backend distributed systems C++ Go Kafka", now),
		testJob("job-6", "Software Engineering Manager", "backend distributed systems C++ Go Kafka", now),
		testJob("job-7", "Software Engineer, Staff Platform Team", "backend distributed systems C++ Go Kafka", now),
		testJob("job-8", "sEnIoR Software Engineer, Infrastructure", "backend distributed systems C++ Go Kafka", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, _, _, err := SearchJobs(db, model.SearchParams{
		Query: "software engineer",
		ExcludeTitlePhrases: []string{
			" Senior Software Engineer ",
			"Staff Software Engineer",
			"Principal Software Engineer",
			"Lead Software Engineer",
			"Software Engineering Manager",
			"",
		},
		SortBy: "title",
		Limit:  25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}

	assertJobIDs(t, gotJobs, []string{"job-1", "job-5", "job-7"})
}

func TestSearchJobsExcludeTitlePhrasesInCTEPath(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC()
	postedAt := now.Format(time.RFC3339)
	oldPostedAt := now.AddDate(-2, 0, 0).Format(time.RFC3339)
	jobs := []model.Job{
		testJob("job-1", "Software Engineer", "backend distributed systems C++ Go Kafka", postedAt),
		testJob("job-2", "Senior Software Engineer", "backend distributed systems C++ Go Kafka", postedAt),
		testJob("job-3", "Member of Technical Staff, Software Engineer", "backend distributed systems C++ Go Kafka", postedAt),
		testJob("job-4", "Software Engineer", "backend distributed systems C++ Go Kafka", oldPostedAt),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, _, _, err := SearchJobs(db, model.SearchParams{
		Query:               "software engineer",
		KeyQueryFTS:         `(description_plain : "distributed systems")`,
		ExcludeTitlePhrases: []string{"Senior Software Engineer"},
		Since:               "365d",
		SortBy:              "relevance",
		Limit:               25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}

	assertJobIDs(t, gotJobs, []string{"job-1", "job-3"})
}

func TestSearchJobsComposesAllMajorFilters(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJobWith("job-1", "Software Engineer", "greenhouse", "acme", "Amsterdam, Netherlands", "Engineering", "Full-Time", "Remote", "Netherlands", "distributed systems C++ Kafka Kubernetes", now),
		testJobWith("job-2", "Senior Software Engineer", "greenhouse", "acme", "Amsterdam, Netherlands", "Engineering", "Full-Time", "Remote", "Netherlands", "distributed systems C++ Kafka Kubernetes", now),
		testJobWith("job-3", "Software Engineer", "lever", "acme", "Amsterdam, Netherlands", "Engineering", "Full-Time", "Remote", "Netherlands", "distributed systems C++ Kafka Kubernetes", now),
		testJobWith("job-4", "Software Engineer", "greenhouse", "other", "Amsterdam, Netherlands", "Engineering", "Full-Time", "Remote", "Netherlands", "distributed systems C++ Kafka Kubernetes", now),
		testJobWith("job-5", "Software Engineer", "greenhouse", "acme", "Dublin, Ireland", "Engineering", "Full-Time", "Remote", "Ireland", "distributed systems C++ Kafka Kubernetes", now),
		testJobWith("job-6", "Software Engineer", "greenhouse", "acme", "Amsterdam, Netherlands", "Sales", "Full-Time", "Remote", "Netherlands", "distributed systems C++ Kafka Kubernetes", now),
		testJobWith("job-7", "Software Engineer", "greenhouse", "acme", "Amsterdam, Netherlands", "Engineering", "Intern", "Remote", "Netherlands", "distributed systems C++ Kafka Kubernetes", now),
		testJobWith("job-8", "Software Engineer", "greenhouse", "acme", "Amsterdam, Netherlands", "Engineering", "Full-Time", "Hybrid", "Netherlands", "distributed systems C++ Kafka Kubernetes", now),
		testJobWith("job-9", "Software Engineer", "greenhouse", "acme", "Amsterdam, Netherlands", "Engineering", "Full-Time", "Remote", "Netherlands", "frontend React CSS", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, _, _, err := SearchJobs(db, model.SearchParams{
		Query:               "software engineer",
		KeyQueryFTS:         `(description_plain : "distributed systems") AND (description_plain : "Kafka")`,
		ExcludeTitlePhrases: []string{"Senior Software Engineer"},
		Location:            []string{"Amsterdam"},
		WorkplaceType:       "Remote",
		Platforms:           []string{"greenhouse"},
		Companies:           []string{"acme"},
		Department:          "Engineering",
		EmploymentType:      "Full-Time",
		Country:             "Netherlands",
		SortBy:              "title",
		Limit:               25,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}

	assertJobIDs(t, gotJobs, []string{"job-1"})
}

func TestSearchJobsCompanyFilterInCTEPath(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJobWith("job-1", "Software Engineer", "greenhouse", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "distributed systems Kafka", now),
		testJobWith("job-2", "Software Engineer", "greenhouse", "other", "Austin", "Engineering", "Full-Time", "Remote", "United States", "distributed systems Kafka", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, total, companies, err := SearchJobs(db, model.SearchParams{
		Query:       "software engineer",
		KeyQueryFTS: `(description_plain : "distributed systems")`,
		Companies:   []string{"acme"},
		Since:       "365d",
		SortBy:      "relevance",
		Limit:       25,
		CountOnly:   true,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}
	if gotJobs != nil {
		t.Fatalf("count-only expected nil jobs, got %v", gotJobs)
	}
	if total != 1 || companies != 1 {
		t.Fatalf("count-only total,companies = %d,%d; want 1,1", total, companies)
	}
}

func TestSearchJobsPaginationAndSort(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJobWith("job-1", "Alpha Software Engineer", "greenhouse", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "backend", now),
		testJobWith("job-2", "Beta Software Engineer", "greenhouse", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "backend", now),
		testJobWith("job-3", "Gamma Software Engineer", "greenhouse", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "backend", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, total, _, err := SearchJobs(db, model.SearchParams{
		Query:  "software engineer",
		SortBy: "title",
		Limit:  1,
		Offset: 1,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}
	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
	assertJobIDs(t, gotJobs, []string{"job-2"})
}

func TestSearchJobsSkipCountReturnsRowsWithUnknownTotal(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	jobs := []model.Job{
		testJobWith("job-1", "Alpha Software Engineer", "greenhouse", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "backend", now),
		testJobWith("job-2", "Beta Software Engineer", "greenhouse", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "backend", now),
		testJobWith("job-3", "Gamma Software Engineer", "greenhouse", "acme", "Austin", "Engineering", "Full-Time", "Remote", "United States", "backend", now),
	}

	if err := BatchInsert(db, jobs); err != nil {
		t.Fatalf("BatchInsert() error = %v", err)
	}

	gotJobs, total, companies, err := SearchJobs(db, model.SearchParams{
		Query:     "software engineer",
		SortBy:    "title",
		Limit:     1,
		SkipCount: true,
	})
	if err != nil {
		t.Fatalf("SearchJobs() error = %v", err)
	}
	if total != -1 {
		t.Fatalf("total = %d, want -1 unknown total", total)
	}
	if companies != 0 {
		t.Fatalf("companies = %d, want 0 when count is skipped", companies)
	}
	assertJobIDs(t, gotJobs, []string{"job-1"})
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()

	path := filepath.Join(t.TempDir(), "jobs.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	return db
}

func testJob(id, title, description, postedAt string) model.Job {
	return model.Job{
		ID:               id,
		Platform:         "greenhouse",
		CompanySlug:      "acme",
		CompanyName:      "Acme",
		JobID:            id,
		Title:            title,
		DescriptionPlain: description,
		PostedAt:         postedAt,
		UpdatedAt:        postedAt,
		FetchedAt:        postedAt,
	}
}

func testJobWith(id, title, platform, companySlug, location, department, employmentType, workplaceType, country, description, postedAt string) model.Job {
	j := testJob(id, title, description, postedAt)
	j.Platform = platform
	j.CompanySlug = companySlug
	j.CompanyName = companySlug
	j.Location = location
	j.Department = department
	j.EmploymentType = employmentType
	j.WorkplaceType = workplaceType
	j.Country = country
	return j
}

func assertJobIDs(t *testing.T, jobs []model.Job, wantIDs []string) {
	t.Helper()

	got := make(map[string]bool, len(jobs))
	for _, job := range jobs {
		got[job.ID] = true
	}

	if len(got) != len(wantIDs) {
		t.Fatalf("got IDs %v, want %v", jobIDs(jobs), wantIDs)
	}
	for _, id := range wantIDs {
		if !got[id] {
			t.Fatalf("got IDs %v, want %v", jobIDs(jobs), wantIDs)
		}
	}
}

func jobIDs(jobs []model.Job) []string {
	ids := make([]string, 0, len(jobs))
	for _, job := range jobs {
		ids = append(ids, job.ID)
	}
	return ids
}

func assertArgs(t *testing.T, got []interface{}, want []interface{}) {
	t.Helper()

	if len(got) != len(want) {
		t.Fatalf("got args %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("got args %v, want %v", got, want)
		}
	}
}
