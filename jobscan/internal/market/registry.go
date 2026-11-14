package market

import (
	"fmt"
	"sort"
	"strings"
)

// Market defines a broad hiring-market preset. Country terms are usable in the
// country column; all terms are usable as quoted FTS phrases in location text.
type Market struct {
	ID           string
	Aliases      []string
	CountryTerms []string
	RegionTerms  []string
	CityTerms    []string
	MetroTerms   []string
	RemoteTerms  []string
	ExpandsTo    []string
}

// Resolution is the fully-expanded market result.
type Resolution struct {
	Markets       []string
	Terms         []string
	LocationTerms []string
	CountryTerms  []string
}

// Resolve expands canonical market IDs, aliases, and meta markets into
// deduplicated location terms.
func Resolve(inputs []string) (Resolution, error) {
	var out Resolution
	seenMarkets := map[string]bool{}
	seenTerms := map[string]bool{}
	seenLocationTerms := map[string]bool{}
	seenCountryTerms := map[string]bool{}
	visiting := map[string]bool{}

	addDeduped := func(target *[]string, seen map[string]bool, term string) {
		term = strings.TrimSpace(term)
		if term == "" {
			return
		}
		key := strings.ToLower(term)
		if seen[key] {
			return
		}
		seen[key] = true
		*target = append(*target, term)
	}
	addTerm := func(term string) {
		addDeduped(&out.Terms, seenTerms, term)
		addDeduped(&out.LocationTerms, seenLocationTerms, term)
	}
	addCountryTerm := func(term string) {
		addTerm(term)
		addDeduped(&out.CountryTerms, seenCountryTerms, term)
	}

	var expand func(id string) error
	expand = func(id string) error {
		m, ok := registry[id]
		if !ok {
			return unknownMarketError(id)
		}
		if visiting[id] {
			return fmt.Errorf("market expansion cycle at %q", id)
		}
		if seenMarkets[id] {
			return nil
		}
		visiting[id] = true
		for _, child := range m.ExpandsTo {
			canonical, err := Canonical(child)
			if err != nil {
				return err
			}
			if err := expand(canonical); err != nil {
				return err
			}
		}
		visiting[id] = false
		seenMarkets[id] = true
		out.Markets = append(out.Markets, id)

		for _, term := range m.CountryTerms {
			addCountryTerm(term)
		}
		for _, group := range [][]string{m.RegionTerms, m.CityTerms, m.MetroTerms, m.RemoteTerms} {
			for _, term := range group {
				addTerm(term)
			}
		}
		return nil
	}

	for _, input := range inputs {
		canonical, err := Canonical(input)
		if err != nil {
			return Resolution{}, err
		}
		if canonical == "" {
			continue
		}
		if err := expand(canonical); err != nil {
			return Resolution{}, err
		}
	}
	return out, nil
}

// Canonical returns the canonical market ID for an ID or alias.
func Canonical(input string) (string, error) {
	key := normalizeKey(input)
	if key == "" {
		return "", nil
	}
	if id, ok := aliasIndex[key]; ok {
		return id, nil
	}
	return "", unknownMarketError(input)
}

