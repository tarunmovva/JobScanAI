package queryparser

import (
	"fmt"
	"strings"
)

type tokenType int

const (
	tokenEOF tokenType = iota
	tokenAnd
	tokenOr
	tokenNot
	tokenLParen
	tokenRParen
	tokenTerm
)

type token struct {
	typ tokenType
	val string
	pos int
}

type NodeType int

const (
	NodeTerm NodeType = iota
	NodeAnd
	NodeOr
	NodeNot
)

type Node struct {
	Type  NodeType
	Value string
	Left  *Node
	Right *Node
}

func Parse(input string) (*Node, error) {
	tokens, err := lex(input)
	if err != nil {
		return nil, err
	}
	p := parser{tokens: tokens}
	node, err := p.parseExpr()
	if err != nil {
		return nil, err
	}
	if p.current().typ != tokenEOF {
		tok := p.current()
		return nil, fmt.Errorf("unexpected token %q at position %d", tok.val, tok.pos)
	}
	if node == nil {
		return nil, fmt.Errorf("empty boolean query")
	}
	return node, nil
}

// An Expander supplies the alternative spellings of a single term. The corpus
// itself is the source of truth (see internal/db.TermExpander); a nil Expander
// means "search exactly what you were given", which is the old behaviour.
type Expander interface {
	Variants(term string) []string
}

func CompileFTS(node *Node) string {
	return CompileFTSForColumn(node, "description_plain")
}

func CompileFTSForColumn(node *Node, column string) string {
	return compile(node, column, true, nil)
}

// CompileFTSForColumnWith compiles every term into an OR of its real spellings.
// Without it, `--key-query fullstack` matched 646 of the ~10,300 full-stack
// postings in this database and reported no error.
func CompileFTSForColumnWith(node *Node, column string, exp Expander) string {
	return compile(node, column, true, exp)
}

func compile(node *Node, column string, topLevel bool, exp Expander) string {
	switch node.Type {
	case NodeTerm:
		return `(` + column + ` : ` + termExpr(node.Value, exp) + `)`
	case NodeAnd:
		if node.Right != nil && node.Right.Type == NodeNot {
			return joinNot(node.Left, node.Right.Left, column, topLevel, exp)
		}
		if node.Left != nil && node.Left.Type == NodeNot {
			return joinNot(node.Right, node.Left.Left, column, topLevel, exp)
		}
		return joinBinary(node, "AND", column, topLevel, exp)
	case NodeOr:
		return joinBinary(node, "OR", column, topLevel, exp)
	case NodeNot:
		return "NOT " + compile(node.Left, column, false, exp)
	default:
		return ""
	}
}

