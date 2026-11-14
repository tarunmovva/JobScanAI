param(
    [string]$JobscanPath = ".\jobscan.exe",
    [string]$ReportRoot = ".\reports"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $JobscanPath)) {
    throw "jobscan executable not found: $JobscanPath"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ReportDir = Join-Path $ReportRoot "query-validation-$timestamp"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$script:Results = New-Object System.Collections.Generic.List[object]
$script:Counts = @{}

$SdeTitleQuery = "(SDE OR 'software engineer' OR 'software development engineer' OR 'backend engineer' OR 'platform engineer' OR 'full stack engineer')"
$EarlyMidSdeTitleQuery = "$SdeTitleQuery AND NOT (senior OR staff OR principal OR manager OR director OR lead)"
$TechKeyQuery = "(backend OR platform OR infrastructure OR distributed OR Go OR Python OR Java OR Kubernetes OR Kafka OR PostgreSQL)"
$ExcludeKeyQuery = "('security clearance' OR firmware OR embedded OR 'frontend only')"
$ExcludeTitlePhrase = "Senior Software Engineer,Staff Software Engineer,Principal Software Engineer,Engineering Manager,Director"

function ConvertTo-SafeName {
    param([string]$Name)
    return ($Name -replace "[^A-Za-z0-9_.-]", "_")
}

function Add-Result {
    param(
        [string]$Name,
        [string]$Status,
        [string[]]$CommandArgs,
        [int]$ExitCode,
        [double]$Seconds,
        [string]$Message,
        [string]$OutputPath = ""
    )

    $script:Results.Add([pscustomobject]@{
        name = $Name
        status = $Status
        exit_code = $ExitCode
        seconds = [math]::Round($Seconds, 3)
        args = $CommandArgs
        message = $Message
        output_path = $OutputPath
    })
}

function Invoke-JobscanCase {
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
        name = $Name
        args = $CommandArgs
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

function Assert-True {
    param(
        [object]$Condition,
        [string]$Message
    )
    if ($Condition -is [array]) {
        $ok = $Condition.Count -gt 0 -and -not ($Condition -contains $false)
    } else {
        $ok = [bool]$Condition
    }
    if (-not $ok) {
        throw $Message
    }
}

function Test-CountCase {
    param(
        [string]$Name,
        [string[]]$CommandArgs,
        [int]$MinJobs = 0,
        [Nullable[int]]$MaxJobs = $null,
        [string]$StoreAs = ""
    )

    try {
        $case = Invoke-JobscanCase -Name $Name -CommandArgs ($CommandArgs + @("--count"))
        $count = Get-CountFromText $case.text
        Assert-True ($count.jobs -ge $MinJobs) "$Name expected at least $MinJobs jobs, got $($count.jobs)"
        if ($null -ne $MaxJobs) {
            Assert-True ($count.jobs -le $MaxJobs.Value) "$Name expected at most $($MaxJobs.Value) jobs, got $($count.jobs)"
        }
        if ($StoreAs -ne "") {
            $script:Counts[$StoreAs] = $count.jobs
        }
        Add-Result -Name $Name -Status "pass" -CommandArgs ($CommandArgs + @("--count")) -ExitCode $case.exit_code -Seconds $case.seconds -Message "$($count.jobs) jobs across $($count.companies) companies" -OutputPath $case.output_path
    } catch {
        Add-Result -Name $Name -Status "fail" -CommandArgs ($CommandArgs + @("--count")) -ExitCode -1 -Seconds 0 -Message $_.Exception.Message
    }
}

function Test-CommandCase {
    param(
        [string]$Name,
        [string[]]$CommandArgs,
        [switch]$ExpectFailure
    )

    try {
        $case = Invoke-JobscanCase -Name $Name -CommandArgs $CommandArgs -ExpectFailure:$ExpectFailure
        Add-Result -Name $Name -Status "pass" -CommandArgs $CommandArgs -ExitCode $case.exit_code -Seconds $case.seconds -Message "ok" -OutputPath $case.output_path
    } catch {
        Add-Result -Name $Name -Status "fail" -CommandArgs $CommandArgs -ExitCode -1 -Seconds 0 -Message $_.Exception.Message
    }
}

function Test-JsonOutputCase {
    param(
        [string]$Name,
        [string[]]$CommandArgs,
        [int]$MinRows = 1,
        [int]$MaxRows = 25,
        [scriptblock]$ValidateRows = $null
    )

    $jsonPath = Join-Path $ReportDir "$((ConvertTo-SafeName $Name)).json"
    $fullArgs = $CommandArgs + @("--format", "json", "--output", $jsonPath)
    try {
        $case = Invoke-JobscanCase -Name $Name -CommandArgs $fullArgs
        Assert-True (Test-Path -LiteralPath $jsonPath) "$Name did not create JSON output file"
        $raw = Get-Content -LiteralPath $jsonPath -Raw
        $parsed = $raw | ConvertFrom-Json
        $rows = @()
        foreach ($item in $parsed) {
            $rows += $item
        }
        Assert-True ($rows.Count -ge $MinRows) "$Name expected at least $MinRows JSON rows, got $($rows.Count)"
        Assert-True ($rows.Count -le $MaxRows) "$Name expected at most $MaxRows JSON rows, got $($rows.Count)"
        foreach ($row in $rows) {
            Assert-True (-not [string]::IsNullOrWhiteSpace($row.title)) "$Name row has empty title"
            Assert-True (-not [string]::IsNullOrWhiteSpace($row.company)) "$Name row has empty company"
            Assert-True ($row.job_url -match "^https?://") "$Name row has invalid job_url: $($row.job_url)"
        }
        if ($null -ne $ValidateRows) {
            & $ValidateRows $rows
        }
        Add-Result -Name $Name -Status "pass" -CommandArgs $fullArgs -ExitCode $case.exit_code -Seconds $case.seconds -Message "$($rows.Count) JSON rows validated" -OutputPath $jsonPath
    } catch {
        Add-Result -Name $Name -Status "fail" -CommandArgs $fullArgs -ExitCode -1 -Seconds 0 -Message $_.Exception.Message -OutputPath $jsonPath
    }
}

function Test-CsvOutputCase {
    param(
        [string]$Name,
        [string[]]$CommandArgs,
        [int]$MinRows = 1,
        [int]$MaxRows = 25
    )

    $csvPath = Join-Path $ReportDir "$((ConvertTo-SafeName $Name)).csv"
    $fullArgs = $CommandArgs + @("--format", "csv", "--output", $csvPath)
    try {
        $case = Invoke-JobscanCase -Name $Name -CommandArgs $fullArgs
        Assert-True (Test-Path -LiteralPath $csvPath) "$Name did not create CSV output file"
        $rows = @(Import-Csv -LiteralPath $csvPath)
        Assert-True ($rows.Count -ge $MinRows) "$Name expected at least $MinRows CSV rows, got $($rows.Count)"
        Assert-True ($rows.Count -le $MaxRows) "$Name expected at most $MaxRows CSV rows, got $($rows.Count)"
        foreach ($row in $rows) {
            Assert-True (-not [string]::IsNullOrWhiteSpace($row.Title)) "$Name row has empty Title"
            Assert-True (-not [string]::IsNullOrWhiteSpace($row.Company)) "$Name row has empty Company"
            Assert-True ($row.JobURL -match "^https?://") "$Name row has invalid JobURL: $($row.JobURL)"
        }
        Add-Result -Name $Name -Status "pass" -CommandArgs $fullArgs -ExitCode $case.exit_code -Seconds $case.seconds -Message "$($rows.Count) CSV rows validated" -OutputPath $csvPath
    } catch {
        Add-Result -Name $Name -Status "fail" -CommandArgs $fullArgs -ExitCode -1 -Seconds 0 -Message $_.Exception.Message -OutputPath $csvPath
    }
}

# Count-oriented coverage.
Test-CountCase "title-positional-software-engineer" @("search", "software engineer") -MinJobs 100 -StoreAs "titleSoftwareEngineer"
Test-CountCase "desc-distributed-systems" @("search", "distributed systems", "--desc") -MinJobs 1 -StoreAs "descDistributedSystems"
Test-CountCase "boolean-sde-title-broad" @("search", "--title-query", $SdeTitleQuery) -MinJobs 100 -StoreAs "sdeBroad"
Test-CountCase "boolean-sde-title-early-mid" @("search", "--title-query", $EarlyMidSdeTitleQuery) -MinJobs 10 -StoreAs "sdeEarlyMid"
Test-CountCase "sde-with-tech-key-query" @("search", "--title-query", $EarlyMidSdeTitleQuery, "--key-query", $TechKeyQuery) -MinJobs 1 -StoreAs "sdeTech"
Test-CountCase "sde-with-exclusion-key-query" @("search", "--title-query", $EarlyMidSdeTitleQuery, "--key-query", $TechKeyQuery, "--exclude-key-query", $ExcludeKeyQuery) -MinJobs 1 -StoreAs "sdeTechExcluded"
Test-CountCase "sde-exclude-title-phrases" @("search", "--title-query", $SdeTitleQuery, "--exclude-title-phrase", $ExcludeTitlePhrase) -MinJobs 10 -StoreAs "sdeTitleExcluded"

# Platform filters.
Test-CountCase "sde-platform-greenhouse" @("search", "--title-query", $SdeTitleQuery, "--platform", "greenhouse") -MinJobs 1 -StoreAs "platformGreenhouse"
Test-CountCase "sde-platform-ashby" @("search", "--title-query", $SdeTitleQuery, "--platform", "ashby") -MinJobs 1 -StoreAs "platformAshby"
Test-CountCase "sde-platform-lever" @("search", "--title-query", $SdeTitleQuery, "--platform", "lever") -MinJobs 1 -StoreAs "platformLever"

# Company and source-dependent filters.
Test-CountCase "openai-ashby-sde" @("search", "--title-query", $SdeTitleQuery, "--platform", "ashby", "--company", "openai") -MinJobs 1 -StoreAs "openaiSde"
Test-CountCase "sde-department-engineering" @("search", "--title-query", $SdeTitleQuery, "--department", "engineering") -MinJobs 1 -StoreAs "departmentEngineering"
Test-CountCase "sde-type-full-time" @("search", "--title-query", $SdeTitleQuery, "--type", "full-time") -MinJobs 1 -StoreAs "typeFullTime"

# Market/location/workplace/date filters.
Test-CountCase "sde-market-usa" @("search", "--title-query", $SdeTitleQuery, "--market", "usa") -MinJobs 1 -StoreAs "marketUsa"
Test-CountCase "sde-market-europe" @("search", "--title-query", $SdeTitleQuery, "--market", "europe") -MinJobs 1 -StoreAs "marketEurope"
Test-CountCase "sde-market-remote-global" @("search", "--title-query", $SdeTitleQuery, "--market", "remote-global") -MinJobs 1 -StoreAs "marketRemoteGlobal"
Test-CountCase "sde-usa-remote" @("search", "--title-query", $SdeTitleQuery, "--market", "usa", "--remote") -MinJobs 1 -StoreAs "marketUsaRemote"
Test-CountCase "sde-location-ny-sf-seattle" @("search", "--title-query", $SdeTitleQuery, "--location", "New York,San Francisco,Seattle,Remote US") -MinJobs 1 -StoreAs "locationMajorUs"
Test-CountCase "sde-country-us" @("search", "--title-query", $SdeTitleQuery, "--country", "US") -MinJobs 1 -StoreAs "countryUs"
Test-CountCase "sde-hybrid-filter" @("search", "--title-query", $SdeTitleQuery, "--hybrid") -MinJobs 0 -StoreAs "hybrid"
Test-CountCase "sde-onsite-filter" @("search", "--title-query", $SdeTitleQuery, "--onsite") -MinJobs 0 -StoreAs "onsite"
Test-CountCase "sde-since-365d" @("search", "--title-query", $SdeTitleQuery, "--since", "365d") -MinJobs 0 -StoreAs "since365d"
Test-CountCase "sde-before-future-date" @("search", "--title-query", $SdeTitleQuery, "--before", "2027-01-01") -MinJobs 0 -StoreAs "beforeFuture"

# Output and sort/pagination coverage.
Test-JsonOutputCase "json-sde-usa-early-mid" @("search", "--title-query", $EarlyMidSdeTitleQuery, "--market", "usa", "--platform", "ashby,greenhouse,lever", "--exclude-title-phrase", $ExcludeTitlePhrase, "--sort", "relevance", "--limit", "25") -MinRows 1 -MaxRows 25 -ValidateRows {
    param($rows)
    $banned = "senior|staff|principal|manager|director"
    foreach ($row in $rows) {
        Assert-True ($row.platform -in @("ashby", "greenhouse", "lever")) "unexpected platform: $($row.platform)"
        Assert-True ($row.title -notmatch $banned) "banned senior/staff/manager title leaked: $($row.title)"
    }
}
Test-JsonOutputCase "json-openai-ashby-sde" @("search", "--title-query", $SdeTitleQuery, "--platform", "ashby", "--company", "openai", "--limit", "10", "--sort", "title") -MinRows 1 -MaxRows 10 -ValidateRows {
    param($rows)
    foreach ($row in $rows) {
        Assert-True ($row.platform -eq "ashby") "expected ashby platform, got $($row.platform)"
        Assert-True ($row.company -match "OpenAI|openai") "expected OpenAI company, got $($row.company)"
    }
}
Test-CsvOutputCase "csv-sde-tech-sample" @("search", "--title-query", $EarlyMidSdeTitleQuery, "--key-query", $TechKeyQuery, "--limit", "20", "--sort", "newest") -MinRows 1 -MaxRows 20
Test-CommandCase "table-sde-limit-offset" @("search", "--title-query", $SdeTitleQuery, "--limit", "5", "--offset", "5", "--sort", "company")
Test-CommandCase "table-sde-sort-oldest" @("search", "--title-query", $SdeTitleQuery, "--limit", "5", "--sort", "oldest")
Test-CommandCase "table-sde-sort-title" @("search", "--title-query", $SdeTitleQuery, "--limit", "5", "--sort", "title")
Test-JsonOutputCase "raw-fts-title-software-engineer" @("search", "--raw", 'title : "software engineer"', "--limit", "5") -MinRows 1 -MaxRows 5

# Expected validation failures.
Test-CommandCase "invalid-platform-fails" @("search", "--title-query", $SdeTitleQuery, "--platform", "notaplatform", "--count") -ExpectFailure
Test-CommandCase "invalid-sort-fails" @("search", "--title-query", $SdeTitleQuery, "--sort", "random", "--count") -ExpectFailure
Test-CommandCase "exclude-key-without-anchor-fails" @("search", "--exclude-key-query", "firmware", "--count") -ExpectFailure

# Relational expectations across counts.
try {
    Assert-True ($script:Counts["sdeEarlyMid"] -le $script:Counts["sdeBroad"]) "early/mid SDE count should not exceed broad SDE count"
    Assert-True ($script:Counts["sdeTechExcluded"] -le $script:Counts["sdeTech"]) "excluded tech count should not exceed unexcluded tech count"
    Assert-True ($script:Counts["sdeTitleExcluded"] -le $script:Counts["sdeBroad"]) "title-excluded count should not exceed broad SDE count"
    Assert-True ($script:Counts["marketUsaRemote"] -le $script:Counts["marketUsa"]) "USA remote count should not exceed USA market count"
    Assert-True (($script:Counts["platformGreenhouse"] + $script:Counts["platformAshby"] + $script:Counts["platformLever"]) -eq $script:Counts["sdeBroad"]) "platform counts should sum to broad SDE count"
    Add-Result -Name "relational-count-invariants" -Status "pass" -CommandArgs @() -ExitCode 0 -Seconds 0 -Message "count invariants passed"
} catch {
    Add-Result -Name "relational-count-invariants" -Status "fail" -CommandArgs @() -ExitCode -1 -Seconds 0 -Message $_.Exception.Message
}

$summaryPath = Join-Path $ReportDir "summary.json"
$mdPath = Join-Path $ReportDir "summary.md"
$script:Results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath

$passed = @($script:Results | Where-Object { $_.status -eq "pass" }).Count
$failed = @($script:Results | Where-Object { $_.status -ne "pass" }).Count
$duration = [math]::Round((($script:Results | Measure-Object seconds -Sum).Sum), 3)

$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Query validation summary")
$md.Add("")
$md.Add("- Passed: $passed")
$md.Add("- Failed: $failed")
$md.Add("- Command seconds: $duration")
$md.Add("- Report dir: $ReportDir")
$md.Add("")
$md.Add("## Results")
foreach ($result in $script:Results) {
    $md.Add("- [$($result.status)] $($result.name): $($result.message)")
}
Set-Content -LiteralPath $mdPath -Value $md

Write-Output "Report: $ReportDir"
Write-Output "Passed: $passed"
Write-Output "Failed: $failed"
Write-Output "Command seconds: $duration"

if ($failed -gt 0) {
    exit 1
}


