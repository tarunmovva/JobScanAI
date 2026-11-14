package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"jobscan/internal/db"
	"jobscan/internal/market"
	"jobscan/internal/model"
	"jobscan/internal/queryparser"
	"jobscan/internal/render"
)

var searchCmd = &cobra.Command{
	Use:   "search [query]",
	Short: "Search jobs in the local database",
	Long:  searchLongHelp(),
	RunE:  runSearch,
}

func searchLongHelp() string {
	return fmt.Sprintf(`Search and filter jobs stored in the local database.

Search model:
  Positional [query] searches job titles by default.
  Add --desc to search title + description.
  All filters are combined with AND logic.
  Multi-word positional queries match as phrases.

Boolean query flags:
  --title-query searches title only.
  --key-query / -Q searches description_plain only.
  --exclude-key-query excludes description matches and requires a positive search/filter.
  Grammar supports AND, OR, AND NOT, parentheses, and single/double quoted phrases.
  There is no implicit AND: write Go AND Kafka, not Go Kafka.
  Quote multi-word phrases: 'distributed systems' or "software engineer".

PowerShell quoting:
  Recommended: --key-query '"distributed systems" OR (Go AND Kafka)'
  Do not use trailing \ for line continuation in PowerShell; use the backtick character.

Exclusions:
  --exclude-title-phrase is exact title substring exclusion, not Boolean.
  Example: exclude "Senior Software Engineer" without excluding "Member of Technical Staff, Software Engineer".
  --exclude-key-query is Boolean description exclusion for terms like clearance, embedded, or frontend-only.

Markets and locations:
  Prefer --market for broad country/region searches.
  Example: --market usa,canada,uk expands to country and location terms.
  Prefer --market over --country; --country only matches source-provided country text.
  --remote means require remote jobs.
  Without --remote, market searches include onsite, hybrid, and remote jobs in that market.

Reliability:
  Most stable filters: --platform, --market, --remote, --title-query, --key-query.
  Source-dependent filters: --department, --type, --country, --hybrid, --onsite.
  JSON/CSV exports skip total counts automatically; use --fast for table output when counts are not needed.

Agent/tool workflow:
  Use --format json --output results.json for machine-readable results.
  Review exported candidate sets with job_url and apply_url metadata.

Known market IDs:
%s

Examples:
  jobscan search "software engineer"
  jobscan search "machine learning" --desc
  jobscan search "engineer" --remote --since 7d
  jobscan search "software engineer" --market usa,canada,uk
  jobscan search "software engineer" --market usa --remote
  jobscan search --company anthropic,stripe --department engineering
  jobscan search --title-query "'software engineer' OR 'backend engineer'"
  jobscan search --title-query "('software engineer' OR 'backend engineer') AND NOT senior"
  jobscan search "backend engineer" --key-query '"Go" AND ("Rust" OR "C++")'
  jobscan search "engineer" --exclude-key-query "'security clearance' OR firmware"
  jobscan search "software engineer" --exclude-title-phrase "Senior Software Engineer,Staff Software Engineer"
  jobscan search "software engineer" --key-query "'distributed systems' OR (Go AND Kafka)"
  jobscan search --market usa,canada,uk --platform ashby,greenhouse,lever --format json --output results.json
  jobscan search "intern" --type intern --location "new york"
  jobscan search "AI" --format json --limit 100
  jobscan search --remote --count`, wrapCSV(market.KnownMarkets(), "  ", 88))
}

func wrapCSV(values []string, indent string, width int) string {
	var b strings.Builder
	line := indent
	for i, value := range values {
		item := value
		if i < len(values)-1 {
			item += ","
		}
		if len(line) > len(indent) && len(line)+1+len(item) > width {
			b.WriteString(line)
			b.WriteByte('\n')
			line = indent + item
			continue
		}
		if len(line) > len(indent) {
			line += " "
		}
		line += item
	}
	if strings.TrimSpace(line) != "" {
		b.WriteString(line)
	}
	return b.String()
}

var (
	searchDesc                bool
	searchRaw                 bool
	searchLocation            []string
	searchMarkets             []string
	searchTitleQuery          string
	searchKeyQuery            string
	searchExcludeKeyQuery     string
	searchExcludeTitlePhrases []string
	searchRemote              bool
	searchHybrid              bool
	searchOnsite              bool
	searchSince               string
	searchBefore              string
	searchPlatforms           []string
	searchCompanies           []string
	searchDepartment          string
	searchType                string
	searchCountry             string
	searchSort                string
	searchLimit               int
	searchOffset              int
	searchFormat              string
	searchOutput              string
	searchCountOnly           bool
	searchFast                bool
	searchNoExpand            bool
	searchMaxPerCompany       int
	searchDedupe              bool
)

