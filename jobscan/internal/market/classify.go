package market

import (
	"sort"
	"strings"
	"unicode"
)

type classifierRule struct {
	id            string
	locationTerms []string
	countryTerms  []string
}

var (
	classifierRules = buildClassifierRules()
	parentIndex     = buildParentIndex()
)

// Classify returns all canonical markets that a job belongs to based on its
// source-provided location/country text. Meta markets are included when a child
// market matches.
func Classify(location, country, _ string) []string {
	locationText := normalizedTokenText(location)
	countryText := normalizedTokenText(country)

	matched := map[string]bool{}
	strongCountry := map[string]bool{}

	for _, rule := range classifierRules {
		if countryText != "" && matchesAnyTerm(countryText, rule.countryTerms) {
			strongCountry[rule.id] = true
		}
		if locationText != "" && matchesAnyTerm(locationText, rule.countryTerms) {
			strongCountry[rule.id] = true
		}
	}

	for id := range strongCountry {
		addMarketWithParents(matched, id)
	}

	if locationText != "" && matchesRemoteGlobal(locationText, len(strongCountry) > 0) {
		addMarketWithParents(matched, "remote-global")
	}

	// If the country is clear, do not let ambiguous city names such as
	// "San Jose" or "Birmingham" pull the job into an unrelated market.
	if len(strongCountry) == 0 && locationText != "" {
		for _, rule := range classifierRules {
			if matchesAnyTerm(locationText, rule.locationTerms) {
				addMarketWithParents(matched, rule.id)
			}
		}
	}

	out := make([]string, 0, len(matched))
	for id := range matched {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func buildClassifierRules() []classifierRule {
	rules := make([]classifierRule, 0, len(registry))
	for id, m := range registry {
		if len(m.ExpandsTo) > 0 {
			continue
		}
		locationTerms := make([]string, 0, len(m.CountryTerms)+len(m.RegionTerms)+len(m.CityTerms)+len(m.MetroTerms)+len(m.RemoteTerms))
		locationTerms = append(locationTerms, normalizeTerms(m.CountryTerms)...)
		locationTerms = append(locationTerms, normalizeTerms(m.RegionTerms)...)
		locationTerms = append(locationTerms, normalizeTerms(m.CityTerms)...)
		locationTerms = append(locationTerms, normalizeTerms(m.MetroTerms)...)
		locationTerms = append(locationTerms, normalizeTerms(m.RemoteTerms)...)

		rules = append(rules, classifierRule{
			id:            id,
			locationTerms: dedupeTerms(locationTerms),
			countryTerms:  dedupeTerms(normalizeTerms(m.CountryTerms)),
		})
	}
	sort.Slice(rules, func(i, j int) bool {
		return rules[i].id < rules[j].id
	})
	return rules
}

func buildParentIndex() map[string][]string {
	parents := map[string][]string{}
	var addChildren func(parent string, children []string)
	addChildren = func(parent string, children []string) {
		for _, childRef := range children {
			child, err := Canonical(childRef)
			if err != nil || child == "" {
				continue
			}
			parents[child] = append(parents[child], parent)
			if childMarket, ok := registry[child]; ok && len(childMarket.ExpandsTo) > 0 {
				addChildren(parent, childMarket.ExpandsTo)
			}
		}
	}
	for id, m := range registry {
		if len(m.ExpandsTo) == 0 {
			continue
		}
		addChildren(id, m.ExpandsTo)
	}
	for child := range parents {
		sort.Strings(parents[child])
		parents[child] = dedupeTerms(parents[child])
	}
	return parents
}

func addMarketWithParents(target map[string]bool, id string) {
	if target[id] {
		return
	}
	target[id] = true
	for _, parent := range parentIndex[id] {
		addMarketWithParents(target, parent)
	}
}

func matchesMarketLocation(text, id string) bool {
	for _, rule := range classifierRules {
		if rule.id == id {
			return matchesAnyTerm(text, rule.locationTerms)
		}
	}
	return false
}

func matchesRemoteGlobal(text string, hasSpecificCountry bool) bool {
	if strings.Contains(text, " worldwide ") ||
		strings.Contains(text, " global ") ||
		strings.Contains(text, " anywhere ") ||
		strings.Contains(text, " work from anywhere ") ||
		strings.Contains(text, " distributed ") {
		return true
	}
	if hasSpecificCountry {
		return false
	}
	return text == " remote "
}

func matchesAnyTerm(text string, terms []string) bool {
	for _, term := range terms {
		if term != "" && strings.Contains(text, term) {
			return true
		}
	}
	return false
}

func normalizeTerms(terms []string) []string {
	out := make([]string, 0, len(terms))
	for _, term := range terms {
		if normalized := normalizedTokenText(term); normalized != "" {
			out = append(out, normalized)
		}
	}
	return out
}

func dedupeTerms(terms []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(terms))
	for _, term := range terms {
		if term == "" || seen[term] {
			continue
		}
		seen[term] = true
		out = append(out, term)
	}
	return out
}

func normalizedTokenText(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return ""
	}
	var b strings.Builder
	lastSpace := true
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			lastSpace = false
			continue
		}
		if !lastSpace {
			b.WriteByte(' ')
			lastSpace = true
		}
	}
	normalized := strings.TrimSpace(b.String())
	if normalized == "" {
		return ""
	}
	return " " + normalized + " "
}
