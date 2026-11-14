package cmd

import (
	"fmt"
	"strings"

	"jobscan/internal/market"
	"jobscan/internal/normalize"
	"jobscan/internal/queryparser"
)

type searchOptions struct {
	Remote    bool
	Hybrid    bool
	Onsite    bool
	Fast      bool
	CountOnly bool
	Since     string
	Before    string
	Sort      string
	Format    string
	Type      string
	Limit     int
	Offset    int
	Platforms []string
	Markets   []string
}

type fetchOptions struct {
	Platforms []string
	Workers   int
}

var validPlatforms = map[string]bool{
	"greenhouse": true,
	"lever":      true,
	"ashby":      true,
}

var validSorts = map[string]bool{
	"relevance": true,
	"newest":    true,
	"oldest":    true,
	"company":   true,
	"title":     true,
}

var validFormats = map[string]bool{
	"table": true,
	"json":  true,
	"csv":   true,
}

func validateSearchOptions(opts searchOptions) error {
	workplaceFlags := 0
	for _, enabled := range []bool{opts.Remote, opts.Hybrid, opts.Onsite} {
		if enabled {
			workplaceFlags++
		}
	}
	if workplaceFlags > 1 {
		return fmt.Errorf("only one workplace flag may be used: --remote, --hybrid, or --onsite")
	}
	if opts.Fast && opts.CountOnly {
		return fmt.Errorf("--fast cannot be used with --count")
	}

	if err := validateDateFlag("since", opts.Since); err != nil {
		return err
	}
	if err := validateDateFlag("before", opts.Before); err != nil {
		return err
	}
	if err := validateChoice("sort", opts.Sort, validSorts, "relevance, newest, oldest, company, title"); err != nil {
		return err
	}
	if err := validateChoice("format", opts.Format, validFormats, "table, json, csv"); err != nil {
		return err
	}
	if _, err := normalizeSearchType(opts.Type); err != nil {
		return err
	}
	if err := validatePlatforms(opts.Platforms); err != nil {
		return err
	}
	if _, err := market.Resolve(opts.Markets); err != nil {
		return err
	}
	if opts.Limit < 0 {
		return fmt.Errorf("--limit must be 0 or greater")
	}
	if opts.Offset < 0 {
		return fmt.Errorf("--offset must be 0 or greater")
	}
	return nil
}

func validateFetchOptions(opts fetchOptions) error {
	if opts.Workers <= 0 {
		return fmt.Errorf("--workers must be greater than 0")
	}
	return validatePlatforms(opts.Platforms)
}

func validatePlatforms(platforms []string) error {
	for _, platform := range platforms {
		p := strings.ToLower(strings.TrimSpace(platform))
		if p == "" {
			continue
		}
		if !validPlatforms[p] {
			return fmt.Errorf("invalid platform %q (valid: greenhouse, lever, ashby)", platform)
		}
	}
	return nil
}

func validateDateFlag(name, value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if normalize.ParseSinceFlag(value).IsZero() {
		return fmt.Errorf("invalid --%s %q (use 7d, 30d, 2026-04-01, or RFC3339)", name, value)
	}
	return nil
}

func validateChoice(name, value string, allowed map[string]bool, validText string) error {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" || !allowed[normalized] {
		return fmt.Errorf("invalid --%s %q (valid: %s)", name, value, validText)
	}
	return nil
}

func normalizeSearchType(t string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case "":
		return "", nil
	case "full-time", "fulltime", "full_time":
		return "Full-Time", nil
	case "intern", "internship":
		return "Intern", nil
	case "contract", "contractor":
		return "Contract", nil
	case "temp", "temporary":
		return "Temporary", nil
	}
	return "", fmt.Errorf("invalid --type %q (valid: full-time, intern, contract, temp)", t)
}

func compileBooleanFTSFlag(flagName, value, column string, expander queryparser.Expander) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", nil
	}
	node, err := queryparser.Parse(value)
	if err != nil {
		return "", fmt.Errorf("invalid --%s: %w", flagName, err)
	}
	return queryparser.CompileFTSForColumnWith(node, column, expander), nil
}

func hasPositiveFTSAnchor(query, titleQueryFTS, keyQueryFTS string, locations []string, markets marketFilter, workplaceType, employmentType, country string, platforms, companies []string) bool {
	if strings.TrimSpace(query) != "" || strings.TrimSpace(titleQueryFTS) != "" || strings.TrimSpace(keyQueryFTS) != "" {
		return true
	}
	if len(locations) > 0 || len(markets.LocationTerms) > 0 || len(markets.CountryTerms) > 0 || len(platforms) > 0 || len(companies) > 0 {
		return true
	}
	return strings.TrimSpace(workplaceType) != "" ||
		strings.TrimSpace(employmentType) != "" ||
		strings.TrimSpace(country) != ""
}

func flattenCommaSeparated(values []string) []string {
	var out []string
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				out = append(out, trimmed)
			}
		}
	}
	return out
}

type marketFilter struct {
	Markets       []string
	LocationTerms []string
	CountryTerms  []string
}

// expandMarketFilters turns market IDs into the location/country text terms the
// FTS fallback uses. It deliberately does NOT take the user's --location: those
// terms are ANDed in on their own, so folding them in here would OR them with
// every market term and widen the very filter the user asked to narrow.
func expandMarketFilters(markets []string) (marketFilter, error) {
	resolved, err := market.Resolve(markets)
	if err != nil {
		return marketFilter{}, err
	}

	var out marketFilter
	add := func(target *[]string, seen map[string]bool, value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		key := strings.ToLower(value)
		if seen[key] {
			return
		}
		seen[key] = true
		*target = append(*target, value)
	}

	seenLocation := map[string]bool{}
	for _, term := range resolved.LocationTerms {
		add(&out.LocationTerms, seenLocation, term)
	}

	seenCountry := map[string]bool{}
	for _, term := range resolved.CountryTerms {
		add(&out.CountryTerms, seenCountry, term)
	}
	seenMarket := map[string]bool{}
	for _, market := range resolved.Markets {
		add(&out.Markets, seenMarket, market)
	}
	return out, nil
}
