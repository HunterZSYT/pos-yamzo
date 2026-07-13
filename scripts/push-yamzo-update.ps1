[CmdletBinding()]
param(
  [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$secretPathPattern = '(^|/)(\.env($|\.)|yamzo_google_creds\.txt$|gmail-(token|credentials).*\.json$|google-(oauth-client|sheets-token)\.json$|client_secret.*\.json$|tokens/|[^/]*\.secret\.[^/]*$)'
$highConfidenceSecretPattern = '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|GOCSPX-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|ya29\.[A-Za-z0-9._-]{20,}|AKIA[0-9A-Z]{16}|"client_secret"\s*:\s*"(?!(?:REDACTED|YOUR_|<))[^"\r\n]{12,}"|"refresh_token"\s*:\s*"(?!(?:REDACTED|YOUR_|<))[^"\r\n]{12,}"'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Write-Host "`n== $Label ==" -ForegroundColor Cyan
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE. Nothing was pushed."
  }
}

function Show-Result {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Message,
    [ValidateSet("Information", "Error")][string]$Icon = "Information"
  )

  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $Title,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::$Icon
  ) | Out-Null
}

function Assert-NoSecretPaths {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Paths,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $secretPaths = @($Paths |
    ForEach-Object { $_ -replace '\\', '/' } |
    Where-Object { $_ -and $_ -ne ".env.example" -and $_ -match $secretPathPattern })
  if ($secretPaths.Count -gt 0) {
    throw "Credential-like file paths were found in $Context. Remove them from Git history before pushing:`n$($secretPaths -join "`n")"
  }
}

function Test-AddedPatchForSecret {
  param([string[]]$PatchLines)

  $addedText = @($PatchLines | Where-Object { $_ -match '^\+(?!\+\+\+)' }) -join "`n"
  return [bool]($addedText -and $addedText -match $highConfidenceSecretPattern)
}

function Assert-NoAheadCommitSecrets {
  param([Parameter(Mandatory = $true)][string]$BaseRef)

  & git rev-parse --verify --quiet $BaseRef *> $null
  if ($LASTEXITCODE -ne 0) { return }

  $aheadPaths = @(& git log --format= --name-only "$BaseRef..HEAD" 2>$null | Where-Object { $_.Trim() })
  Assert-NoSecretPaths -Paths $aheadPaths -Context "commits ahead of $BaseRef"

  $aheadPatch = @(& git log --format= --no-color -p "$BaseRef..HEAD" 2>$null)
  if (Test-AddedPatchForSecret -PatchLines $aheadPatch) {
    throw "A high-confidence secret pattern was found in commits ahead of $BaseRef. Remove it from local Git history before pushing."
  }
}

try {
  Set-Location -LiteralPath $repoRoot

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is not installed or is not available in PATH."
  }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm is not installed or is not available in PATH."
  }

  $insideWorkTree = (& git rev-parse --is-inside-work-tree 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $insideWorkTree -ne "true") {
    throw "$repoRoot is not a Git worktree."
  }

  $branch = (& git branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
    throw "The update shortcut only pushes the main branch. Current branch: '$branch'."
  }

  $origin = (& git remote get-url origin 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $origin) {
    throw "Git remote 'origin' is not configured."
  }
  $httpsOrigin = [regex]::Match($origin, '^https://(?:[^/@]+@)?github\.com/(?<repo>[^/\s]+/[^/\s]+?)(?:\.git)?/?$')
  $scpOrigin = [regex]::Match($origin, '^git@github\.com:(?<repo>[^/\s]+/[^/\s]+?)(?:\.git)?$')
  $sshOrigin = [regex]::Match($origin, '^ssh://(?:git@)?github\.com/(?<repo>[^/\s]+/[^/\s]+?)(?:\.git)?/?$')
  $originMatch = @($httpsOrigin, $scpOrigin, $sshOrigin) | Where-Object { $_.Success } | Select-Object -First 1
  if (-not $originMatch) {
    throw "The origin remote is not a GitHub repository. Nothing was pushed."
  }
  $displayOrigin = "github.com/$($originMatch.Groups['repo'].Value -replace '\.git$', '')"

  & git diff --cached --quiet
  if ($LASTEXITCODE -eq 1) {
    throw "The Git staging area already contains changes. Commit or unstage them before using this shortcut so it cannot disturb a manual selection."
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the Git staging area. Nothing was pushed."
  }

  $candidatePaths = @(& git ls-files --cached --others --exclude-standard) |
    ForEach-Object { $_ -replace '\\', '/' }
  Assert-NoSecretPaths -Paths $candidatePaths -Context "the current worktree"
  Assert-NoAheadCommitSecrets -BaseRef "origin/main"

  $changes = @(& git status --short)
  $changePreview = if ($changes.Count -eq 0) {
    "No uncommitted files. Any already committed local updates will still be checked."
  } else {
    $shown = @($changes | Select-Object -First 24)
    $more = if ($changes.Count -gt $shown.Count) { "`n... and $($changes.Count - $shown.Count) more" } else { "" }
    "$($changes.Count) changed file(s):`n$($shown -join "`n")$more"
  }

  Write-Host "Yamzo POS GitHub update preflight" -ForegroundColor Green
  Write-Host "Repository: $repoRoot"
  Write-Host "Branch:     $branch"
  Write-Host "Remote:     $displayOrigin"
  Write-Host $changePreview

  if ($PreflightOnly) {
    Write-Host "`nPreflight passed. No files were staged, committed, or pushed." -ForegroundColor Green
    exit 0
  }

  Add-Type -AssemblyName System.Windows.Forms
  $confirmation = [System.Windows.Forms.MessageBox]::Show(
    "This will test and build Yamzo POS, commit all non-ignored changes on main, then push to GitHub.`n`n$changePreview`n`nContinue?",
    "Push Yamzo Update to GitHub",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($confirmation -ne [System.Windows.Forms.DialogResult]::Yes) {
    Write-Host "Cancelled. Nothing was staged, committed, or pushed." -ForegroundColor Yellow
    exit 0
  }

  Invoke-Checked -FilePath "npm.cmd" -Arguments @("test") -Label "Automated tests"
  Invoke-Checked -FilePath "npm.cmd" -Arguments @("run", "build") -Label "Production build"
  Invoke-Checked -FilePath "git" -Arguments @("fetch", "origin", "main", "--prune") -Label "Remote safety check"
  Assert-NoAheadCommitSecrets -BaseRef "origin/main"

  $counts = ((& git rev-list --left-right --count "HEAD...origin/main").Trim() -split '\s+')
  if ($LASTEXITCODE -ne 0 -or $counts.Count -lt 2) {
    throw "Could not compare local main with origin/main. Nothing was pushed."
  }
  $behind = [int]$counts[1]
  if ($behind -gt 0) {
    throw "origin/main has $behind commit(s) that are not local. Update and review the branch before using this shortcut again."
  }

  Invoke-Checked -FilePath "git" -Arguments @("add", "-A") -Label "Stage reviewed update"

  $scriptStagedPaths = @(& git diff --cached --name-only)
  $stagedSecretPaths = $scriptStagedPaths |
    ForEach-Object { $_ -replace '\\', '/' } |
    Where-Object { $_ -ne ".env.example" -and $_ -match $secretPathPattern }
  if ($stagedSecretPaths.Count -gt 0) {
    if ($scriptStagedPaths.Count -gt 0) { & git reset --quiet -- @scriptStagedPaths }
    throw "A credential-like file reached the staging area. Script-created staging was cleared and nothing was pushed:`n$($stagedSecretPaths -join "`n")"
  }

  $stagedPatch = @(& git diff --cached --no-color -U0 --diff-filter=ACMRT)
  if (Test-AddedPatchForSecret -PatchLines $stagedPatch) {
    if ($scriptStagedPaths.Count -gt 0) { & git reset --quiet -- @scriptStagedPaths }
    throw "A high-confidence secret pattern was found in the update. Script-created staging was cleared and nothing was pushed."
  }

  & git diff --cached --quiet
  $hasStagedChanges = $LASTEXITCODE -ne 0
  if ($hasStagedChanges) {
    $commitMessage = "Yamzo POS update $((Get-Date).ToString('yyyy-MM-dd HH:mm'))"
    try {
      Invoke-Checked -FilePath "git" -Arguments @("commit", "-m", $commitMessage) -Label "Commit update"
    } catch {
      if ($scriptStagedPaths.Count -gt 0) { & git reset --quiet -- @scriptStagedPaths }
      throw
    }
  } else {
    Write-Host "`nNo new changes required a commit." -ForegroundColor DarkGray
  }

  Assert-NoAheadCommitSecrets -BaseRef "origin/main"

  $ahead = [int](((& git rev-list --left-right --count "HEAD...origin/main").Trim() -split '\s+')[0])
  if ($ahead -eq 0) {
    Show-Result -Title "Yamzo is already current" -Message "There are no local commits to push. GitHub main is already current."
    exit 0
  }

  Invoke-Checked -FilePath "git" -Arguments @("push", "origin", "main") -Label "Push Yamzo update to GitHub"
  $commit = (& git rev-parse --short HEAD).Trim()
  Show-Result -Title "Yamzo update pushed" -Message "GitHub main was updated successfully.`n`nCommit: $commit"
  Write-Host "`nGitHub main updated successfully at commit $commit." -ForegroundColor Green
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-Host "`n$message" -ForegroundColor Red
  try {
    Show-Result -Title "Yamzo update was not pushed" -Message $message -Icon "Error"
  } catch {
    # Keep the original failure visible in the console if the dialog cannot load.
  }
  exit 1
}
