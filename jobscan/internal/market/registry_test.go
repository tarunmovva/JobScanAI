package market

import (
	"strings"
	"testing"
)

func TestResolveCountryMarketsIncludeBroadTermsWithoutGenericRemote(t *testing.T) {
	tests := []struct {
		name      string
		markets   []string
		wantTerms []string
	}{
		{
			name:    "usa",
			markets: []string{"usa"},
			wantTerms: []string{
				"United States", "United States of America", "USA", "US",
				"Remote US", "Remote USA", "Remote United States",
				"Alabama", "Alaska", "Arizona", "Arkansas", "California",
				"Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
				"Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas",
				"Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts",
				"Michigan", "Minnesota", "Mississippi", "Missouri", "Montana",
				"Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
				"New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma",
				"Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
				"South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
				"Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
				"District of Columbia", "Puerto Rico",
				"New York City", "NYC", "San Francisco", "Bay Area", "Silicon Valley",
				"Seattle", "Boston", "Austin", "Los Angeles", "Chicago", "Denver",
				"Atlanta", "Miami", "Washington DC", "Raleigh", "Durham",
				"Phoenix", "Portland", "Philadelphia", "Minneapolis", "Nashville",
				"Salt Lake City", "Boise", "Ann Arbor", "Bentonville",
			},
		},
		{
			name:    "netherlands",
			markets: []string{"nl"},
			wantTerms: []string{
				"Netherlands", "The Netherlands", "Nederland", "Holland",
				"Remote Netherlands", "Remote NL",
				"Noord-Holland", "Zuid-Holland", "Utrecht Province", "North Brabant",
				"Amsterdam", "Rotterdam", "Utrecht", "Eindhoven", "The Hague",
				"Den Haag", "Delft", "Leiden", "Groningen", "Arnhem", "Nijmegen",
				"Tilburg", "Breda", "Maastricht", "Enschede", "Amersfoort",
				"Almere", "Zwolle", "Apeldoorn", "Leeuwarden", "Schiphol",
			},
		},
		{
			name:    "ireland",
			markets: []string{"ie"},
			wantTerms: []string{
				"Ireland", "Republic of Ireland", "Eire",
				"Remote Ireland", "Remote IE",
				"Dublin", "Cork", "Galway", "Limerick", "Waterford", "Kildare",
				"Meath", "Wicklow", "Louth", "Clare", "Kerry", "Mayo",
				"Donegal", "Sligo", "Kilkenny", "Wexford", "Carlow",
				"Drogheda", "Dundalk", "Bray", "Navan", "Ennis", "Tralee",
				"Athlone", "Letterkenny", "Maynooth", "Naas",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolved, err := Resolve(tt.markets)
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			assertContainsTerms(t, resolved.Terms, tt.wantTerms)
			assertContainsTerms(t, resolved.LocationTerms, tt.wantTerms)
			assertContainsTerms(t, resolved.CountryTerms, tt.wantTerms[:3])
			assertNotContainsTerm(t, resolved.Terms, "Remote")
			assertNotContainsTerm(t, resolved.LocationTerms, "Remote")
			assertNotContainsTerm(t, resolved.CountryTerms, "Remote")
			assertNoBlankOrDuplicateTerms(t, resolved.Terms)
			assertNoBlankOrDuplicateTerms(t, resolved.LocationTerms)
			assertNoBlankOrDuplicateTerms(t, resolved.CountryTerms)
		})
	}
}

func TestResolveMetaMarketsAndAliases(t *testing.T) {
	resolved, err := Resolve([]string{"united-states", "europe", "remote-global"})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}

	assertContainsTerms(t, resolved.Terms, []string{
		"United States", "California", "Boston",
		"United Kingdom", "London",
		"Netherlands", "Amsterdam",
		"Ireland", "Dublin",
		"Germany", "Berlin",
		"France", "Paris",
		"Worldwide", "Global", "Remote",
	})
	assertContainsMarkets(t, resolved.Markets, []string{
		"usa", "uk", "ireland", "netherlands", "germany", "france", "remote-global",
	})
	assertNoBlankOrDuplicateTerms(t, resolved.Terms)
}

func TestResolveRejectsUnknownMarketsWithSuggestions(t *testing.T) {
	_, err := Resolve([]string{"usa", "narnia"})
	if err == nil {
		t.Fatalf("Resolve() expected error")
	}
	for _, want := range []string{`unknown market "narnia"`, "usa", "netherlands", "remote-global"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err.Error(), want)
		}
	}
}

func TestKnownMarketsIncludesCoreAndMetaMarkets(t *testing.T) {
	got := KnownMarkets()
	assertContainsTerms(t, got, []string{
		"usa", "canada", "uk", "ireland", "netherlands", "germany",
		"india", "singapore", "australia", "remote-global",
		"north-america", "europe", "eu", "apac", "latam", "emea",
	})
	assertNoBlankOrDuplicateTerms(t, got)
}

func assertContainsTerms(t *testing.T, got []string, want []string) {
	t.Helper()

	set := make(map[string]bool, len(got))
	for _, term := range got {
		set[term] = true
	}
	for _, term := range want {
		if !set[term] {
			t.Fatalf("terms missing %q in %v", term, got)
		}
	}
}

func assertContainsMarkets(t *testing.T, got []string, want []string) {
	t.Helper()
	assertContainsTerms(t, got, want)
}

func assertNotContainsTerm(t *testing.T, got []string, term string) {
	t.Helper()

	for _, gotTerm := range got {
		if gotTerm == term {
			t.Fatalf("terms should not contain %q: %v", term, got)
		}
	}
}

func assertNoBlankOrDuplicateTerms(t *testing.T, terms []string) {
	t.Helper()

	seen := map[string]bool{}
	for _, term := range terms {
		if strings.TrimSpace(term) == "" {
			t.Fatalf("blank term in %v", terms)
		}
		key := strings.ToLower(term)
		if seen[key] {
			t.Fatalf("duplicate term %q in %v", term, terms)
		}
		seen[key] = true
	}
}
