package db

import (
	"database/sql"
	"fmt"
	"strings"
)

// The FTS tokenizer treats '-' as a word character (tokenchars '+#-.@'), which
// is right for C++, C#, .NET and node.js but makes every compound term three
// unrelated tokens. Measured on 271,700 real postings:
//
//	fullstack     646     full-stack   6,091    "full stack"  3,588
//	ecommerce   2,716     e-commerce   5,752
//	backend    16,379     back-end     2,290    "back end"      238
//
// A query written `fullstack` therefore reaches 6% of the full-stack jobs in
// the database and reports no error. Asking the caller to spell out every form
// works only as long as the caller remembers, for every term, forever.
//
// Instead the spellings are derived from the index itself: fts5vocab exposes
// the real vocabulary, so the variants of a term are whatever the corpus
// actually contains. That is data-driven, needs no curated word list, and is
// correct for any database, not just this one.

const (
	// Terms rarer than this are typos and one-off strings; expanding into them
	// costs query time and buys nothing.
	termIndexMinCount = 5
	// Below this length a de-hyphenated form collides with common words
	// (".net" -> "net", "e-x" -> "ex"), which would over-expand.
	termIndexMinNormLen = 5
	// A genuine inflection occurs at a rate comparable to its base form; a word
	// that merely LOOKS like one is orders of magnitude rarer. Measured on this
	// corpus (occurrences of base vs +s):
	//
	//	service/services   0.92   engineer/engineers 0.80   developer/-s 0.68
	//	manager/managers   0.33   test/tests         0.19   build/builds 0.07
	//	-- boundary --
	//	senior/seniors     0.013  cloud/clouds       0.011  react/reacts 0.006
	//	data/datas         0.000
	//
	// "seniors" is about elderly people and "reacts" is a verb; neither belongs
	// in a search for Senior or React. 0.05 separates the two groups cleanly.
	termPluralMinRatio = 0.05
)

// normalizeTerm is the join key between spellings: hyphens removed, lowercased.
// Only '-' is stripped. Stripping '.' as well would make `net` expand into
// `.net`, and '+'/'#' would collapse `c++` and `c#` onto `c`.
func normalizeTerm(term string) string {
	return strings.ToLower(strings.ReplaceAll(term, "-", ""))
}

