# ──────────────────────────────────────────────────────────
# fast_push_win.ps1
# 快速提交推送：暂存 → 提交 → 同步远程 → 推送（不升版本、不打 tag）
# ──────────────────────────────────────────────────────────

$ErrorActionPreference = 'Continue'

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $ROOT

$REMOTE = if ($env:REMOTE) { $env:REMOTE } else { 'origin' }
$BRANCH = (git rev-parse --abbrev-ref HEAD 2>&1).Trim()
$MANUAL_MSG = if ($args.Count -gt 0) { [string]$args[0] } else { '' }

function Assert-GitOK {
    param([string]$action)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: ${action} failed (exit code $LASTEXITCODE)" -ForegroundColor Red
        Pop-Location
        Read-Host 'Press Enter to exit...'
        exit 1
    }
}

function Sync-RemoteBranch {
    Write-Host "Syncing ${REMOTE}/${BRANCH}..."
    git fetch $REMOTE
    git pull --rebase $REMOTE $BRANCH
}

function Get-CommitMessage {
    if ($MANUAL_MSG -and $MANUAL_MSG.Trim().Length -gt 0) {
        return $MANUAL_MSG.Trim()
    }

    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if ($claude) {
        $diff = git diff --cached 2>$null
        if ($diff) {
            Write-Host 'Calling AI to generate commit message...'
            $prompt = '你是 git 提交助手。根据输入的 git diff，用简体中文写一句简洁的 commit message。要求：一行以内；聚焦改动目的；不要加引号、不要前缀解释。'
            try {
                $msg = $diff | claude -p --model haiku $prompt 2>$null
                if ($msg) {
                    $line = (($msg -split "`n") | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1)
                    if ($line) { return $line.Trim() }
                }
            } catch {
                # fall through to default message
            }
        }
    }

    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    return "chore: 快速同步 ($ts)"
}

$status = git status --porcelain
if (-not $status) {
    Write-Host 'Working tree clean, nothing to commit.'
    Pop-Location
    Read-Host 'Press Enter to exit...'
    exit 0
}

git add -A
$null = git diff --cached --quiet 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host 'No changes to commit.'
    Pop-Location
    Read-Host 'Press Enter to exit...'
    exit 0
}

$COMMIT_MSG = Get-CommitMessage
Write-Host "Commit message: $COMMIT_MSG"
git commit -m $COMMIT_MSG
Assert-GitOK 'git commit'

$null = git diff --quiet 2>&1;          $d1 = $LASTEXITCODE
$null = git diff --cached --quiet 2>&1;  $d2 = $LASTEXITCODE
if ($d1 -ne 0 -or $d2 -ne 0) {
    Write-Host 'Warning: unstaged changes remain, amending into this commit...'
    git add -A
    git commit --amend --no-edit
}

Sync-RemoteBranch

Write-Host "Pushing to ${REMOTE}/${BRANCH}..."
git push $REMOTE $BRANCH
Assert-GitOK 'git push'

Write-Host ''
Write-Host 'Done:'
Write-Host "  - Code pushed to ${REMOTE}/${BRANCH}"
Write-Host '  - Version not bumped, no tag created'
Write-Host '  - For remote release build, run .\fast_release_win.ps1'

Pop-Location
Read-Host 'Press Enter to exit...'
