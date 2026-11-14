param(
    [string]$JobscanPath = ".\jobscan.exe",
    [string]$ReportRoot = ".\reports"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $JobscanPath)) {
    throw "jobscan executable not found: $JobscanPath"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ReportDir = Join-Path $ReportRoot "query-semantic-validation-$timestamp"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$script:CaseResults = New-Object System.Collections.Generic.List[object]
$script:Findings = New-Object System.Collections.Generic.List[object]

$SdeTitleQuery = "(SDE OR 'software engineer' OR 'software development engineer' OR 'backend engineer' OR 'platform engineer' OR 'full stack engineer')"
$SeniorityExcludeQuery = "(senior OR 'senior+' OR 'senior-staff' OR 'senior/staff' OR 'mid-senior' OR sr OR 'sr.' OR staff OR 'staff+' OR principal OR manager OR director OR lead)"
$CxxSeniorityExcludeQuery = "(senior OR 'senior+' OR 'senior-staff' OR 'senior/staff' OR 'mid-senior' OR sr OR 'sr.' OR staff OR 'staff+' OR principal OR manager)"
$EarlyMidSdeTitleQuery = "$SdeTitleQuery AND NOT $SeniorityExcludeQuery"
$TechKeyQuery = "(backend OR platform OR infrastructure OR distributed OR Go OR Python OR Java OR Kubernetes OR Kafka OR PostgreSQL)"
$ExcludeKeyQuery = "(clearance OR 'clearance.' OR 'security clearance' OR 'security clearance.' OR firmware OR 'firmware.' OR embedded OR 'embedded.' OR 'embedded-based' OR 'embedded-checkout' OR 'frontend only' OR 'frontend-only' OR 'front-end only' OR 'front-end-only')"
$DistributedExcludeKeyQuery = "('frontend only' OR 'frontend-only' OR 'front-end only' OR 'front-end-only' OR mobile OR 'mobile.' OR 'mobile-first' OR MobileSDK OR 't-mobile' OR tmobile OR android OR 'android.' OR ios OR 'ios.' OR embedded OR 'embedded.' OR 'embedded-based' OR firmware OR 'firmware.')"
$CxxExcludeKeyQuery = "(frontend OR 'frontend.' OR 'frontend-only' OR 'front-end' OR 'front-end.' OR 'front-end-only' OR react OR 'react.' OR 'react-based' OR 'electron+react' OR wordpress OR 'wordpress.' OR salesforce OR 'salesforce.' OR firmware OR 'firmware.' OR clearance OR 'clearance.' OR 'security clearance' OR 'security clearance.')"
$ExcludeTitlePhrase = "Senior Software Engineer,Staff Software Engineer,Staff+ Software Engineer,Principal Software Engineer,Engineering Manager,Director,Sr.,Staff+,Senior-Staff,Senior/Staff"

$RoleSdePatterns = @(
    "\bsde\b",
    "\bsoftware\s+engineer\b",
    "\bsoftware\s+development\s+engineer\b",
    "\bbackend\s+engineer\b",
    "\bback-end\s+engineer\b",
    "\bplatform\s+engineer\b",
    "\bfull\s*stack\s+engineer\b",
    "\bfull-stack\s+engineer\b"
)
$EarlyMidTitleBanned = @(
    "\bsenior\b",
    "\bsr\.?\b",
    "\bstaff\b",
    "\bprincipal\b",
    "\bmanager\b",
    "\bdirector\b",
    "\blead\b",
    "\bhead\b",
    "\bvp\b",
    "\bchief\b"
)
$StrongTechPatterns = @(
    "\bbackend\b",
    "\bback-end\b",
    "\bplatform\b",
    "\binfrastructure\b",
    "\bdistributed\b",
    "\bpython\b",
    "\bjava\b",
    "\bkubernetes\b",
    "\bkafka\b",
    "\bpostgres(?:ql)?\b",
    "\bgolang\b",
    "\bgo\b"
)
$ExcludeDescriptionPatterns = @(
    "\bsecurity\s+clearance\b",
    "\bactive\s+clearance\b",
    "\bfirmware\b",
    "\bembedded\b",
    "\bfrontend\s+only\b",
    "\bfront-end\s+only\b"
)
$UsMarketSignals = @(
    "\bunited\s+states\b",
    "\busa\b",
    "\bu\.s\.a?\b",
    "\bus\b",
    "\bremote\s+us\b",
    "\bremote\s+u\.s\.\b",
    "\bnorth\s+america\b",
    "\bamericas\b",
    "\bnew\s+york\b",
    "\bsan\s+francisco\b",
    "\bseattle\b",
    "\bboston\b",
    "\bcambridge\b",
    "\baustin\b",
    "\bchicago\b",
    "\blos\s+angeles\b",
    "\bdenver\b",
    "\batlanta\b",
    "\bwashington\b",
    "\bdc\b",
    "\bca\b",
    "\bwa\b",
    "\bny\b",
    "\bnj\b",
    "\btx\b",
    "\bma\b",
    "\bmd\b",
    "\bva\b",
    "\bco\b",
    "\bmo\b",
    "\bfl\b",
    "\billinois\b",
    "\bcalifornia\b",
    "\btexas\b",
    "\bmaryland\b",
    "\bvirginia\b",
    "\bcolorado\b",
    "\bmissouri\b",
    "\boklahoma\b",
    "\bpennsylvania\b"
)
$EuropeSignals = @(
    "\beurope\b",
    "\beu\b",
    "\bemea\b",
    "\bunited\s+kingdom\b",
    "\buk\b",
    "\bireland\b",
    "\bnetherlands\b",
    "\bgermany\b",
    "\bfrance\b",
    "\bspain\b",
    "\bsweden\b",
    "\bswitzerland\b",
    "\bpoland\b",
    "\bromania\b",
    "\bportugal\b"
)
$RemoteSignals = @(
    "\bremote\b",
    "\bdistributed\b"
)

function ConvertTo-SafeName {
    param([string]$Name)
    return ($Name -replace "[^A-Za-z0-9_.-]", "_")
}

function Invoke-Jobscan {
    param(
        [string]$Name,
        [string[]]$CommandArgs,
        [switch]$ExpectFailure
    )

    $safe = ConvertTo-SafeName $Name
    $outPath = Join-Path $ReportDir "$safe.out.txt"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = & $JobscanPath @CommandArgs 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }
    $sw.Stop()

    $text = ($lines | Out-String)
    Set-Content -LiteralPath $outPath -Value $text

    if ($ExpectFailure) {
        if ($exitCode -eq 0) {
            throw "expected failure but command exited 0"
        }
    } elseif ($exitCode -ne 0) {
        throw "command failed with exit $exitCode. Output: $text"
    }

    return [pscustomobject]@{
        exit_code = $exitCode
        seconds = $sw.Elapsed.TotalSeconds
        text = $text
        output_path = $outPath
    }
}