// termExpr renders one term as itself, or as an OR of every spelling of it that
// the corpus actually contains. FTS5 accepts `col : (a OR b)`, so the column
// prefix is written once by the caller.
func termExpr(value string, exp Expander) string {
	if exp == nil {
		return quoteFTS(value)
	}
	variants := exp.Variants(value)
	if len(variants) <= 1 {
		return quoteFTS(value)
	}
	parts := make([]string, 0, len(variants))
	for _, variant := range variants {
		parts = append(parts, quoteFTS(variant))
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

func joinBinary(node *Node, op string, column string, topLevel bool, exp Expander) string {
	expr := compile(node.Left, column, false, exp) + " " + op + " " + compile(node.Right, column, false, exp)
	if topLevel {
		return expr
	}
	return "(" + expr + ")"
}

func joinNot(include *Node, exclude *Node, column string, topLevel bool, exp Expander) string {
	expr := compile(include, column, false, exp) + " NOT " + compile(exclude, column, false, exp)
	if topLevel {
		return expr
	}
	return "(" + expr + ")"
}

func quoteFTS(term string) string {
	term = strings.TrimSpace(term)
	// FTS5 prefix syntax is `"kubernet" *` -- the star sits OUTSIDE the quotes.
	// Quoting it made the literal token `kubernet*`, which matches nothing and
	// returns 0 rows with no error, while `kubernetes` returns 12,094.
	suffix := ""
	if trimmed := strings.TrimRight(term, "*"); trimmed != term && trimmed != "" {
		term, suffix = trimmed, " *"
	}
	return `"` + strings.ReplaceAll(term, `"`, `""`) + `"` + suffix
}

type parser struct {
	tokens []token
	pos    int
}

func (p *parser) parseExpr() (*Node, error) {
	return p.parseOr()
}

func (p *parser) parseOr() (*Node, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.match(tokenOr) {
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = &Node{Type: NodeOr, Left: left, Right: right}
	}
	return left, nil
}

func (p *parser) parseAnd() (*Node, error) {
	left, err := p.parsePrimary()
	if err != nil {
		return nil, err
	}
	for p.match(tokenAnd) {
		negated := p.match(tokenNot)
		right, err := p.parsePrimary()
		if err != nil {
			return nil, err
		}
		if negated {
			right = &Node{Type: NodeNot, Left: right}
		}
		left = &Node{Type: NodeAnd, Left: left, Right: right}
	}
	return left, nil
}

func (p *parser) parsePrimary() (*Node, error) {
	tok := p.current()
	switch tok.typ {
	case tokenTerm:
		p.pos++
		return &Node{Type: NodeTerm, Value: tok.val}, nil
	case tokenLParen:
		p.pos++
		expr, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		if p.current().typ != tokenRParen {
			return nil, fmt.Errorf("expected ')' at position %d", p.current().pos)
		}
		p.pos++
		return expr, nil
	case tokenEOF:
		return nil, fmt.Errorf("unexpected end of query")
	default:
		return nil, fmt.Errorf("unexpected token %q at position %d", tok.val, tok.pos)
	}
}

func (p *parser) match(tt tokenType) bool {
	if p.current().typ == tt {
		p.pos++
		return true
	}
	return false
}

func (p *parser) current() token {
	if p.pos >= len(p.tokens) {
		return token{typ: tokenEOF, pos: len(p.tokens)}
	}
	return p.tokens[p.pos]
}

func lex(input string) ([]token, error) {
	var tokens []token
	for i := 0; i < len(input); {
		switch input[i] {
		case ' ', '\t', '\n', '\r':
			i++
		case '(':
			tokens = append(tokens, token{typ: tokenLParen, val: "(", pos: i})
			i++
		case ')':
			tokens = append(tokens, token{typ: tokenRParen, val: ")", pos: i})
			i++
		case '"', '\'':
			start := i
			quote := input[i]
			i++
			var b strings.Builder
			for i < len(input) {
				if input[i] == '\\' && i+1 < len(input) {
					b.WriteByte(input[i+1])
					i += 2
					continue
				}
				if input[i] == quote {
					i++
					break
				}
				b.WriteByte(input[i])
				i++
			}
			if i > len(input) || (i == len(input) && (len(input) == 0 || input[i-1] != quote)) {
				return nil, fmt.Errorf("unterminated quote at position %d", start)
			}
			if strings.TrimSpace(b.String()) == "" {
				return nil, fmt.Errorf("empty quoted term at position %d", start)
			}
			tokens = append(tokens, token{typ: tokenTerm, val: b.String(), pos: start})
		default:
			start := i
			for i < len(input) && !isSpace(input[i]) && input[i] != '(' && input[i] != ')' {
				i++
			}
			word := input[start:i]
			upper := strings.ToUpper(word)
			switch upper {
			case "AND":
				tokens = append(tokens, token{typ: tokenAnd, val: word, pos: start})
			case "OR":
				tokens = append(tokens, token{typ: tokenOr, val: word, pos: start})
			case "NOT":
				tokens = append(tokens, token{typ: tokenNot, val: word, pos: start})
			default:
				tokens = append(tokens, token{typ: tokenTerm, val: word, pos: start})
			}
		}
	}
	tokens = append(tokens, token{typ: tokenEOF, pos: len(input)})
	return tokens, nil
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}
