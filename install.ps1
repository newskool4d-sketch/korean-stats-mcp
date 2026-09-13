# Korean Stats MCP - Windows 자동 설치 스크립트
#
# Claude Desktop / Cursor / Windsurf 설정에 원격 MCP 서버를 등록합니다.
#
# 사용:
#   & .\install.ps1
#   & .\install.ps1 -Client cursor
# 원격 설치는 README의 버전 태그 + SHA-256 검증 절차를 사용하세요.

param(
  [ValidateSet("claude", "cursor", "windsurf", "all")]
  [string]$Client = "all",
  [string]$Url = "https://mcp.gomdori.app/stats"
)

$ServerName = "korean-stats"
$McpRemotePackage = "mcp-remote@0.1.38"

function Write-Info  { param($m) Write-Host "[korean-stats-mcp] $m" -ForegroundColor Blue }
function Write-Ok    { param($m) Write-Host "✓ $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "⚠  $m" -ForegroundColor Yellow }
function Write-Err   { param($m) Write-Host "✗ $m" -ForegroundColor Red }

Write-Info "플랫폼: Windows"
Write-Info "원격 서버: $Url"
Write-Info "대상 클라이언트: $Client"
Write-Host ""

function Merge-Config {
  param([string]$Path, [hashtable]$NewServers)

  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  # 백업
  if (Test-Path $Path) {
    Copy-Item -Path $Path -Destination "$Path.bak.$(Get-Date -UFormat %s)" -Force
  }

  $cfg = @{}
  if (Test-Path $Path) {
    try {
      $cfg = Get-Content $Path -Raw | ConvertFrom-Json -AsHashtable
      if (-not $cfg) { $cfg = @{} }
    } catch {
      Write-Warn "기존 설정 파싱 실패, 새로 작성합니다."
      $cfg = @{}
    }
  }

  if (-not $cfg.ContainsKey("mcpServers") -or $null -eq $cfg.mcpServers) {
    $cfg.mcpServers = @{}
  }

  foreach ($k in $NewServers.Keys) {
    $cfg.mcpServers[$k] = $NewServers[$k]
  }

  $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $Path -Encoding UTF8
}

$RemoteServer = @{
  command = "npx"
  args    = @("-y", $McpRemotePackage, $Url)
}
$WindsurfServer = @{
  serverUrl = $Url
}

function Install-Claude {
  $path = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  Write-Info "Claude Desktop: $path"
  Merge-Config -Path $path -NewServers @{ $ServerName = $RemoteServer }
  Write-Ok "Claude Desktop 등록 완료. Claude를 재시작하세요."
}

function Install-Cursor {
  $path = Join-Path $env:USERPROFILE ".cursor\mcp.json"
  Write-Info "Cursor: $path"
  Merge-Config -Path $path -NewServers @{ $ServerName = $RemoteServer }
  Write-Ok "Cursor 등록 완료. Cursor를 재시작하세요."
}

function Install-Windsurf {
  $path = Join-Path $env:USERPROFILE ".codeium\windsurf\mcp_config.json"
  Write-Info "Windsurf: $path"
  Merge-Config -Path $path -NewServers @{ $ServerName = $WindsurfServer }
  Write-Ok "Windsurf 등록 완료. Windsurf를 재시작하세요."
}

# 헬스 체크
Write-Info "원격 서버 헬스 체크..."
try {
  $healthUrl = if ($Url -match "/mcp/?$") {
    $Url -replace "/mcp/?$", "/health"
  } else {
    $Url.TrimEnd('/') + "/health"
  }
  $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 10
  if ($resp.StatusCode -eq 200) {
    Write-Ok "원격 서버 응답 정상"
  }
} catch {
  Write-Err "원격 서버 헬스 체크 실패. 설정을 변경하지 않습니다."
  exit 1
}
Write-Host ""

switch ($Client) {
  "claude"   { Install-Claude }
  "cursor"   { Install-Cursor }
  "windsurf" { Install-Windsurf }
  "all" {
    Install-Claude; Write-Host ""
    Install-Cursor; Write-Host ""
    Install-Windsurf
  }
}

Write-Host ""
Write-Ok "설치 완료. 통계 질의 예시:"
Write-Host "  - `"한국 인구가 몇 명이야?`""
Write-Host "  - `"광진구 인구 알려줘`"   ← 자치구 자동 라우팅"
Write-Host "  - `"저출산 현황`"           ← 자연어 별칭"
Write-Host "  - `"서울 아파트가격`""
Write-Host "  - `"최근 10년 출산율 추이`""