// BuildTermIndex materialises the FTS vocabulary into a plain table. Scanning
// fts5vocab directly costs ~90s on this corpus, which is fine once and absurd
// per query, so the scan happens here and lookups hit a b-tree.
func BuildTermIndex(db *sql.DB) (int, error) {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS fts_terms (
			term TEXT PRIMARY KEY,
			cnt  INTEGER NOT NULL,
			norm TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_fts_terms_norm ON fts_terms(norm);
	`); err != nil {
		return 0, fmt.Errorf("create fts_terms: %w", err)
	}
	if _, err := db.Exec(`DROP TABLE IF EXISTS temp.jobs_vocab`); err != nil {
		return 0, fmt.Errorf("drop temp vocab: %w", err)
	}
	if _, err := db.Exec(
		`CREATE VIRTUAL TABLE temp.jobs_vocab USING fts5vocab('main', 'jobs_fts', 'row')`); err != nil {
		return 0, fmt.Errorf("create vocab: %w", err)
	}
	defer db.Exec(`DROP TABLE IF EXISTS temp.jobs_vocab`)

	if _, err := db.Exec(`DELETE FROM fts_terms`); err != nil {
		return 0, fmt.Errorf("clear fts_terms: %w", err)
	}
	// length() counts characters, so a 3-char floor drops single letters. The
	// GLOB drops pure punctuation: '-' alone occurs 1.68M times and rules of
	// dashes ('----') are among the most repeated "terms" in the vocabulary.
	res, err := db.Exec(`
		INSERT OR REPLACE INTO fts_terms(term, cnt, norm)
		SELECT term, cnt, replace(term, '-', '')
		FROM temp.jobs_vocab
		WHERE cnt >= ? AND length(term) >= 3 AND term GLOB '*[a-z0-9]*'`, termIndexMinCount)
	if err != nil {
		return 0, fmt.Errorf("populate fts_terms: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// TermExpander answers "what else could this term be spelled as", using only
// spellings that actually occur in the corpus.
type TermExpander struct {
	byNorm  *sql.Stmt
	byExact *sql.Stmt
}

// NewTermExpander returns nil (and no error) when the term index has not been
// built. Search must keep working on a database that predates it -- it just
// searches exactly what it was given, as before.
func NewTermExpander(db *sql.DB) (*TermExpander, error) {
	var name string
	err := db.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='fts_terms'`).Scan(&name)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM fts_terms`).Scan(&n); err != nil || n == 0 {
		return nil, nil
	}
	byNorm, err := db.Prepare(`SELECT term FROM fts_terms WHERE norm = ? ORDER BY cnt DESC LIMIT 8`)
	if err != nil {
		return nil, err
	}
	byExact, err := db.Prepare(`SELECT cnt FROM fts_terms WHERE term = ?`)
	if err != nil {
		byNorm.Close()
		return nil, err
	}
	return &TermExpander{byNorm: byNorm, byExact: byExact}, nil
}

func (e *TermExpander) Close() {
	if e == nil {
		return
	}
	if e.byNorm != nil {
		e.byNorm.Close()
	}
	if e.byExact != nil {
		e.byExact.Close()
	}
}

// count returns how often term occurs in the corpus, 0 when it does not.
func (e *TermExpander) count(term string) int {
	if e == nil {
		return 0
	}
	var cnt int
	if err := e.byExact.QueryRow(term).Scan(&cnt); err != nil {
		return 0
	}
	return cnt
}

func (e *TermExpander) exists(term string) bool { return e.count(term) > 0 }

// inflectionOf reports whether a and b are plausibly the same word, using how
// often each actually occurs rather than a hand-built exception list.
func (e *TermExpander) inflectionOf(base, candidate string) bool {
	baseCount, candidateCount := e.count(base), e.count(candidate)
	if baseCount == 0 || candidateCount == 0 {
		return false
	}
	smaller, larger := baseCount, candidateCount
	if smaller > larger {
		smaller, larger = larger, smaller
	}
	return float64(smaller)/float64(larger) >= termPluralMinRatio
}

// Variants returns every spelling of term worth searching, the term itself
// always first. A returned value containing a space is an FTS phrase.
func (e *TermExpander) Variants(term string) []string {
	term = strings.TrimSpace(term)
	out := []string{term}
	if e == nil || term == "" {
		return out
	}
	// A prefix query is already open-ended; expanding it would multiply an
	// unbounded match set for no gain.
	if strings.HasSuffix(term, "*") {
		return out
	}

	seen := map[string]bool{strings.ToLower(term): true}
	add := func(candidate string) {
		candidate = strings.TrimSpace(candidate)
		key := strings.ToLower(candidate)
		if candidate == "" || seen[key] {
			return
		}
		seen[key] = true
		out = append(out, candidate)
	}

	// A multi-word phrase ("back end") is the spaced spelling; the joined and
	// hyphenated forms are single tokens the phrase can never reach.
	if fields := strings.Fields(term); len(fields) > 1 {
		joined := strings.ToLower(strings.Join(fields, ""))
		hyphenated := strings.ToLower(strings.Join(fields, "-"))
		if len(joined) >= termIndexMinNormLen {
			if e.exists(joined) {
				add(joined)
			}
			if e.exists(hyphenated) {
				add(hyphenated)
			}
		}
		return out
	}

	norm := normalizeTerm(term)
	if len(norm) >= termIndexMinNormLen {
		rows, err := e.byNorm.Query(norm)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var variant string
				if rows.Scan(&variant) != nil {
					continue
				}
				add(variant)
				// The hyphenated spelling implies a spaced one the tokenizer
				// indexes as separate tokens, and vice versa.
				if strings.Contains(variant, "-") {
					add(strings.ReplaceAll(variant, "-", " "))
				}
			}
		}
	}

	// Plurals are morphological, not orthographic, so no hyphen key finds them:
	// `engineer` matches 47,862 postings and `engineers` matches 55,908. Only
	// the trivial -s pair, and only when the corpus really has the other form.
	for _, base := range append([]string{}, out...) {
		if strings.Contains(base, " ") || strings.Contains(base, "-") || len(base) < 4 {
			continue
		}
		lower := strings.ToLower(base)
		switch {
		case strings.HasSuffix(lower, "ss"):
			// "business" / "access" -- stripping the s makes a different word.
		case strings.HasSuffix(lower, "s"):
			if singular := lower[:len(lower)-1]; e.inflectionOf(lower, singular) {
				add(singular)
			}
		default:
			if plural := lower + "s"; e.inflectionOf(lower, plural) {
				add(plural)
			}
		}
	}
	return out
}
