package normalize

import (
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

var spaceRe = regexp.MustCompile(`\s+`)

// StripHTML extracts plain text from HTML using x/net/html tokenizer.
// It's faster than regex because it doesn't backtrack.
func StripHTML(input string) string {
	if input == "" {
		return ""
	}
	tokenizer := html.NewTokenizer(strings.NewReader(input))
	var sb strings.Builder
	sb.Grow(len(input) / 2)
	for {
		tt := tokenizer.Next()
		switch tt {
		case html.ErrorToken:
			return spaceRe.ReplaceAllString(strings.TrimSpace(sb.String()), " ")
		case html.TextToken:
			text := strings.TrimSpace(string(tokenizer.Text()))
			if text != "" {
				if sb.Len() > 0 {
					sb.WriteByte(' ')
				}
				sb.WriteString(text)
			}
		}
	}
}

// NormalizeWorkplace normalizes workplace type strings from all platforms
// into one of: "Remote" | "Hybrid" | "On-Site" | ""
func NormalizeWorkplace(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "remote":
		return "Remote"
	case "hybrid", "hybrid (travel-required)":
		return "Hybrid"
	case "onsite", "on-site", "on_site", "office":
		return "On-Site"
	}
	return ""
}

// NormalizeEmployment normalizes employment type strings from all platforms
// into one of: "Full-Time" | "Intern" | "Contract" | "Temporary" | ""
func NormalizeEmployment(raw string) string {
	switch strings.TrimSpace(raw) {
	case "FullTime", "Permanent", "Full-Time", "full-time", "fulltime":
		return "Full-Time"
	case "Intern", "intern", "Internship":
		return "Intern"
	case "Contract", "contract", "Full Time Contractor", "Contractor":
		return "Contract"
	case "Temporary", "temporary", "Short Term", "Temp":
		return "Temporary"
	}
	return ""
}

// NormalizeLeverDate converts a Lever Unix millisecond timestamp to ISO 8601.
func NormalizeLeverDate(unixMs int64) string {
	if unixMs <= 0 {
		return ""
	}
	t := time.UnixMilli(unixMs).UTC()
	return t.Format(time.RFC3339)
}

// ParseSinceFlag parses a duration string like "7d", "30d" or an ISO date
// into a time.Time cutoff. Returns zero time on error.
func ParseSinceFlag(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	s = strings.TrimSpace(s)
	// Duration format: "7d", "30d", "1d"
	if strings.HasSuffix(s, "d") {
		days := 0
		_, err := parseSimpleInt(s[:len(s)-1], &days)
		if err == nil && days > 0 {
			return time.Now().UTC().AddDate(0, 0, -days)
		}
	}
	// ISO date
	for _, layout := range []string{"2006-01-02", time.RFC3339, "2006-01-02T15:04:05Z"} {
		t, err := time.Parse(layout, s)
		if err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

func parseSimpleInt(s string, out *int) (int, error) {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, &parseError{s}
		}
		n = n*10 + int(c-'0')
	}
	*out = n
	return n, nil
}

type parseError struct{ s string }

func (e *parseError) Error() string { return "cannot parse: " + e.s }

// ExtractSalary tries to find a salary mention in plain text.
// Returns the surrounding sentence/phrase or empty string.
func ExtractSalary(text string) string {
	lower := strings.ToLower(text)
	keywords := []string{"base range", "salary range", "$", "per year", "annually", "compensation"}
	for _, kw := range keywords {
		idx := strings.Index(lower, kw)
		if idx >= 0 {
			start := idx - 80
			if start < 0 {
				start = 0
			}
			end := idx + 200
			if end > len(text) {
				end = len(text)
			}
			raw := strings.TrimSpace(text[start:end])
			raw = spaceRe.ReplaceAllString(raw, " ")
			if len(raw) > 250 {
				raw = raw[:250] + "..."
			}
			return raw
		}
	}
	return ""
}