func init() {
	rootCmd.AddCommand(searchCmd)

	searchCmd.Flags().BoolVarP(&searchDesc, "desc", "d", false, "Search in descriptions too (not just titles)")
	searchCmd.Flags().StringVar(&searchTitleQuery, "title-query", "", "Boolean title query; use quoted phrases for multi-word titles")
	searchCmd.Flags().StringVarP(&searchKeyQuery, "key-query", "Q", "", "Boolean description query; phrases may use single or double quotes")
	searchCmd.Flags().StringVar(&searchExcludeKeyQuery, "exclude-key-query", "", "Boolean description query to exclude; requires a positive search/filter")
	searchCmd.Flags().StringSliceVar(&searchExcludeTitlePhrases, "exclude-title-phrase", nil, "Title phrases to exclude from job titles, comma-separated")
	searchCmd.Flags().BoolVar(&searchRaw, "raw", false, "Bypass FTS safety wrapper for raw FTS5 queries")
	searchCmd.Flags().StringSliceVar(&searchLocation, "location", nil, "Broad location text filter: city, country, region, or remote terms (comma-separated)")
	searchCmd.Flags().StringSliceVar(&searchMarkets, "market", nil, "Broad hiring market preset: usa, europe, remote-global, etc. (comma-separated)")
	searchCmd.Flags().BoolVar(&searchRemote, "remote", false, "Show jobs marked remote or with Remote in the location text")
	searchCmd.Flags().BoolVar(&searchHybrid, "hybrid", false, "Show jobs marked hybrid; source-dependent")
	searchCmd.Flags().BoolVar(&searchOnsite, "onsite", false, "Show jobs marked on-site; source-dependent")
	searchCmd.Flags().StringVar(&searchSince, "since", "", `Posted within: "7d", "30d", "2026-04-01"`)
	searchCmd.Flags().StringVar(&searchBefore, "before", "", "Posted before date: 2026-01-01")
	searchCmd.Flags().StringSliceVar(&searchPlatforms, "platform", nil, "Platform filter: greenhouse, lever, ashby")
	searchCmd.Flags().StringSliceVar(&searchCompanies, "company", nil, "Company slug filter (comma-separated)")
	searchCmd.Flags().StringVar(&searchDepartment, "department", "", "Department text filter; source-dependent")
	searchCmd.Flags().StringVar(&searchType, "type", "", "Employment type filter, source-dependent: full-time, intern, contract, temp")
	searchCmd.Flags().StringVar(&searchCountry, "country", "", "Source-provided country text filter; prefer --location for broad country searches")
	searchCmd.Flags().StringVar(&searchSort, "sort", "relevance", "Sort: relevance, newest, oldest, company, title")
	searchCmd.Flags().IntVar(&searchLimit, "limit", 25, "Max results (0 = all)")
	searchCmd.Flags().IntVar(&searchOffset, "offset", 0, "Pagination offset")
	searchCmd.Flags().StringVar(&searchFormat, "format", "table", "Output format: table, json, csv")
	searchCmd.Flags().StringVarP(&searchOutput, "output", "o", "", "Write output to file")
	searchCmd.Flags().BoolVar(&searchCountOnly, "count", false, "Print only the result count")
	searchCmd.Flags().BoolVar(&searchFast, "fast", false, "Skip total result counts for faster limited table output")
	searchCmd.Flags().BoolVar(&searchNoExpand, "no-expand", false, "Match terms exactly; do not search their other spellings (back-end/backend/'back end')")
	searchCmd.Flags().IntVar(&searchMaxPerCompany, "max-per-company", 0, "Keep at most N results per company, best-ranked first (0 = unlimited)")
	searchCmd.Flags().BoolVar(&searchDedupe, "dedupe", false, "Collapse postings that repeat the same title at the same company")
}

