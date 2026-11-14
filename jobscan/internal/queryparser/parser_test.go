package queryparser

import (
	"strings"
	"testing"
)

func TestCompileFTS(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "and",
			input: `A AND B`,
			want:  `(description_plain : "A") AND (description_plain : "B")`,
		},
		{
			name:  "precedence",
			input: `A OR B AND C`,
			want:  `(description_plain : "A") OR ((description_plain : "B") AND (description_plain : "C"))`,
		},
		{
			name:  "nested",
			input: `A AND (B OR C)`,
			want:  `(description_plain : "A") AND ((description_plain : "B") OR (description_plain : "C"))`,
		},
		{
			name:  "phrases and symbols",
			input: `"distributed systems" OR ("Go" AND "Rust" OR "C++")`,
			want:  `(description_plain : "distributed systems") OR (((description_plain : "Go") AND (description_plain : "Rust")) OR (description_plain : "C++"))`,
		},
		{
			name:  "single quoted phrase",
			input: `'distributed systems' OR (Go AND Kafka)`,
			want:  `(description_plain : "distributed systems") OR ((description_plain : "Go") AND (description_plain : "Kafka"))`,
		},
		{
			name:  "escaped quote in phrase",
			input: `"cache \"eviction\"" AND Go`,
			want:  `(description_plain : "cache ""eviction""") AND (description_plain : "Go")`,
		},
		{
			name:  "symbol heavy terms",
			input: `C++ AND Node.js AND event-driven`,
			want:  `((description_plain : "C++") AND (description_plain : "Node.js")) AND (description_plain : "event-driven")`,
		},
		{
			name:  "deep nesting",
			input: `A AND (B OR (C AND (D OR (E AND F))))`,
			want:  `(description_plain : "A") AND ((description_plain : "B") OR ((description_plain : "C") AND ((description_plain : "D") OR ((description_plain : "E") AND (description_plain : "F")))))`,
		},
		{
			name:  "and not",
			input: `A AND NOT B`,
			want:  `(description_plain : "A") NOT (description_plain : "B")`,
		},
		{
			name:  "or with nested and not",
			input: `A OR (B AND NOT (C OR D))`,
			want:  `(description_plain : "A") OR ((description_plain : "B") NOT ((description_plain : "C") OR (description_plain : "D")))`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			node, err := Parse(tt.input)
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}
			if got := CompileFTS(node); got != tt.want {
				t.Fatalf("CompileFTS() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCompileFTSForColumn(t *testing.T) {
	node, err := Parse(`('software engineer' OR 'backend engineer') AND NOT ('senior software engineer' OR 'staff software engineer')`)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}

	want := `((title : "software engineer") OR (title : "backend engineer")) NOT ((title : "senior software engineer") OR (title : "staff software engineer"))`
	if got := CompileFTSForColumn(node, "title"); got != want {
		t.Fatalf("CompileFTSForColumn() = %q, want %q", got, want)
	}
}

func TestCompileFTSComplexQueryContainsExpectedDescriptionTerms(t *testing.T) {
	input := `"distributed systems" OR ("Go" AND ("Rust" OR "C++" OR ("Kubernetes" AND "Docker"))) OR (backend AND ("event-driven" OR microservices) AND ("PostgreSQL" OR "SQLite"))`

	node, err := Parse(input)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}

	got := CompileFTS(node)

	expectedTerms := []string{
		`(description_plain : "distributed systems")`,
		`(description_plain : "Go")`,
		`(description_plain : "Rust")`,
		`(description_plain : "C++")`,
		`(description_plain : "Kubernetes")`,
		`(description_plain : "Docker")`,
		`(description_plain : "backend")`,
		`(description_plain : "event-driven")`,
		`(description_plain : "microservices")`,
		`(description_plain : "PostgreSQL")`,
		`(description_plain : "SQLite")`,
	}

	for _, term := range expectedTerms {
		if !strings.Contains(got, term) {
			t.Fatalf("compiled query missing term %q in %q", term, got)
		}
	}
}

func TestParseErrors(t *testing.T) {
	tests := []string{
		``,
		`(`,
		`A AND`,
		`A OR )`,
		`"unterminated`,
		`'unterminated`,
		`""`,
		`''`,
		`A B`,
		`A (B)`,
		`A OR OR B`,
		`(A OR B))`,
		`NOT A`,
		`A OR NOT B`,
		`A AND NOT`,
		`A AND NOT OR B`,
	}

	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			if _, err := Parse(input); err == nil {
				t.Fatalf("Parse(%q) expected error", input)
			}
		})
	}
}
