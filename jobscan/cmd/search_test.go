package cmd

import (
	"strings"
	"testing"
)

func TestValidateSearchOptions(t *testing.T) {
	tests := []struct {
		name    string
		opts    searchOptions
		wantErr bool
	}{
		{
			name: "valid",
			opts: searchOptions{
				Sort:      "relevance",
				Format:    "json",
				Type:      "full-time",
				Since:     "7d",
				Before:    "2026-04-01",
				Limit:     25,
				Offset:    0,
				Platforms: []string{"greenhouse", "lever"},
			},
		},
		{
			name: "valid uppercase trimmed choices",
			opts: searchOptions{
				Sort:      " Relevance ",
				Format:    " JSON ",
				Type:      " Internship ",
				Since:     "2026-04-01T12:00:00Z",
				Before:    "2026-05-01T00:00:00Z",
				Limit:     0,
				Offset:    10,
				Platforms: []string{" GreenHouse ", "ASHBY"},
			},
		},
		{
			name:    "conflicting workplace flags",
			opts:    searchOptions{Remote: true, Hybrid: true, Sort: "relevance", Format: "table", Limit: 25},
			wantErr: true,
		},
		{
			name:    "fast conflicts with count",
			opts:    searchOptions{Fast: true, CountOnly: true, Sort: "relevance", Format: "table", Limit: 25},
			wantErr: true,
		},
		{
			name:    "invalid since",
			opts:    searchOptions{Sort: "relevance", Format: "table", Since: "yesterday", Limit: 25},
			wantErr: true,
		},
		{
			name:    "invalid before",
			opts:    searchOptions{Sort: "relevance", Format: "table", Before: "30x", Limit: 25},
			wantErr: true,
		},
		{
			name:    "invalid sort",
			opts:    searchOptions{Sort: "ranked", Format: "table", Limit: 25},
			wantErr: true,
		},
		{
			name:    "invalid format",
			opts:    searchOptions{Sort: "relevance", Format: "yaml", Limit: 25},
			wantErr: true,
		},
		{
			name:    "invalid employment type",
			opts:    searchOptions{Sort: "relevance", Format: "table", Type: "part-time", Limit: 25},
			wantErr: true,
		},
		{
			name:    "invalid platform",
			opts:    searchOptions{Sort: "relevance", Format: "table", Platforms: []string{"greenhouse", "workday"}, Limit: 25},
			wantErr: true,
		},
		{
			name:    "invalid market",
			opts:    searchOptions{Sort: "relevance", Format: "table", Markets: []string{"usa", "middle-earth"}, Limit: 25},
			wantErr: true,
		},
		{
			name:    "negative limit",
			opts:    searchOptions{Sort: "relevance", Format: "table", Limit: -1},
			wantErr: true,
		},
		{
			name:    "negative offset",
			opts:    searchOptions{Sort: "relevance", Format: "table", Limit: 25, Offset: -1},
			wantErr: true,
		},
		{
			name:    "zero day since",
			opts:    searchOptions{Sort: "relevance", Format: "table", Since: "0d", Limit: 25},
			wantErr: true,
		},
		{
			name:    "empty sort",
			opts:    searchOptions{Sort: "", Format: "table", Limit: 25},
			wantErr: true,
		},
		{
			name:    "empty format",
			opts:    searchOptions{Sort: "relevance", Format: "", Limit: 25},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateSearchOptions(tt.opts)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateSearchOptions() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestValidateSearchOptionsWorkplaceConflicts(t *testing.T) {
	tests := []searchOptions{
		{Remote: true, Hybrid: true, Sort: "relevance", Format: "table", Limit: 25},
		{Remote: true, Onsite: true, Sort: "relevance", Format: "table", Limit: 25},
		{Hybrid: true, Onsite: true, Sort: "relevance", Format: "table", Limit: 25},
		{Remote: true, Hybrid: true, Onsite: true, Sort: "relevance", Format: "table", Limit: 25},
	}

	for _, opts := range tests {
		if err := validateSearchOptions(opts); err == nil {
			t.Fatalf("validateSearchOptions(%+v) expected workplace conflict error", opts)
		}
	}
}

func TestValidateSearchOptionsValidChoices(t *testing.T) {
	for _, sort := range []string{"relevance", "newest", "oldest", "company", "title", "TITLE"} {
		if err := validateSearchOptions(searchOptions{Sort: sort, Format: "table", Limit: 25}); err != nil {
			t.Fatalf("sort %q should be valid: %v", sort, err)
		}
	}

	for _, format := range []string{"table", "json", "csv", "CSV"} {
		if err := validateSearchOptions(searchOptions{Sort: "relevance", Format: format, Limit: 25}); err != nil {
			t.Fatalf("format %q should be valid: %v", format, err)
		}
	}

	for _, platform := range []string{"greenhouse", "lever", "ashby", "Lever"} {
		if err := validateSearchOptions(searchOptions{Sort: "relevance", Format: "table", Limit: 25, Platforms: []string{platform}}); err != nil {
			t.Fatalf("platform %q should be valid: %v", platform, err)
		}
	}

	for _, market := range []string{"usa", "US", "united-states", "netherlands", "nl", "europe", "remote-global"} {
		if err := validateSearchOptions(searchOptions{Sort: "relevance", Format: "table", Limit: 25, Markets: []string{market}}); err != nil {
			t.Fatalf("market %q should be valid: %v", market, err)
		}
	}
}

func TestNormalizeSearchType(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "", want: ""},
		{input: "full-time", want: "Full-Time"},
		{input: "fulltime", want: "Full-Time"},
		{input: "full_time", want: "Full-Time"},
		{input: "internship", want: "Intern"},
		{input: "contractor", want: "Contract"},
		{input: "temporary", want: "Temporary"},
		{input: " Temp ", want: "Temporary"},
		{input: "INTERN", want: "Intern"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := normalizeSearchType(tt.input)
			if err != nil {
				t.Fatalf("normalizeSearchType() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("normalizeSearchType() = %q, want %q", got, tt.want)
			}
		})
	}

	if _, err := normalizeSearchType("part-time"); err == nil {
		t.Fatalf("normalizeSearchType() expected error for invalid type")
	}
}

func TestCompileBooleanFTSFlag(t *testing.T) {
	got, err := compileBooleanFTSFlag("title-query", `('software engineer' OR 'backend engineer') AND NOT senior`, "title", nil)
	if err != nil {
		t.Fatalf("compileBooleanFTSFlag() error = %v", err)
	}
	want := `((title : "software engineer") OR (title : "backend engineer")) NOT (title : "senior")`
	if got != want {
		t.Fatalf("compileBooleanFTSFlag() = %q, want %q", got, want)
	}

	got, err = compileBooleanFTSFlag("exclude-key-query", `clearance OR firmware`, "description_plain", nil)
	if err != nil {
		t.Fatalf("compileBooleanFTSFlag() error = %v", err)
	}
	want = `(description_plain : "clearance") OR (description_plain : "firmware")`
	if got != want {
		t.Fatalf("compileBooleanFTSFlag() = %q, want %q", got, want)
	}

	if _, err := compileBooleanFTSFlag("title-query", `A AND NOT`, "title", nil); err == nil || !strings.Contains(err.Error(), "invalid --title-query") {
		t.Fatalf("compileBooleanFTSFlag() error = %v, want invalid --title-query", err)
	}
}

func TestHasPositiveFTSAnchor(t *testing.T) {
	if hasPositiveFTSAnchor("", "", "", nil, marketFilter{}, "", "", "", nil, nil) {
		t.Fatalf("empty search should not have positive FTS anchor")
	}
	if !hasPositiveFTSAnchor("software engineer", "", "", nil, marketFilter{}, "", "", "", nil, nil) {
		t.Fatalf("positional query should be a positive FTS anchor")
	}
	if !hasPositiveFTSAnchor("", `(title : "software engineer")`, "", nil, marketFilter{}, "", "", "", nil, nil) {
		t.Fatalf("title query should be a positive FTS anchor")
	}
	if !hasPositiveFTSAnchor("", "", "", []string{"Austin"}, marketFilter{}, "", "", "", nil, nil) {
		t.Fatalf("location should be a positive FTS anchor")
	}
	if !hasPositiveFTSAnchor("", "", "", nil, marketFilter{CountryTerms: []string{"United States"}}, "", "", "", nil, nil) {
		t.Fatalf("market country should be a positive FTS anchor")
	}
	if !hasPositiveFTSAnchor("", "", "", nil, marketFilter{}, "Remote", "", "", nil, nil) {
		t.Fatalf("workplace should be a positive FTS anchor")
	}
	if !hasPositiveFTSAnchor("", "", "", nil, marketFilter{}, "", "", "", []string{"greenhouse"}, nil) {
		t.Fatalf("platform should be a positive FTS anchor")
	}
	if !hasPositiveFTSAnchor("", "", "", nil, marketFilter{}, "", "", "", nil, []string{"openai"}) {
		t.Fatalf("company should be a positive FTS anchor")
	}
}

func TestFlattenCommaSeparated(t *testing.T) {
	got := flattenCommaSeparated([]string{"greenhouse, lever", " ashby ", ",,", "New York, NY"})
	want := []string{"greenhouse", "lever", "ashby", "New York", "NY"}

	if len(got) != len(want) {
		t.Fatalf("flattenCommaSeparated() = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("flattenCommaSeparated() = %v, want %v", got, want)
		}
	}
}

func TestExpandMarketFilters(t *testing.T) {
	got, err := expandMarketFilters([]string{"usa", "ie"})
	if err != nil {
		t.Fatalf("expandMarketFilters() error = %v", err)
	}

	assertContainsStrings(t, got.LocationTerms, []string{
		"United States", "Remote US", "California", "Boston",
		"Ireland", "Remote Ireland", "Dublin", "Cork",
	})
	assertContainsStrings(t, got.CountryTerms, []string{
		"United States", "USA", "US",
		"Ireland", "Republic of Ireland", "Eire",
	})
	assertNoDuplicateStrings(t, got.LocationTerms)
	assertNoDuplicateStrings(t, got.CountryTerms)
}

// --location is a NARROWING filter and is ANDed in on its own. It used to be
// merged in here, where it became one more OR'd term among ~250 market terms and
// then got dropped entirely (the fallback only runs when Markets is empty).
// Live before the fix, --market usa and --market usa --location <a city> returned
// the same number of jobs: the location did nothing.
func TestExpandMarketFiltersIgnoresUserLocations(t *testing.T) {
	got, err := expandMarketFilters([]string{"usa"})
	if err != nil {
		t.Fatalf("expandMarketFilters() error = %v", err)
	}
	for _, term := range got.LocationTerms {
		if term == "Custom City" {
			t.Fatalf("user --location must not be folded into market terms: %v", got.LocationTerms)
		}
	}
}

func TestExpandMarketFiltersDoesNotAddGenericRemoteForCountryMarket(t *testing.T) {
	got, err := expandMarketFilters([]string{"usa"})
	if err != nil {
		t.Fatalf("expandMarketFilters() error = %v", err)
	}
	for _, term := range got.LocationTerms {
		if term == "Remote" {
			t.Fatalf("country market should not add generic Remote to locations: %v", got.LocationTerms)
		}
	}
	for _, term := range got.CountryTerms {
		if term == "Remote" {
			t.Fatalf("country market should not add generic Remote to countries: %v", got.CountryTerms)
		}
	}

	got, err = expandMarketFilters([]string{"remote-global"})
	if err != nil {
		t.Fatalf("expandMarketFilters() error = %v", err)
	}
	assertContainsStrings(t, got.LocationTerms, []string{"Remote", "Worldwide", "Global"})
	if len(got.CountryTerms) != 0 {
		t.Fatalf("remote-global country terms = %v, want none", got.CountryTerms)
	}
}

func assertContainsStrings(t *testing.T, got []string, want []string) {
	t.Helper()

	set := make(map[string]bool, len(got))
	for _, value := range got {
		set[value] = true
	}
	for _, value := range want {
		if !set[value] {
			t.Fatalf("values missing %q in %v", value, got)
		}
	}
}

func assertNoDuplicateStrings(t *testing.T, values []string) {
	t.Helper()

	seen := map[string]bool{}
	for _, value := range values {
		if seen[value] {
			t.Fatalf("duplicate value %q in %v", value, values)
		}
		seen[value] = true
	}
}