// KnownMarkets returns sorted canonical market IDs.
func KnownMarkets() []string {
	out := make([]string, 0, len(registry))
	for id := range registry {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func unknownMarketError(input string) error {
	return fmt.Errorf("unknown market %q (valid: %s)", input, strings.Join(KnownMarkets(), ", "))
}

func normalizeKey(input string) string {
	key := strings.ToLower(strings.TrimSpace(input))
	key = strings.ReplaceAll(key, "_", "-")
	key = strings.ReplaceAll(key, " ", "-")
	for strings.Contains(key, "--") {
		key = strings.ReplaceAll(key, "--", "-")
	}
	return key
}

func buildAliasIndex() map[string]string {
	idx := map[string]string{}
	for id, m := range registry {
		idx[normalizeKey(id)] = id
		for _, alias := range m.Aliases {
			idx[normalizeKey(alias)] = id
		}
	}
	return idx
}

func terms(values ...string) []string {
	return values
}

var registry = map[string]Market{
	"usa": {
		ID:      "usa",
		Aliases: terms("us", "united-states", "united states", "america", "united-states-of-america"),
		CountryTerms: terms(
			"United States", "United States of America", "USA", "US", "U.S.", "U.S.A.", "America",
		),
		RemoteTerms: terms(
			"Remote US", "Remote USA", "Remote United States", "Remote within US", "Remote within United States",
			"US Remote", "USA Remote", "United States Remote", "US-based Remote", "United States-based Remote",
		),
		RegionTerms: append(terms(
			"Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
			"Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
			"Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
			"Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
			"New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
			"Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
			"Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
			"Wisconsin", "Wyoming", "District of Columbia", "Washington DC", "Puerto Rico", "Guam",
			"US Virgin Islands", "American Samoa", "Northern Mariana Islands",
			"East Coast", "West Coast", "Pacific Northwest", "New England", "Midwest", "Southeast",
			"Southwest", "Mountain West", "Mid-Atlantic", "Research Triangle",
		), terms(
			"Northeast US", "Southern US", "Western US", "Central US",
		)...),
		MetroTerms: terms(
			"New York City", "NYC", "Bay Area", "San Francisco Bay Area", "Silicon Valley",
			"Greater Boston", "Greater Seattle", "Greater Los Angeles", "Greater Chicago",
			"Research Triangle", "Dallas-Fort Worth", "DFW", "Twin Cities", "Washington DC Metro",
		),
		CityTerms: terms(
			"New York", "Brooklyn", "Manhattan", "Queens", "Jersey City", "Newark",
			"San Francisco", "San Jose", "Palo Alto", "Mountain View", "Sunnyvale", "Santa Clara",
			"Menlo Park", "Redwood City", "Oakland", "Berkeley", "Fremont", "Cupertino",
			"Seattle", "Bellevue", "Redmond", "Kirkland", "Bothell", "Tacoma", "Olympia",
			"Boston", "Cambridge", "Somerville", "Waltham", "Burlington", "Newton",
			"Austin", "Dallas", "Fort Worth", "Houston", "San Antonio", "Plano", "Frisco",
			"Los Angeles", "Santa Monica", "Culver City", "Irvine", "Orange County", "San Diego",
			"Chicago", "Evanston", "Naperville", "Denver", "Boulder", "Colorado Springs",
			"Atlanta", "Alpharetta", "Miami", "Tampa", "Orlando", "Jacksonville",
			"Washington DC", "Arlington", "Alexandria", "McLean", "Reston", "Herndon",
			"Raleigh", "Durham", "Chapel Hill", "Charlotte", "Philadelphia", "Pittsburgh",
			"Phoenix", "Scottsdale", "Tempe", "Portland", "Beaverton", "Hillsboro",
			"Nashville", "Salt Lake City", "Lehi", "Provo", "Minneapolis", "Saint Paul",
			"Detroit", "Ann Arbor", "Madison", "Milwaukee", "Columbus", "Cleveland",
			"Cincinnati", "Indianapolis", "Kansas City", "St. Louis", "Omaha", "Des Moines",
			"Las Vegas", "Reno", "Sacramento", "Fresno", "Santa Barbara", "Bentonville",
			"Little Rock", "Boise", "Birmingham", "Huntsville", "Mobile", "Anchorage",
			"Tucson", "Mesa", "Flagstaff", "Fayetteville", "New Orleans", "Baton Rouge",
			"Charleston", "Greenville", "Savannah", "Louisville", "Lexington", "Memphis",
			"Knoxville", "Richmond", "Norfolk", "Virginia Beach", "Baltimore", "Annapolis",
			"Providence", "Hartford", "New Haven", "Wilmington", "Manchester", "Burlington Vermont",
			"Portland Maine", "Honolulu", "Spokane", "Bozeman", "Missoula", "Fargo",
			"Sioux Falls", "Tulsa", "Oklahoma City", "Albuquerque", "Santa Fe",
		),
	},
	"canada": {
		ID:           "canada",
		Aliases:      terms("ca"),
		CountryTerms: terms("Canada"),
		RemoteTerms:  terms("Remote Canada", "Remote CA", "Canada Remote", "Canadian Remote"),
		RegionTerms: terms(
			"Ontario", "Quebec", "British Columbia", "Alberta", "Manitoba", "Saskatchewan",
			"Nova Scotia", "New Brunswick", "Newfoundland and Labrador", "Prince Edward Island",
			"Yukon", "Northwest Territories", "Nunavut",
		),
		CityTerms: terms(
			"Toronto", "Vancouver", "Montreal", "Ottawa", "Calgary", "Edmonton", "Waterloo",
			"Kitchener", "Quebec City", "Halifax", "Winnipeg", "Victoria", "Mississauga",
			"Brampton", "Hamilton", "London Ontario", "Markham", "Burnaby", "Surrey",
		),
	},
	"mexico": {
		ID:           "mexico",
		Aliases:      terms("mx"),
		CountryTerms: terms("Mexico"),
		RemoteTerms:  terms("Remote Mexico", "Remote MX", "Mexico Remote"),
		RegionTerms:  terms("Jalisco", "Nuevo Leon", "Queretaro", "Puebla", "Yucatan"),
		CityTerms:    terms("Mexico City", "Ciudad de Mexico", "CDMX", "Guadalajara", "Monterrey", "Queretaro", "Puebla", "Merida", "Tijuana"),
	},
	"uk": {
		ID:           "uk",
		Aliases:      terms("united-kingdom", "united kingdom", "gb", "great-britain", "britain", "england"),
		CountryTerms: terms("United Kingdom", "UK", "Great Britain", "Britain", "England", "Scotland", "Wales", "Northern Ireland"),
		RemoteTerms:  terms("Remote UK", "Remote United Kingdom", "UK Remote", "United Kingdom Remote"),
		RegionTerms:  terms("Greater London", "South East England", "North West England", "West Midlands", "East Midlands", "Yorkshire", "Scotland", "Wales"),
		CityTerms: terms(
			"London", "Manchester", "Cambridge", "Oxford", "Bristol", "Edinburgh", "Glasgow",
			"Birmingham", "Leeds", "Liverpool", "Newcastle", "Nottingham", "Sheffield",
			"Reading", "Brighton", "Cardiff", "Belfast", "Bath", "Southampton",
		),
	},
	"ireland": {
		ID:           "ireland",
		Aliases:      terms("ie", "eire", "republic-of-ireland"),
		CountryTerms: terms("Ireland", "Republic of Ireland", "Eire"),
		RemoteTerms:  terms("Remote Ireland", "Remote IE", "Ireland Remote", "Irish Remote"),
		RegionTerms: terms(
			"Dublin", "Cork", "Galway", "Limerick", "Waterford", "Kildare", "Meath", "Wicklow",
			"Louth", "Clare", "Kerry", "Mayo", "Donegal", "Sligo", "Roscommon", "Leitrim",
			"Cavan", "Monaghan", "Kilkenny", "Carlow", "Wexford", "Laois", "Offaly",
			"Westmeath", "Longford", "Tipperary",
		),
		CityTerms: terms(
			"Dublin", "Cork", "Galway", "Limerick", "Waterford", "Kilkenny", "Sligo",
			"Drogheda", "Dundalk", "Bray", "Navan", "Ennis", "Tralee", "Killarney",
			"Athlone", "Letterkenny", "Maynooth", "Naas", "Newbridge", "Wexford", "Carlow",
		),
	},
	"netherlands": {
		ID:           "netherlands",
		Aliases:      terms("nl", "holland", "the-netherlands"),
		CountryTerms: terms("Netherlands", "The Netherlands", "Nederland", "Holland"),
		RemoteTerms:  terms("Remote Netherlands", "Remote NL", "Netherlands Remote", "Nederland Remote"),
		RegionTerms: terms(
			"Randstad", "North Holland", "Noord-Holland", "South Holland", "Zuid-Holland",
			"Utrecht Province", "North Brabant", "Noord-Brabant", "Gelderland", "Limburg",
			"Overijssel", "Friesland", "Groningen", "Drenthe", "Flevoland", "Zeeland",
		),
		CityTerms: terms(
			"Amsterdam", "Rotterdam", "Utrecht", "Eindhoven", "The Hague", "Den Haag",
			"Delft", "Leiden", "Haarlem", "Groningen", "Arnhem", "Nijmegen", "Tilburg",
			"Breda", "Den Bosch", "s-Hertogenbosch", "Maastricht", "Enschede", "Amersfoort",
			"Almere", "Zwolle", "Apeldoorn", "Leeuwarden", "Venlo", "Hilversum",
			"Hoofddorp", "Zaandam", "Amstelveen", "Schiphol", "Wageningen",
		),
	},
	"germany": {
		ID:           "germany",
		Aliases:      terms("de", "deutschland"),
		CountryTerms: terms("Germany", "Deutschland"),
		RemoteTerms:  terms("Remote Germany", "Remote DE", "Germany Remote", "Deutschland Remote"),
		RegionTerms: terms(
			"Baden-Wurttemberg", "Bavaria", "Bayern", "Berlin", "Brandenburg", "Bremen",
			"Hamburg", "Hesse", "Hessen", "Lower Saxony", "Niedersachsen", "Saxony",
			"Sachsen", "North Rhine-Westphalia", "Nordrhein-Westfalen",
		),
		CityTerms: terms("Berlin", "Munich", "Muenchen", "Hamburg", "Frankfurt", "Cologne", "Koeln", "Stuttgart", "Dusseldorf", "Leipzig", "Dresden", "Bonn", "Dortmund", "Essen", "Karlsruhe", "Nuremberg", "Nuernberg", "Heidelberg", "Aachen"),
	},
	"france": {
		ID:           "france",
		Aliases:      terms("fr"),
		CountryTerms: terms("France"),
		RemoteTerms:  terms("Remote France", "Remote FR", "France Remote"),
		RegionTerms:  terms("Ile-de-France", "Auvergne-Rhone-Alpes", "Provence-Alpes-Cote d'Azur", "Occitanie", "Nouvelle-Aquitaine"),
		CityTerms:    terms("Paris", "Lyon", "Marseille", "Toulouse", "Bordeaux", "Lille", "Nantes", "Sophia Antipolis", "Nice", "Grenoble", "Rennes", "Strasbourg", "Montpellier"),
	},
	"spain": {
		ID:           "spain",
		Aliases:      terms("es"),
		CountryTerms: terms("Spain", "Espana"),
		RemoteTerms:  terms("Remote Spain", "Remote ES", "Spain Remote"),
		RegionTerms:  terms("Catalonia", "Catalunya", "Madrid", "Andalusia", "Basque Country", "Valencian Community"),
		CityTerms:    terms("Madrid", "Barcelona", "Valencia", "Malaga", "Seville", "Sevilla", "Bilbao", "Zaragoza", "Alicante", "Granada"),
	},
	"portugal": {
		ID:           "portugal",
		Aliases:      terms("pt"),
		CountryTerms: terms("Portugal"),
		RemoteTerms:  terms("Remote Portugal", "Remote PT", "Portugal Remote"),
		CityTerms:    terms("Lisbon", "Lisboa", "Porto", "Braga", "Coimbra", "Aveiro", "Faro"),
	},
	"italy": {
		ID:           "italy",
		Aliases:      terms("it", "italia"),
		CountryTerms: terms("Italy", "Italia"),
		RemoteTerms:  terms("Remote Italy", "Remote IT", "Italy Remote", "Italia Remote"),
		CityTerms:    terms("Milan", "Milano", "Rome", "Roma", "Turin", "Torino", "Bologna", "Florence", "Firenze", "Naples", "Napoli", "Padua", "Verona"),
	},
	"switzerland": {
		ID:           "switzerland",
		Aliases:      terms("ch", "suisse", "schweiz"),
		CountryTerms: terms("Switzerland", "Suisse", "Schweiz"),
		RemoteTerms:  terms("Remote Switzerland", "Remote CH", "Switzerland Remote", "Swiss Remote"),
		CityTerms:    terms("Zurich", "Geneva", "Lausanne", "Basel", "Bern", "Zug", "Lugano", "Winterthur"),
	},
	"austria": {
		ID:           "austria",
		Aliases:      terms("at"),
		CountryTerms: terms("Austria"),
		RemoteTerms:  terms("Remote Austria", "Remote AT", "Austria Remote"),
		CityTerms:    terms("Vienna", "Wien", "Graz", "Linz", "Salzburg", "Innsbruck"),
	},
	"belgium": {
		ID:           "belgium",
		Aliases:      terms("be"),
		CountryTerms: terms("Belgium", "Belgique", "Belgie"),
		RemoteTerms:  terms("Remote Belgium", "Remote BE", "Belgium Remote"),
		CityTerms:    terms("Brussels", "Bruxelles", "Brussel", "Antwerp", "Antwerpen", "Ghent", "Gent", "Leuven", "Liege", "Mechelen"),
	},
	"luxembourg": {
		ID:           "luxembourg",
		Aliases:      terms("lu"),
		CountryTerms: terms("Luxembourg"),
		RemoteTerms:  terms("Remote Luxembourg", "Remote LU", "Luxembourg Remote"),
		CityTerms:    terms("Luxembourg City", "Esch-sur-Alzette"),
	},
	"sweden": {
		ID:           "sweden",
		Aliases:      terms("se", "sverige"),
		CountryTerms: terms("Sweden", "Sverige"),
		RemoteTerms:  terms("Remote Sweden", "Remote SE", "Sweden Remote"),
		CityTerms:    terms("Stockholm", "Gothenburg", "Goteborg", "Malmo", "Uppsala", "Lund", "Linkoping", "Umea"),
	},
	"denmark": {
		ID:           "denmark",
		Aliases:      terms("dk", "danmark"),
		CountryTerms: terms("Denmark", "Danmark"),
		RemoteTerms:  terms("Remote Denmark", "Remote DK", "Denmark Remote"),
		CityTerms:    terms("Copenhagen", "Kobenhavn", "Aarhus", "Odense", "Aalborg"),
	},
	"norway": {
		ID:           "norway",
		Aliases:      terms("no", "norge"),
		CountryTerms: terms("Norway", "Norge"),
		RemoteTerms:  terms("Remote Norway", "Remote NO", "Norway Remote"),
		CityTerms:    terms("Oslo", "Bergen", "Trondheim", "Stavanger", "Tromso"),
	},
	"finland": {
		ID:           "finland",
		Aliases:      terms("fi", "suomi"),
		CountryTerms: terms("Finland", "Suomi"),
		RemoteTerms:  terms("Remote Finland", "Remote FI", "Finland Remote"),
		CityTerms:    terms("Helsinki", "Espoo", "Tampere", "Turku", "Oulu", "Vantaa"),
	},
	"poland": {
		ID:           "poland",
		Aliases:      terms("pl", "polska"),
		CountryTerms: terms("Poland", "Polska"),
		RemoteTerms:  terms("Remote Poland", "Remote PL", "Poland Remote"),
		CityTerms:    terms("Warsaw", "Warszawa", "Krakow", "Wroclaw", "Gdansk", "Poznan", "Lodz", "Katowice"),
	},
	"czechia": {
		ID:           "czechia",
		Aliases:      terms("cz", "czech-republic", "czech republic"),
		CountryTerms: terms("Czechia", "Czech Republic"),
		RemoteTerms:  terms("Remote Czechia", "Remote CZ", "Czechia Remote"),
		CityTerms:    terms("Prague", "Praha", "Brno", "Ostrava"),
	},
	"romania": {
		ID:           "romania",
		Aliases:      terms("ro"),
		CountryTerms: terms("Romania"),
		RemoteTerms:  terms("Remote Romania", "Remote RO", "Romania Remote"),
		CityTerms:    terms("Bucharest", "Bucuresti", "Cluj", "Cluj-Napoca", "Iasi", "Timisoara", "Brasov"),
	},
	"hungary": {
		ID:           "hungary",
		Aliases:      terms("hu"),
		CountryTerms: terms("Hungary"),
		RemoteTerms:  terms("Remote Hungary", "Remote HU", "Hungary Remote"),
		CityTerms:    terms("Budapest", "Debrecen", "Szeged"),
	},
	"estonia": {
		ID:           "estonia",
		Aliases:      terms("ee", "eesti"),
		CountryTerms: terms("Estonia", "Eesti"),
		RemoteTerms:  terms("Remote Estonia", "Remote EE", "Estonia Remote"),
		CityTerms:    terms("Tallinn", "Tartu"),
	},
	"latvia": {
		ID:           "latvia",
		Aliases:      terms("lv"),
		CountryTerms: terms("Latvia"),
		RemoteTerms:  terms("Remote Latvia", "Remote LV", "Latvia Remote"),
		CityTerms:    terms("Riga"),
	},
	"lithuania": {
		ID:           "lithuania",
		Aliases:      terms("lt"),
		CountryTerms: terms("Lithuania"),
		RemoteTerms:  terms("Remote Lithuania", "Remote LT", "Lithuania Remote"),
		CityTerms:    terms("Vilnius", "Kaunas"),
	},
	"bulgaria": {
		ID:           "bulgaria",
		Aliases:      terms("bg"),
		CountryTerms: terms("Bulgaria"),
		RemoteTerms:  terms("Remote Bulgaria", "Remote BG", "Bulgaria Remote"),
		CityTerms:    terms("Sofia", "Plovdiv", "Varna"),
	},
	"greece": {
		ID:           "greece",
		Aliases:      terms("gr"),
		CountryTerms: terms("Greece"),
		RemoteTerms:  terms("Remote Greece", "Remote GR", "Greece Remote"),
		CityTerms:    terms("Athens", "Thessaloniki"),
	},
	"croatia": {
		ID:           "croatia",
		Aliases:      terms("hr"),
		CountryTerms: terms("Croatia"),
		RemoteTerms:  terms("Remote Croatia", "Remote HR", "Croatia Remote"),
		CityTerms:    terms("Zagreb", "Split", "Rijeka"),
	},
	"slovakia": {
		ID:           "slovakia",
		Aliases:      terms("sk"),
		CountryTerms: terms("Slovakia"),
		RemoteTerms:  terms("Remote Slovakia", "Remote SK", "Slovakia Remote"),
		CityTerms:    terms("Bratislava", "Kosice"),
	},
	"slovenia": {
		ID:           "slovenia",
		Aliases:      terms("si"),
		CountryTerms: terms("Slovenia"),
		RemoteTerms:  terms("Remote Slovenia", "Remote SI", "Slovenia Remote"),
		CityTerms:    terms("Ljubljana", "Maribor"),
	},
	"india": {
		ID:           "india",
		Aliases:      terms("in", "bharat"),
		CountryTerms: terms("India", "Bharat"),
		RemoteTerms:  terms("Remote India", "Remote IN", "India Remote"),
		RegionTerms:  terms("Karnataka", "Telangana", "Maharashtra", "Tamil Nadu", "Delhi NCR", "NCR", "Uttar Pradesh", "Gujarat", "Rajasthan", "Kerala"),
		CityTerms:    terms("Bengaluru", "Bangalore", "Hyderabad", "Pune", "Mumbai", "Delhi", "New Delhi", "Gurgaon", "Gurugram", "Noida", "Chennai", "Kolkata", "Ahmedabad", "Jaipur", "Kochi", "Thiruvananthapuram", "Coimbatore", "Indore"),
	},
	"singapore": {
		ID:           "singapore",
		Aliases:      terms("sg"),
		CountryTerms: terms("Singapore"),
		RemoteTerms:  terms("Remote Singapore", "Remote SG", "Singapore Remote"),
		CityTerms:    terms("Singapore"),
	},
	"australia": {
		ID:           "australia",
		Aliases:      terms("au"),
		CountryTerms: terms("Australia"),
		RemoteTerms:  terms("Remote Australia", "Remote AU", "Australia Remote"),
		RegionTerms:  terms("New South Wales", "Victoria", "Queensland", "Western Australia", "South Australia", "ACT", "Tasmania"),
		CityTerms:    terms("Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Canberra", "Gold Coast", "Hobart", "Darwin"),
	},
	"new-zealand": {
		ID:           "new-zealand",
		Aliases:      terms("nz", "new zealand"),
		CountryTerms: terms("New Zealand", "Aotearoa"),
		RemoteTerms:  terms("Remote New Zealand", "Remote NZ", "New Zealand Remote"),
		CityTerms:    terms("Auckland", "Wellington", "Christchurch", "Hamilton", "Dunedin"),
	},
	"japan": {
		ID:           "japan",
		Aliases:      terms("jp"),
		CountryTerms: terms("Japan"),
		RemoteTerms:  terms("Remote Japan", "Remote JP", "Japan Remote"),
		CityTerms:    terms("Tokyo", "Osaka", "Kyoto", "Yokohama", "Fukuoka", "Nagoya", "Sapporo"),
	},
	"south-korea": {
		ID:           "south-korea",
		Aliases:      terms("kr", "korea", "south korea"),
		CountryTerms: terms("South Korea", "Korea"),
		RemoteTerms:  terms("Remote Korea", "Remote South Korea", "Remote KR", "Korea Remote"),
		CityTerms:    terms("Seoul", "Busan", "Incheon", "Pangyo", "Daejeon"),
	},
	"china": {
		ID:           "china",
		Aliases:      terms("cn", "mainland-china"),
		CountryTerms: terms("China", "Mainland China"),
		RemoteTerms:  terms("Remote China", "Remote CN", "China Remote"),
		CityTerms:    terms("Beijing", "Shanghai", "Shenzhen", "Guangzhou", "Hangzhou", "Chengdu", "Wuhan", "Nanjing"),
	},
	"hong-kong": {
		ID:           "hong-kong",
		Aliases:      terms("hk", "hong kong"),
		CountryTerms: terms("Hong Kong", "HK"),
		RemoteTerms:  terms("Remote Hong Kong", "Remote HK", "Hong Kong Remote"),
		CityTerms:    terms("Hong Kong"),
	},
	"taiwan": {
		ID:           "taiwan",
		Aliases:      terms("tw"),
		CountryTerms: terms("Taiwan"),
		RemoteTerms:  terms("Remote Taiwan", "Remote TW", "Taiwan Remote"),
		CityTerms:    terms("Taipei", "Hsinchu", "Taichung", "Kaohsiung", "Tainan"),
	},
	"malaysia": {
		ID:           "malaysia",
		Aliases:      terms("my"),
		CountryTerms: terms("Malaysia"),
		RemoteTerms:  terms("Remote Malaysia", "Remote MY", "Malaysia Remote"),
		CityTerms:    terms("Kuala Lumpur", "Penang", "Cyberjaya", "Johor Bahru"),
	},
	"indonesia": {
		ID:           "indonesia",
		Aliases:      terms("id"),
		CountryTerms: terms("Indonesia"),
		RemoteTerms:  terms("Remote Indonesia", "Remote ID", "Indonesia Remote"),
		CityTerms:    terms("Jakarta", "Bandung", "Bali", "Surabaya"),
	},
	"philippines": {
		ID:           "philippines",
		Aliases:      terms("ph"),
		CountryTerms: terms("Philippines"),
		RemoteTerms:  terms("Remote Philippines", "Remote PH", "Philippines Remote"),
		CityTerms:    terms("Manila", "Makati", "Taguig", "Cebu", "Quezon City"),
	},
	"thailand": {
		ID:           "thailand",
		Aliases:      terms("th"),
		CountryTerms: terms("Thailand"),
		RemoteTerms:  terms("Remote Thailand", "Remote TH", "Thailand Remote"),
		CityTerms:    terms("Bangkok", "Chiang Mai"),
	},
	"vietnam": {
		ID:           "vietnam",
		Aliases:      terms("vn"),
		CountryTerms: terms("Vietnam", "Viet Nam"),
		RemoteTerms:  terms("Remote Vietnam", "Remote VN", "Vietnam Remote"),
		CityTerms:    terms("Ho Chi Minh City", "Saigon", "Hanoi", "Da Nang"),
	},
	"israel": {
		ID:           "israel",
		Aliases:      terms("il"),
		CountryTerms: terms("Israel"),
		RemoteTerms:  terms("Remote Israel", "Remote IL", "Israel Remote"),
		CityTerms:    terms("Tel Aviv", "Tel-Aviv", "Jerusalem", "Haifa", "Herzliya", "Ramat Gan"),
	},
	"uae": {
		ID:           "uae",
		Aliases:      terms("united-arab-emirates", "united arab emirates", "ae"),
		CountryTerms: terms("United Arab Emirates", "UAE"),
		RemoteTerms:  terms("Remote UAE", "Remote United Arab Emirates", "UAE Remote"),
		CityTerms:    terms("Dubai", "Abu Dhabi", "Sharjah"),
	},
	"saudi-arabia": {
		ID:           "saudi-arabia",
		Aliases:      terms("saudi", "sa", "ksa"),
		CountryTerms: terms("Saudi Arabia", "KSA"),
		RemoteTerms:  terms("Remote Saudi Arabia", "Remote KSA", "Saudi Arabia Remote"),
		CityTerms:    terms("Riyadh", "Jeddah", "Dammam"),
	},
	"south-africa": {
		ID:           "south-africa",
		Aliases:      terms("za", "south africa"),
		CountryTerms: terms("South Africa"),
		RemoteTerms:  terms("Remote South Africa", "Remote ZA", "South Africa Remote"),
		CityTerms:    terms("Cape Town", "Johannesburg", "Pretoria", "Durban", "Stellenbosch"),
	},
	"brazil": {
		ID:           "brazil",
		Aliases:      terms("br", "brasil"),
		CountryTerms: terms("Brazil", "Brasil"),
		RemoteTerms:  terms("Remote Brazil", "Remote BR", "Brazil Remote", "Brasil Remote"),
		CityTerms:    terms("Sao Paulo", "Rio de Janeiro", "Belo Horizonte", "Florianopolis", "Curitiba", "Porto Alegre", "Brasilia", "Recife"),
	},
	"argentina": {
		ID:           "argentina",
		Aliases:      terms("ar"),
		CountryTerms: terms("Argentina"),
		RemoteTerms:  terms("Remote Argentina", "Remote AR", "Argentina Remote"),
		CityTerms:    terms("Buenos Aires", "Cordoba", "Mendoza", "Rosario"),
	},
	"chile": {
		ID:           "chile",
		Aliases:      terms("cl"),
		CountryTerms: terms("Chile"),
		RemoteTerms:  terms("Remote Chile", "Remote CL", "Chile Remote"),
		CityTerms:    terms("Santiago", "Valparaiso"),
	},
	"colombia": {
		ID:           "colombia",
		Aliases:      terms("co"),
		CountryTerms: terms("Colombia"),
		RemoteTerms:  terms("Remote Colombia", "Remote CO", "Colombia Remote"),
		CityTerms:    terms("Bogota", "Medellin", "Cali"),
	},
	"uruguay": {
		ID:           "uruguay",
		Aliases:      terms("uy"),
		CountryTerms: terms("Uruguay"),
		RemoteTerms:  terms("Remote Uruguay", "Remote UY", "Uruguay Remote"),
		CityTerms:    terms("Montevideo", "Punta del Este"),
	},
	"costa-rica": {
		ID:           "costa-rica",
		Aliases:      terms("cr", "costa rica"),
		CountryTerms: terms("Costa Rica"),
		RemoteTerms:  terms("Remote Costa Rica", "Remote CR", "Costa Rica Remote"),
		CityTerms:    terms("San Jose Costa Rica", "San Jose"),
	},
	"remote-global": {
		ID:           "remote-global",
		Aliases:      terms("global-remote", "worldwide", "anywhere"),
		CountryTerms: nil,
		RemoteTerms:  terms("Remote", "Worldwide", "Global", "Anywhere", "Work from anywhere", "Distributed"),
	},
	"north-america": {
		ID:        "north-america",
		Aliases:   terms("north america", "na"),
		ExpandsTo: terms("usa", "canada", "mexico"),
	},
	"europe": {
		ID: "europe",
		ExpandsTo: terms(
			"uk", "ireland", "netherlands", "germany", "france", "spain", "portugal", "italy",
			"switzerland", "austria", "belgium", "luxembourg", "sweden", "denmark", "norway",
			"finland", "poland", "czechia", "romania", "hungary", "estonia", "latvia",
			"lithuania", "bulgaria", "greece", "croatia", "slovakia", "slovenia",
		),
	},
	"eu": {
		ID: "eu",
		ExpandsTo: terms(
			"ireland", "netherlands", "germany", "france", "spain", "portugal", "italy",
			"austria", "belgium", "luxembourg", "sweden", "denmark", "finland", "poland",
			"czechia", "romania", "hungary", "estonia", "latvia", "lithuania", "bulgaria",
			"greece", "croatia", "slovakia", "slovenia",
		),
	},
	"nordics": {
		ID:        "nordics",
		ExpandsTo: terms("sweden", "denmark", "norway", "finland"),
	},
	"baltics": {
		ID:        "baltics",
		ExpandsTo: terms("estonia", "latvia", "lithuania"),
	},
	"apac": {
		ID: "apac",
		ExpandsTo: terms(
			"india", "singapore", "australia", "new-zealand", "japan", "south-korea",
			"china", "hong-kong", "taiwan", "malaysia", "indonesia", "philippines",
			"thailand", "vietnam",
		),
	},
	"latam": {
		ID:        "latam",
		Aliases:   terms("latin-america", "latin america"),
		ExpandsTo: terms("mexico", "brazil", "argentina", "chile", "colombia", "uruguay", "costa-rica"),
	},
	"emea": {
		ID:        "emea",
		ExpandsTo: terms("europe", "israel", "uae", "saudi-arabia", "south-africa"),
	},
}

var aliasIndex = buildAliasIndex()
