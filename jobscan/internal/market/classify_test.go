package market

import "testing"

func TestClassifyMarketsIncludesParents(t *testing.T) {
	tests := []struct {
		name      string
		location  string
		country   string
		workplace string
		want      []string
	}{
		{
			name:      "us country",
			location:  "Boston, MA",
			country:   "United States",
			workplace: "Remote",
			want:      []string{"north-america", "usa"},
		},
		{
			name:     "remote us location",
			location: "Remote - US",
			want:     []string{"north-america", "usa"},
		},
		{
			name:     "netherlands city",
			location: "Amsterdam, Netherlands",
			want:     []string{"emea", "eu", "europe", "netherlands"},
		},
		{
			name:     "ireland country",
			location: "Dublin",
			country:  "Ireland",
			want:     []string{"emea", "eu", "europe", "ireland"},
		},
		{
			name:     "global remote",
			location: "Remote, Worldwide",
			want:     []string{"remote-global"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Classify(tt.location, tt.country, tt.workplace)
			assertMarkets(t, got, tt.want)
		})
	}
}

func TestClassifyMarketsAvoidsAmbiguousCityWhenCountryIsKnown(t *testing.T) {
	got := Classify("San Jose, Costa Rica", "Costa Rica", "")
	assertMarkets(t, got, []string{"costa-rica", "latam"})
	assertNotMarket(t, got, "usa")
	assertNotMarket(t, got, "north-america")
}

func assertMarkets(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("markets = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("markets = %v, want %v", got, want)
		}
	}
}

func assertNotMarket(t *testing.T, got []string, market string) {
	t.Helper()
	for _, item := range got {
		if item == market {
			t.Fatalf("markets = %v, did not want %q", got, market)
		}
	}
}