function Get-CountFromText {
    param([string]$Text)
    if ($Text -match "(\d+)\s+jobs\s+across\s+(\d+)\s+companies") {
        return [pscustomobject]@{
            jobs = [int]$Matches[1]
            companies = [int]$Matches[2]
        }
    }
    throw "could not parse count output: $Text"
}

function Test-AnyPattern {
    param(
        [string]$Text,
        [string[]]$Patterns
    )
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }
    foreach ($pattern in $Patterns) {
        if ($Text -match $pattern) {
            return $true
        }
    }
    return $false
}

function Get-MatchedPatterns {
    param(
        [string]$Text,
        [string[]]$Patterns
    )
    $found = @()
    foreach ($pattern in $Patterns) {
        if ($Text -match $pattern) {
            $found += $pattern
        }
    }
    return $found
}

function Add-Finding {
    param(
        [string]$Severity,
        [string]$Query,
        [int]$RowIndex,
        [object]$Row,
        [string]$Rule,
        [string]$Message
    )

    $script:Findings.Add([pscustomobject]@{
        severity = $Severity
        query = $Query
        row_index = $RowIndex
        rule = $Rule
        message = $Message
        company = [string]$Row.company
        title = [string]$Row.title
        platform = [string]$Row.platform
        location = [string]$Row.location
        country = [string]$Row.country
        workplace_type = [string]$Row.workplace_type
        job_url = [string]$Row.job_url
    })
}