func runSearch(cmd *cobra.Command, args []string) error {
	// Build query
	query := strings.Join(args, " ")

	companies := flattenCommaSeparated(searchCompanies)
	platforms := flattenCommaSeparated(searchPlatforms)
	locations := flattenCommaSeparated(searchLocation)
	markets := flattenCommaSeparated(searchMarkets)
	excludeTitlePhrases := flattenCommaSeparated(searchExcludeTitlePhrases)

	if err := validateSearchOptions(searchOptions{
		Remote:    searchRemote,
		Hybrid:    searchHybrid,
		Onsite:    searchOnsite,
		Since:     searchSince,
		Before:    searchBefore,
		Sort:      searchSort,
		Format:    searchFormat,
		Type:      searchType,
		Limit:     searchLimit,
		Offset:    searchOffset,
		Platforms: platforms,
		Markets:   markets,
		Fast:      searchFast,
		CountOnly: searchCountOnly,
	}); err != nil {
		return err
	}

	var marketFilters marketFilter
	if len(markets) > 0 {
		var err error
		marketFilters, err = expandMarketFilters(markets)
		if err != nil {
			return err
		}
	}

	// Resolve workplace type
	workplaceType := ""
	if searchRemote {
		workplaceType = "Remote"
	} else if searchHybrid {
		workplaceType = "Hybrid"
	} else if searchOnsite {
		workplaceType = "On-Site"
	}

	// Normalize employment type
	empType, err := normalizeSearchType(searchType)
	if err != nil {
		return err
	}

	limit := searchLimit
	if limit == 0 {
		limit = 100000 // effectively all
	}

	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer sqlDB.Close()

	// Spelling variants come from the corpus vocabulary, so the database has to
	// be open before a query can be compiled. A database without the term index
	// yields a nil expander and the exact-match behaviour it had before.
	var expander queryparser.Expander
	if !searchNoExpand {
		termExpander, err := db.NewTermExpander(sqlDB)
		if err != nil {
			return fmt.Errorf("loading term index: %w", err)
		}
		if termExpander != nil {
			defer termExpander.Close()
			expander = termExpander
		}
	}

	titleQueryFTS, err := compileBooleanFTSFlag("title-query", searchTitleQuery, "title", expander)
	if err != nil {
		return err
	}
	keyQueryFTS, err := compileBooleanFTSFlag("key-query", searchKeyQuery, "description_plain", expander)
	if err != nil {
		return err
	}
	// An exclusion is a claim about what must NOT be there, so widening it into
	// every spelling would silently discard jobs the caller never asked to drop.
	excludeKeyQueryFTS, err := compileBooleanFTSFlag("exclude-key-query", searchExcludeKeyQuery, "description_plain", nil)
	if err != nil {
		return err
	}
	if excludeKeyQueryFTS != "" && !hasPositiveFTSAnchor(query, titleQueryFTS, keyQueryFTS, locations, marketFilters, workplaceType, empType, searchCountry, platforms, companies) {
		return fmt.Errorf("--exclude-key-query requires a positive search term or filter")
	}

	outputFormat := strings.ToLower(strings.TrimSpace(searchFormat))
	skipCount := searchFast || (!searchCountOnly && outputFormat != "table")

	params := model.SearchParams{
		Query:               query,
		SearchDesc:          searchDesc,
		SearchRaw:           searchRaw,
		TitleQueryFTS:       titleQueryFTS,
		KeyQueryFTS:         keyQueryFTS,
		ExcludeKeyQueryFTS:  excludeKeyQueryFTS,
		ExcludeTitlePhrases: excludeTitlePhrases,
		Location:            locations,
		Markets:             marketFilters.Markets,
		MarketLocation:      marketFilters.LocationTerms,
		MarketCountry:       marketFilters.CountryTerms,
		WorkplaceType:       workplaceType,
		Since:               searchSince,
		Before:              searchBefore,
		Platforms:           platforms,
		Companies:           companies,
		Department:          searchDepartment,
		EmploymentType:      empType,
		Country:             searchCountry,
		SortBy:              strings.ToLower(strings.TrimSpace(searchSort)),
		Limit:               limit,
		Offset:              searchOffset,
		CountOnly:           searchCountOnly,
		MaxPerCompany:       searchMaxPerCompany,
		Dedupe:              searchDedupe,
		SkipCount:           skipCount,
	}

	start := time.Now()
	jobs, total, companyCount, err := db.SearchJobs(sqlDB, params)
	if err != nil {
		return fmt.Errorf("search failed: %w", err)
	}
	elapsed := time.Since(start)

	// Count only
	if searchCountOnly {
		fmt.Printf("  %d jobs across %d companies\n", total, companyCount)
		return nil
	}

	if len(jobs) == 0 {
		fmt.Println("  No results found.")
		fmt.Println("  Try: broadening your query, removing --since, or running `jobscan fetch` first.")
		return nil
	}

	// Determine output writer
	out := os.Stdout
	if searchOutput != "" {
		f, err := os.Create(searchOutput)
		if err != nil {
			return fmt.Errorf("creating output file: %w", err)
		}
		defer f.Close()
		out = f
	}

	// Render
	switch strings.ToLower(strings.TrimSpace(searchFormat)) {
	case "json":
		if err := render.JSON(out, jobs); err != nil {
			return err
		}
	case "csv":
		if err := render.CSV(out, jobs); err != nil {
			return err
		}
		if searchOutput != "" {
			fmt.Printf("  ✓ Wrote %d results to %s\n", len(jobs), searchOutput)
		}
	default: // table
		render.Table(out, jobs, total, elapsed)
	}

	return nil
}
