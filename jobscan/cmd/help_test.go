package cmd

import (
	"strings"
	"testing"
)

func TestSearchHelpDocumentsAdvancedUsage(t *testing.T) {
	help := searchLongHelp()
	required := []string{
		"Positional [query] searches job titles by default.",
		"Grammar supports AND, OR, AND NOT, parentheses, and single/double quoted phrases.",
		"There is no implicit AND: write Go AND Kafka, not Go Kafka.",
		`Recommended: --key-query '"distributed systems" OR (Go AND Kafka)'`,
		"--exclude-title-phrase is exact title substring exclusion, not Boolean.",
		"--exclude-key-query excludes description matches and requires a positive search/filter.",
		"Prefer --market for broad country/region searches.",
		"--remote means require remote jobs.",
		"Most stable filters: --platform, --market, --remote, --title-query, --key-query.",
		"Use --format json --output results.json for machine-readable results.",
		"Known market IDs:",
		"usa,",
		"netherlands,",
		"remote-global,",
	}
	for _, want := range required {
		if !strings.Contains(help, want) {
			t.Fatalf("search help missing %q\nhelp:\n%s", want, help)
		}
	}
}

func TestRootHelpDocumentsFullManual(t *testing.T) {
	help := rootLongHelp()
	required := []string{
		"Core workflow:",
		"Commands:",
		"Global flag:",
		"Fetch usage:",
		"Fetch behavior:",
		"Search mental model:",
		"Search Boolean grammar:",
		"PowerShell quoting:",
		"Search flags:",
		"Markets:",
		"Known market IDs:",
		"Stable vs source-dependent filters:",
		"Stats usage:",
		"Complex resume-matching examples:",
		"Broad backend/platform resume match across the USA, Canada, and the UK; exports JSON for agents:",
		"Early/mid-level exact-title search; avoids common senior/staff title false positives:",
		"C++/Rust systems and infrastructure search for low-level resumes:",
		"Distributed systems/backend search with stronger description requirements:",
		"Remote-only resume match; use --remote only when remote is required:",
		"Location-focused search while keeping a broad market net:",
		"Company-targeted search; company and department are useful when you know source slugs:",
		"Internship/new-grad style search; --type is source-dependent, so pair it with title logic:",
		"Count-only sanity check before exporting a large result set:",
		"Pagination for reviewing large result sets in chunks:",
		"Date-bounded export for recent active boards:",
		"Source-country debug search; prefer --market for normal use, but --country can inspect source-provided country text:",
		"Advanced raw FTS escape hatch; use only when you intentionally want SQLite FTS5 syntax:",
		"jobscan fetch --force",
		`jobscan search --market usa,canada,uk --title-query "('software engineer' OR 'backend engineer') AND NOT senior"`,
		`jobscan search --key-query "'distributed systems' AND (Go OR C++ OR Kafka)" --exclude-key-query "clearance OR embedded"`,
		"jobscan search --platform ashby,greenhouse,lever --format json --output results.json",
		"--exclude-title-phrase LIST",
		"--exclude-key-query QUERY",
		"--format VALUE",
		"--offset 25",
		"--raw \"title :",
		"--before 2026-12-31",
		"--country \"US\"",
		"usa,",
		"netherlands,",
		"remote-global,",
		"Candidate exports include job_url and apply_url fields for downstream review.",
	}
	for _, want := range required {
		if !strings.Contains(help, want) {
			t.Fatalf("root help missing %q\nhelp:\n%s", want, help)
		}
	}
}

func TestFetchHelpExplainsOperationalBehavior(t *testing.T) {
	for _, want := range []string{
		"Reads company slugs from --data-dir CSV files.",
		"Boards fetched recently are skipped by the 2h cache.",
		"Use --force to refresh existing fetched boards and ignore the cache.",
	} {
		if !strings.Contains(fetchCmd.Long, want) {
			t.Fatalf("fetch help missing %q\nhelp:\n%s", want, fetchCmd.Long)
		}
	}
}