function Test-RowSemantics {
    param(
        [string]$QueryName,
        [object]$Rule,
        [object[]]$Rows
    )

    $failuresBefore = @($script:Findings | Where-Object { $_.severity -eq "FAIL" }).Count
    $warningsBefore = @($script:Findings | Where-Object { $_.severity -eq "WARN" }).Count

    for ($i = 0; $i -lt $Rows.Count; $i++) {
        $row = $Rows[$i]
        $title = [string]$row.title
        $description = [string]$row.description
        $platform = [string]$row.platform
        $company = [string]$row.company
        $location = [string]$row.location
        $country = [string]$row.country
        $workplaceType = [string]$row.workplace_type
        $locationBlob = "$location $country $workplaceType"

        if ([string]::IsNullOrWhiteSpace($title)) {
            Add-Finding "FAIL" $QueryName ($i + 1) $row "required-title" "title is empty"
        }
        if ([string]::IsNullOrWhiteSpace($company)) {
            Add-Finding "FAIL" $QueryName ($i + 1) $row "required-company" "company is empty"
        }
        if ([string]::IsNullOrWhiteSpace([string]$row.job_url) -or -not ([string]$row.job_url -match "^https?://")) {
            Add-Finding "FAIL" $QueryName ($i + 1) $row "required-job-url" "job_url is missing or not http(s)"
        }

        if ($Rule.Platforms -and -not ($platform -in $Rule.Platforms)) {
            Add-Finding "FAIL" $QueryName ($i + 1) $row "platform" "expected one of $($Rule.Platforms -join ', '), got '$platform'"
        }
        if ($Rule.CompanyPattern -and -not ($company -match $Rule.CompanyPattern)) {
            Add-Finding "FAIL" $QueryName ($i + 1) $row "company" "company '$company' does not match $($Rule.CompanyPattern)"
        }
        if ($Rule.TitleAny -and -not (Test-AnyPattern $title $Rule.TitleAny)) {
            Add-Finding "FAIL" $QueryName ($i + 1) $row "title-any" "title does not match expected role terms"
        }
        if ($Rule.TitleAllGroups) {
            for ($g = 0; $g -lt $Rule.TitleAllGroups.Count; $g++) {
                if (-not (Test-AnyPattern $title $Rule.TitleAllGroups[$g])) {
                    Add-Finding "FAIL" $QueryName ($i + 1) $row "title-group-$($g + 1)" "title does not satisfy required title group $($g + 1)"
                }
            }
        }
        if ($Rule.TitleNone) {
            $badTitleMatches = Get-MatchedPatterns $title $Rule.TitleNone
            if ($badTitleMatches.Count -gt 0) {
                Add-Finding "FAIL" $QueryName ($i + 1) $row "title-none" "title contains excluded title pattern(s): $($badTitleMatches -join ', ')"
            }
        }
        if ($Rule.DescAny -and -not (Test-AnyPattern $description $Rule.DescAny)) {
            Add-Finding "FAIL" $QueryName ($i + 1) $row "description-any" "description does not contain any required keyword"
        }
        if ($Rule.DescAllGroups) {
            for ($g = 0; $g -lt $Rule.DescAllGroups.Count; $g++) {
                if (-not (Test-AnyPattern $description $Rule.DescAllGroups[$g])) {
                    Add-Finding "FAIL" $QueryName ($i + 1) $row "description-group-$($g + 1)" "description does not satisfy required keyword group $($g + 1)"
                }
            }
        }
        if ($Rule.DescNone) {
            $badDescMatches = Get-MatchedPatterns $description $Rule.DescNone
            if ($badDescMatches.Count -gt 0) {
                Add-Finding "FAIL" $QueryName ($i + 1) $row "description-none" "description contains excluded pattern(s): $($badDescMatches -join ', ')"
            }
        }
        if ($Rule.RemoteRequired) {
            if (-not (Test-AnyPattern $locationBlob $RemoteSignals)) {
                Add-Finding "FAIL" $QueryName ($i + 1) $row "remote-required" "remote filter result has no remote signal in workplace/location"
            }
        }
        if ($Rule.LocationWarnAny -and -not (Test-AnyPattern $locationBlob $Rule.LocationWarnAny)) {
            Add-Finding "WARN" $QueryName ($i + 1) $row "location-signal" "no obvious location/country signal found for this market; source metadata may be sparse"
        }
    }

    $failuresAfter = @($script:Findings | Where-Object { $_.severity -eq "FAIL" }).Count
    $warningsAfter = @($script:Findings | Where-Object { $_.severity -eq "WARN" }).Count
    return [pscustomobject]@{
        failures = $failuresAfter - $failuresBefore
        warnings = $warningsAfter - $warningsBefore
    }
}

