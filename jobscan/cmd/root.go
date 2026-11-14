package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"jobscan/internal/config"
	"jobscan/internal/market"
)

var dbPath string

var rootCmd = &cobra.Command{
	Use:           "jobscan",
	Short:         "High-performance job board aggregator",
	SilenceErrors: true,
	SilenceUsage:  true,
	Long:          rootLongHelp(),
}

func rootLongHelp() string {
	return fmt.Sprintf(`jobscan scrapes 11,700+ company job boards across Greenhouse, Lever, and Ashby.
Fetch once, search locally, then export candidate sets with job and apply URLs.

Core workflow:
  jobscan fetch --rebuild
  jobscan stats
  jobscan search "software engineer"
  jobscan search --market usa,canada,uk --title-query "('software engineer' OR 'backend engineer') AND NOT senior"
  jobscan search --key-query "'distributed systems' AND (Go OR C++ OR Kafka)" --exclude-key-query "clearance OR embedded"
  jobscan search --platform ashby,greenhouse,lever --format json --output results.json

Commands:
  fetch      Populate or refresh the local SQLite database from company CSVs.
  search     Query the local database with title, description, market, platform, date, and output filters.
  stats      Show database totals, platform counts, department counts, and workplace-type counts.
  completion Generate shell completion scripts.

Global flag:
  --db PATH  Use a specific SQLite database instead of the default repo-local jobs.db.

Fetch usage:
  jobscan fetch
  jobscan fetch --force
  jobscan fetch --rebuild
  jobscan fetch --platform greenhouse,lever,ashby
  jobscan fetch --company anthropic,stripe
  jobscan fetch --data-dir .\data
  jobscan fetch --workers 160
  jobscan fetch --quiet

Fetch behavior:
  --data-dir points to CSV files containing company slugs.
  --platform limits fetches to greenhouse, lever, and/or ashby.
  --company limits fetches to specific company slugs.
  --force ignores the 2h cache and refreshes already-fetched boards.
  --rebuild creates a fresh optimized DB and swaps it in only after success.
  --workers overrides platform-specific concurrent request defaults.
  --quiet suppresses progress output and prints only the summary.

Search mental model:
  Positional [query] searches titles only by default.
  Add --desc to search title + description.
  Multi-word positional queries match as phrases.
  All filters are combined with AND logic.
  Use --format json --output results.json for agents and scripts.
  Use --count to print only the total count.

Search Boolean grammar:
  Applies to --title-query, --key-query, and --exclude-key-query.
  Supported operators: AND, OR, AND NOT.
  Parentheses are supported and may be deeply nested.
  Single-quoted and double-quoted phrases are supported.
  There is no implicit AND: write Go AND Kafka, not Go Kafka.
  Quote multi-word phrases: 'distributed systems' or "software engineer".
  --title-query compiles terms against the title column.
  --key-query / -Q compiles terms against description_plain.
  --exclude-key-query excludes description matches and requires a positive search/filter anchor.

PowerShell quoting:
  Recommended: --key-query '"distributed systems" OR (Go AND Kafka)'
  Recommended: --title-query "('software engineer' OR 'backend engineer') AND NOT senior"
  Do not use trailing \ for line continuation in PowerShell; use the backtick character.

Search flags:
  --desc                         Search title + description instead of title only.
  --title-query QUERY            Boolean title query for complex role matching.
  --key-query, -Q QUERY          Boolean description query for resume/skill matching.
  --exclude-key-query QUERY      Boolean description exclusion, for clearance/frontend/embedded/etc.
  --exclude-title-phrase LIST    Exact title substring exclusions, comma-separated.
  --raw                          Use raw FTS5 syntax directly; advanced and unsafe for normal users.
  --market LIST                  Broad hiring markets; preferred for country/region searches.
  --location LIST                Broad location text terms: cities, countries, regions, remote terms.
  --country TEXT                 Source-provided country text only; less stable than --market.
  --remote                       Require jobs marked remote or with Remote in location text.
  --hybrid                       Require jobs marked hybrid; source-dependent.
  --onsite                       Require jobs marked on-site; source-dependent.
  --since VALUE                  Posted within duration/date: 7d, 30d, 2026-04-01, RFC3339.
  --before VALUE                 Posted before date/RFC3339.
  --platform LIST                greenhouse, lever, ashby.
  --company LIST                 Company slug filter, comma-separated.
  --department TEXT              Department text filter; source-dependent.
  --type VALUE                   full-time, intern, contract, temp; source-dependent.
  --sort VALUE                   relevance, newest, oldest, company, title.
  --limit N                      Max results; 0 means all.
  --offset N                     Pagination offset.
  --format VALUE                 table, json, csv.
  --output, -o PATH              Write results to a file.
  --count                        Print only result count.

Markets:
  Prefer --market over --country for broad searches because job boards store country/location inconsistently.
  Example: --market usa,canada,uk expands to country terms, regions, metros, cities, and market-specific remote terms.
  --remote means remote-only. Without --remote, market searches include onsite, hybrid, and remote jobs in that market.
  Country markets intentionally do not include generic "Remote"; use --market remote-global for global remote searches.

Known market IDs:
%s

Stable vs source-dependent filters:
  Most stable: --platform, --market, --remote, --title-query, --key-query, --exclude-key-query, --exclude-title-phrase.
  Less stable: --department, --type, --country, --hybrid, --onsite because source boards normalize these differently.
  Prefer Boolean title/description queries plus --market and --platform for precise agent-driven matching.

Stats usage:
  jobscan stats
  jobscan --db C:\path\jobs.db stats

Complex resume-matching examples:
  Broad backend/platform resume match across the USA, Canada, and the UK; exports JSON for agents:
  jobscan search --market usa,canada,uk --platform ashby,greenhouse,lever --title-query "('software engineer' OR 'backend engineer' OR 'platform engineer' OR 'infrastructure engineer' OR 'systems engineer') AND NOT ('senior software engineer' OR 'staff software engineer' OR 'principal software engineer' OR manager OR director)" --key-query "('distributed systems' OR backend OR platform OR infrastructure OR concurrency OR 'cloud infrastructure' OR 'performance optimization') AND (C++ OR Go OR Python OR Java OR Kafka OR Kubernetes OR Redis OR PostgreSQL OR Docker)" --exclude-key-query "('security clearance' OR 'active clearance' OR firmware OR embedded OR wordpress OR salesforce OR 'frontend only')" --exclude-title-phrase "Senior Software Engineer,Staff Software Engineer,Principal Software Engineer,Engineering Manager" --sort relevance --limit 100 --format json --output resume_matches.json

  Early/mid-level exact-title search; avoids common senior/staff title false positives:
  jobscan search --title-query "('software engineer' OR 'backend engineer' OR 'software engineer ii' OR 'backend engineer ii') AND NOT (senior OR staff OR principal OR manager OR director)" --key-query "(backend OR platform OR 'distributed systems') AND (Go OR C++ OR Python OR Kafka OR PostgreSQL)" --exclude-title-phrase "Senior Software Engineer,Staff Software Engineer,Principal Software Engineer,Software Engineering Manager" --market usa --platform greenhouse,lever,ashby --since 30d --format json --output early_mid_backend.json

  C++/Rust systems and infrastructure search for low-level resumes:
  jobscan search --title-query "('c++ engineer' OR 'systems engineer' OR 'infrastructure engineer' OR 'performance engineer' OR 'platform engineer') AND NOT (senior OR staff OR principal OR manager)" --key-query "(C++ OR Rust OR Linux OR 'systems programming') AND (distributed OR infrastructure OR platform OR storage)" --exclude-key-query "(frontend OR react OR wordpress OR salesforce OR firmware OR 'security clearance')" --market usa,canada,uk --sort relevance --limit 75 --format json --output systems_matches.json

  Distributed systems/backend search with stronger description requirements:
  jobscan search "software engineer" --desc --key-query "('distributed systems' OR Kafka OR 'event driven' OR Kubernetes OR Redis OR PostgreSQL OR gRPC OR protobuf) AND (backend OR platform OR infrastructure)" --exclude-key-query "('frontend only' OR mobile OR android OR ios OR embedded OR firmware)" --market north-america,europe --platform ashby,lever,greenhouse --since 90d --format json --output distributed_backend.json

  Remote-only resume match; use --remote only when remote is required:
  jobscan search --remote --market usa,remote-global --title-query "('backend engineer' OR 'platform engineer' OR 'software engineer') AND NOT (senior OR staff OR principal OR manager)" --key-query "(Go OR Python OR C++ OR Kafka OR Kubernetes OR PostgreSQL) AND (backend OR platform OR infrastructure)" --exclude-key-query "clearance OR embedded OR 'frontend only'" --sort relevance --limit 50 --format json --output remote_resume_matches.json

  Location-focused search while keeping a broad market net:
  jobscan search --market usa --location "Austin,New York,San Francisco,Seattle,Remote US" --title-query "('software engineer' OR 'backend engineer' OR 'platform engineer') AND NOT (staff OR principal OR manager)" --key-query "(backend OR platform OR infrastructure) AND (Go OR C++ OR Python OR Kafka OR Kubernetes)" --since 60d --format table --limit 50

  Company-targeted search; company and department are useful when you know source slugs:
  jobscan search --company anthropic,stripe,datadog --department engineering --title-query "('software engineer' OR 'backend engineer' OR 'infrastructure engineer') AND NOT (manager OR director)" --key-query "(distributed OR backend OR infrastructure OR platform) AND (Go OR Python OR C++ OR Kubernetes)" --format json --output target_companies.json

  Internship/new-grad style search; --type is source-dependent, so pair it with title logic:
  jobscan search --type intern --title-query "(intern OR internship OR 'new grad' OR 'university graduate') AND (software OR backend OR platform)" --key-query "(Python OR Go OR C++ OR Java OR SQL)" --market usa --since 180d --format csv --output internships.csv

  Count-only sanity check before exporting a large result set:
  jobscan search --market usa,canada,uk --platform ashby,greenhouse,lever --title-query "('software engineer' OR 'backend engineer' OR 'platform engineer') AND NOT (senior OR staff OR principal)" --key-query "(backend OR platform OR infrastructure) AND (Go OR C++ OR Python)" --count

  Pagination for reviewing large result sets in chunks:
  jobscan search --market usa --title-query "('software engineer' OR 'backend engineer') AND NOT senior" --key-query "(backend OR distributed OR platform)" --sort relevance --limit 25 --offset 0
  jobscan search --market usa --title-query "('software engineer' OR 'backend engineer') AND NOT senior" --key-query "(backend OR distributed OR platform)" --sort relevance --limit 25 --offset 25

  Date-bounded export for recent active boards:
  jobscan search --market europe --platform greenhouse,lever --since 30d --before 2026-12-31 --title-query "('backend engineer' OR 'platform engineer')" --key-query "(Go OR Python OR Kafka OR Kubernetes OR PostgreSQL)" --format csv --output europe_recent_backend.csv

  Source-country debug search; prefer --market for normal use, but --country can inspect source-provided country text:
  jobscan search --country "US" --platform lever --title-query "'backend engineer' OR 'software engineer'" --key-query "Go OR Python OR Kafka" --format json --output lever_country_us_debug.json

  Advanced raw FTS escape hatch; use only when you intentionally want SQLite FTS5 syntax:
  jobscan search --raw "title : \"software engineer\" AND description_plain : \"Kafka\"" --platform greenhouse --limit 20

  Candidate exports include job_url and apply_url fields for downstream review.`, wrapCSV(market.KnownMarkets(), "  ", 88))
}

// Execute runs the root command.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().StringVar(&dbPath, "db", config.DefaultDBPath(),
		"Path to the SQLite database file")
}