function Read-JsonRows {
    param([string]$Path)
    $raw = Get-Content -LiteralPath $Path -Raw
    $parsed = $raw | ConvertFrom-Json
    $rows = @()
    foreach ($item in $parsed) {
        $rows += $item
    }
    return $rows
}

function Test-SemanticQuery {
    param([object]$Case)

    $safe = ConvertTo-SafeName $Case.Name
    $jsonPath = Join-Path $ReportDir "$safe.json"
    $countCommand = $Case.Args + @("--count")
    $jsonCommand = $Case.Args + @("--format", "json", "--output", $jsonPath)

    $caseStart = [Diagnostics.Stopwatch]::StartNew()
    try {
        $countRun = Invoke-Jobscan "$($Case.Name)-count" $countCommand
        $count = Get-CountFromText $countRun.text

        $jsonRun = Invoke-Jobscan "$($Case.Name)-json" $jsonCommand
        if (-not (Test-Path -LiteralPath $jsonPath)) {
            throw "JSON output was not created"
        }
        $rows = @(Read-JsonRows $jsonPath)

        if ($count.jobs -lt $Case.MinCount) {
            throw "expected at least $($Case.MinCount) total jobs, got $($count.jobs)"
        }
        if ($Case.Limit -eq 0) {
            if ($rows.Count -ne $count.jobs) {
                throw "limit 0 export row count $($rows.Count) did not equal count $($count.jobs)"
            }
        } else {
            $expectedRows = [Math]::Min($Case.Limit, $count.jobs)
            if ($rows.Count -ne $expectedRows) {
                throw "export row count $($rows.Count) did not equal expected $expectedRows"
            }
        }

        $semantic = Test-RowSemantics $Case.Name $Case.Rule $rows
        $caseStart.Stop()
        $status = if ($semantic.failures -eq 0) { "pass" } else { "fail" }
        $script:CaseResults.Add([pscustomobject]@{
            name = $Case.Name
            status = $status
            total_jobs = $count.jobs
            total_companies = $count.companies
            exported_rows = $rows.Count
            semantic_failures = $semantic.failures
            warnings = $semantic.warnings
            seconds = [math]::Round($caseStart.Elapsed.TotalSeconds, 3)
            json_path = $jsonPath
            args = $Case.Args
        })
    } catch {
        $caseStart.Stop()
        $script:CaseResults.Add([pscustomobject]@{
            name = $Case.Name
            status = "fail"
            total_jobs = 0
            total_companies = 0
            exported_rows = 0
            semantic_failures = 1
            warnings = 0
            seconds = [math]::Round($caseStart.Elapsed.TotalSeconds, 3)
            json_path = $jsonPath
            args = $Case.Args
            error = "$($_.Exception.Message)`n$($_.ScriptStackTrace)"
        })
    }
}

function Test-NegativeCase {
    param(
        [string]$Name,
        [string[]]$CommandArgs,
        [switch]$ExpectFailure,
        [switch]$ExpectZero
    )

    $caseStart = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($ExpectFailure) {
            $null = Invoke-Jobscan $Name $CommandArgs -ExpectFailure
            $caseStart.Stop()
            $script:CaseResults.Add([pscustomobject]@{
                name = $Name
                status = "pass"
                total_jobs = 0
                total_companies = 0
                exported_rows = 0
                semantic_failures = 0
                warnings = 0
                seconds = [math]::Round($caseStart.Elapsed.TotalSeconds, 3)
                args = $CommandArgs
            })
            return
        }

        $run = Invoke-Jobscan $Name ($CommandArgs + @("--count"))
        $count = Get-CountFromText $run.text
        if ($ExpectZero -and $count.jobs -ne 0) {
            throw "expected zero jobs, got $($count.jobs)"
        }
        $caseStart.Stop()
        $script:CaseResults.Add([pscustomobject]@{
            name = $Name
            status = "pass"
            total_jobs = $count.jobs
            total_companies = $count.companies
            exported_rows = 0
            semantic_failures = 0
            warnings = 0
            seconds = [math]::Round($caseStart.Elapsed.TotalSeconds, 3)
            args = $CommandArgs
        })
    } catch {
        $caseStart.Stop()
        $script:CaseResults.Add([pscustomobject]@{
            name = $Name
            status = "fail"
            total_jobs = 0
            total_companies = 0
            exported_rows = 0
            semantic_failures = 1
            warnings = 0
            seconds = [math]::Round($caseStart.Elapsed.TotalSeconds, 3)
            args = $CommandArgs
            error = "$($_.Exception.Message)`n$($_.ScriptStackTrace)"
        })
    }
}

$Cases = @(
    [pscustomobject]@{
        Name = "early-mid-sde-usa-tech-excluded"
        Limit = 500
        MinCount = 100
        Args = @("search", "--title-query", $EarlyMidSdeTitleQuery, "--key-query", $TechKeyQuery, "--exclude-key-query", $ExcludeKeyQuery, "--exclude-title-phrase", $ExcludeTitlePhrase, "--market", "usa", "--platform", "ashby,greenhouse,lever", "--sort", "relevance", "--limit", "500")
        Rule = [pscustomobject]@{
            TitleAny = $RoleSdePatterns
            TitleNone = $EarlyMidTitleBanned
            DescAny = $StrongTechPatterns
            DescNone = $ExcludeDescriptionPatterns
            Platforms = @("ashby", "greenhouse", "lever")
            LocationWarnAny = $UsMarketSignals
        }
    },
    [pscustomobject]@{
        Name = "remote-usa-or-global-sde"
        Limit = 500
        MinCount = 100
        Args = @("search", "--remote", "--market", "usa,remote-global", "--title-query", $EarlyMidSdeTitleQuery, "--key-query", $TechKeyQuery, "--exclude-key-query", $ExcludeKeyQuery, "--exclude-title-phrase", $ExcludeTitlePhrase, "--sort", "relevance", "--limit", "500")
        Rule = [pscustomobject]@{
            TitleAny = $RoleSdePatterns
            TitleNone = $EarlyMidTitleBanned
            DescAny = $StrongTechPatterns
            DescNone = $ExcludeDescriptionPatterns
            RemoteRequired = $true
            LocationWarnAny = $RemoteSignals
        }
    },
    [pscustomobject]@{
        Name = "openai-ashby-sde-all"
        Limit = 0
        MinCount = 50
        Args = @("search", "--title-query", $SdeTitleQuery, "--platform", "ashby", "--company", "openai", "--sort", "title", "--limit", "0")
        Rule = [pscustomobject]@{
            TitleAny = $RoleSdePatterns
            Platforms = @("ashby")
            CompanyPattern = "openai"
        }
    },
    [pscustomobject]@{
        Name = "greenhouse-sde-platform"
        Limit = 250
        MinCount = 100
        Args = @("search", "--title-query", $SdeTitleQuery, "--platform", "greenhouse", "--sort", "relevance", "--limit", "250")
        Rule = [pscustomobject]@{
            TitleAny = $RoleSdePatterns
            Platforms = @("greenhouse")
        }
    },
    [pscustomobject]@{
        Name = "ashby-sde-platform"
        Limit = 250
        MinCount = 100
        Args = @("search", "--title-query", $SdeTitleQuery, "--platform", "ashby", "--sort", "relevance", "--limit", "250")
        Rule = [pscustomobject]@{
            TitleAny = $RoleSdePatterns
            Platforms = @("ashby")
        }
    },
    [pscustomobject]@{
        Name = "lever-sde-platform"
        Limit = 250
        MinCount = 100
        Args = @("search", "--title-query", $SdeTitleQuery, "--platform", "lever", "--sort", "relevance", "--limit", "250")
        Rule = [pscustomobject]@{
            TitleAny = $RoleSdePatterns
            Platforms = @("lever")
        }
    },
    [pscustomobject]@{
        Name = "distributed-backend-sde"
        Limit = 500
        MinCount = 100
        Args = @("search", "software engineer", "--desc", "--key-query", "('distributed systems' OR Kafka OR 'event driven' OR Kubernetes OR Redis OR PostgreSQL OR gRPC OR protobuf) AND (backend OR platform OR infrastructure)", "--exclude-key-query", $DistributedExcludeKeyQuery, "--market", "north-america,europe", "--platform", "ashby,lever,greenhouse", "--sort", "relevance", "--limit", "500")
        Rule = [pscustomobject]@{
            DescAllGroups = @(
                ,@("\bdistributed\s+systems\b", "\bkafka\b", "\bevent\s+driven\b", "\bkubernetes\b", "\bredis\b", "\bpostgres(?:ql)?\b", "\bgrpc\b", "\bprotobuf\b")
                ,@("\bbackend\b", "\bback-end\b", "\bplatform\b", "\binfrastructure\b")
            )
            DescNone = @("\bfrontend\s+only\b", "\bfront-end\s+only\b", "\bmobile\b", "\bandroid\b", "\bios\b", "\bembedded\b", "\bfirmware\b")
            Platforms = @("ashby", "greenhouse", "lever")
        }
    },
    [pscustomobject]@{
        Name = "cpp-systems-platform-sde"
        Limit = 300
        MinCount = 10
        Args = @("search", "--title-query", "('c++ engineer' OR 'systems engineer' OR 'infrastructure engineer' OR 'performance engineer' OR 'platform engineer') AND NOT $CxxSeniorityExcludeQuery", "--key-query", "(C++ OR Rust OR Linux OR 'systems programming') AND (distributed OR infrastructure OR platform OR storage)", "--exclude-key-query", $CxxExcludeKeyQuery, "--market", "usa,canada,uk", "--sort", "relevance", "--limit", "300")
        Rule = [pscustomobject]@{
            TitleAny = @("\bc\+\+\s+engineer\b", "\bsystems\s+engineer\b", "\binfrastructure\s+engineer\b", "\bperformance\s+engineer\b", "\bplatform\s+engineer\b")
            TitleNone = @("\bsenior\b", "\bsr\.?\b", "\bstaff\b", "\bprincipal\b", "\bmanager\b")
            DescAllGroups = @(
                ,@("c\+\+", "(?<![A-Za-z0-9])rust(?![A-Za-z0-9])", "(?<![A-Za-z0-9])linux(?![A-Za-z0-9])", "\bsystems\s+programming\b")
                ,@("(?<![A-Za-z0-9])distributed(?![A-Za-z0-9])", "(?<![A-Za-z0-9])infrastructure(?![A-Za-z0-9])", "(?<![A-Za-z0-9])platform(?![A-Za-z0-9])", "(?<![A-Za-z0-9])storage(?![A-Za-z0-9])")
            )
            DescNone = @("\bfrontend\b", "\bfront-end\b", "\breact\b", "\bwordpress\b", "\bsalesforce\b", "\bfirmware\b", "\bclearance\b")
            LocationWarnAny = $UsMarketSignals + @("\bcanada\b", "\bunited\s+kingdom\b", "\buk\b")
        }
    }
)

foreach ($case in $Cases) {
    Test-SemanticQuery $case
}

Test-NegativeCase "negative-invalid-platform" @("search", "--title-query", $SdeTitleQuery, "--platform", "notaplatform") -ExpectFailure
Test-NegativeCase "negative-invalid-sort" @("search", "--title-query", $SdeTitleQuery, "--sort", "random") -ExpectFailure
Test-NegativeCase "negative-exclude-without-anchor" @("search", "--exclude-key-query", "firmware") -ExpectFailure
Test-NegativeCase "negative-openai-greenhouse-zero" @("search", "--title-query", $SdeTitleQuery, "--platform", "greenhouse", "--company", "openai") -ExpectZero

$summaryPath = Join-Path $ReportDir "summary.json"
$mdPath = Join-Path $ReportDir "summary.md"
$failuresPath = Join-Path $ReportDir "failures.csv"
$warningsPath = Join-Path $ReportDir "warnings.csv"

$script:CaseResults | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath
@($script:Findings | Where-Object { $_.severity -eq "FAIL" }) | Export-Csv -LiteralPath $failuresPath -NoTypeInformation
@($script:Findings | Where-Object { $_.severity -eq "WARN" }) | Export-Csv -LiteralPath $warningsPath -NoTypeInformation

$passed = @($script:CaseResults | Where-Object { $_.status -eq "pass" }).Count
$failed = @($script:CaseResults | Where-Object { $_.status -ne "pass" }).Count
$failures = @($script:Findings | Where-Object { $_.severity -eq "FAIL" }).Count
$warnings = @($script:Findings | Where-Object { $_.severity -eq "WARN" }).Count
$seconds = [math]::Round((($script:CaseResults | Measure-Object seconds -Sum).Sum), 3)

$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Query semantic validation summary")
$md.Add("")
$md.Add("- Passed cases: $passed")
$md.Add("- Failed cases: $failed")
$md.Add("- Row semantic failures: $failures")
$md.Add("- Row metadata warnings: $warnings")
$md.Add("- Command seconds: $seconds")
$md.Add("- Report dir: $ReportDir")
$md.Add("")
$md.Add("## Cases")
foreach ($caseResult in $script:CaseResults) {
    $line = "- [$($caseResult.status)] $($caseResult.name): total=$($caseResult.total_jobs), exported=$($caseResult.exported_rows), failures=$($caseResult.semantic_failures), warnings=$($caseResult.warnings), seconds=$($caseResult.seconds)"
    if ($caseResult.error) {
        $line += ", error=$($caseResult.error)"
    }
    $md.Add($line)
}
if ($failures -gt 0) {
    $md.Add("")
    $md.Add("## Failures")
    foreach ($finding in @($script:Findings | Where-Object { $_.severity -eq "FAIL" } | Select-Object -First 50)) {
        $md.Add("- $($finding.query) row $($finding.row_index) [$($finding.rule)]: $($finding.message) | $($finding.company) | $($finding.title) | $($finding.job_url)")
    }
}
if ($warnings -gt 0) {
    $md.Add("")
    $md.Add("## Warnings")
    foreach ($finding in @($script:Findings | Where-Object { $_.severity -eq "WARN" } | Select-Object -First 50)) {
        $md.Add("- $($finding.query) row $($finding.row_index) [$($finding.rule)]: $($finding.message) | $($finding.company) | $($finding.title) | $($finding.location) / $($finding.country)")
    }
}
Set-Content -LiteralPath $mdPath -Value $md

Write-Output "Report: $ReportDir"
Write-Output "Passed cases: $passed"
Write-Output "Failed cases: $failed"
Write-Output "Row semantic failures: $failures"
Write-Output "Row metadata warnings: $warnings"
Write-Output "Command seconds: $seconds"

if ($failed -gt 0 -or $failures -gt 0) {
    exit 1
}
