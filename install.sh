#!/usr/bin/env bash
#
# Korean Stats MCP — 자동 설치 스크립트 (macOS / Linux)
#
# Claude Desktop / Cursor / Windsurf 설정에 원격 MCP 서버를 등록합니다.
# 기존 설정은 보존하면서 'korean-stats' 항목만 추가/갱신합니다.
#
# 사용:
#   bash install.sh
#   bash install.sh --client cursor
# 원격 설치는 README의 버전 태그 + SHA-256 검증 절차를 사용하세요.
#

set -euo pipefail

REMOTE_URL="https://mcp.gomdori.app/stats"
SERVER_NAME="korean-stats"
MCP_REMOTE_PACKAGE="mcp-remote@0.1.38"
CLIENT="all"  # claude|cursor|windsurf|all

# CLI 인자
while [[ $# -gt 0 ]]; do
  case "$1" in
    --client) CLIENT="$2"; shift 2 ;;
    --url) REMOTE_URL="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Korean Stats MCP 자동 설치 스크립트

옵션:
  --client {claude|cursor|windsurf|all}   설치할 클라이언트 (기본: all)
  --url <URL>                              원격 MCP 서버 URL (기본: $REMOTE_URL)
  -h, --help                               도움말

예시:
  bash install.sh                          # 모든 클라이언트에 설치
  bash install.sh --client cursor          # Cursor만 설치
EOF
      exit 0
      ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

if [[ "$REMOTE_URL" =~ ^https://[^/@?#[:space:]]+([/?#].*)?$ ]]; then
  :
elif [[ "$REMOTE_URL" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?([/?#].*)?$ ]]; then
  :
else
  echo "원격 URL은 HTTPS 또는 로컬 loopback HTTP만 허용됩니다: $REMOTE_URL" >&2
  exit 1
fi
if [[ "$REMOTE_URL" == *$'\n'* || "$REMOTE_URL" == *$'\r'* || "$REMOTE_URL" == *$'\t'* ]]; then
  echo "원격 URL에 제어 문자를 사용할 수 없습니다." >&2
  exit 1
fi

# 색상
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'

log()   { echo "${BLUE}[korean-stats-mcp]${NC} $*"; }
ok()    { echo "${GREEN}✓${NC} $*"; }
warn()  { echo "${YELLOW}⚠${NC}  $*"; }
err()   { echo "${RED}✗${NC} $*" >&2; }

# OS 감지
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  *) err "지원하지 않는 OS: $OS"; exit 1 ;;
esac

log "플랫폼: $PLATFORM"
log "원격 서버: $REMOTE_URL"
log "대상 클라이언트: $CLIENT"
echo

# jq 또는 python3 필요
if command -v jq >/dev/null 2>&1; then
  JSON_TOOL="jq"
elif command -v python3 >/dev/null 2>&1; then
  JSON_TOOL="python3"
else
  err "jq 또는 python3가 필요합니다."
  exit 1
fi

# JSON merge: 입력 파일에 'mcpServers' 객체 추가/병합. python3 또는 jq 사용.
merge_config() {
  local file="$1"
  local config_json="$2"

  mkdir -p "$(dirname "$file")"

  if [[ ! -s "$file" ]]; then
    echo '{}' > "$file"
  fi

  # 기존 파일 백업
  cp "$file" "${file}.bak.$(date +%s)" 2>/dev/null || true

  if [[ "$JSON_TOOL" == "jq" ]]; then
    local tmp="${file}.tmp"
    jq --argjson new "$config_json" '
      .mcpServers = (.mcpServers // {}) * $new
    ' "$file" > "$tmp" && mv "$tmp" "$file"
  else
    python3 - "$file" "$config_json" <<'PY'
import json, sys
path, raw_config = sys.argv[1:3]
new = json.loads(raw_config)
try:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    cfg = {}
cfg.setdefault("mcpServers", {}).update(new)
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
PY
  fi
}

build_remote_config() {
  local kind="$1"
  if [[ "$JSON_TOOL" == "jq" ]]; then
    if [[ "$kind" == "windsurf" ]]; then
      jq -cn --arg name "$SERVER_NAME" --arg url "$REMOTE_URL" '{($name): {serverUrl: $url}}'
    else
      jq -cn --arg name "$SERVER_NAME" --arg url "$REMOTE_URL" \
        --arg package "$MCP_REMOTE_PACKAGE" \
        '{($name): {command: "npx", args: ["-y", $package, $url]}}'
    fi
  else
    python3 - "$SERVER_NAME" "$REMOTE_URL" "$kind" "$MCP_REMOTE_PACKAGE" <<'PY'
import json, sys
name, url, kind, package = sys.argv[1:5]
server = {"serverUrl": url} if kind == "windsurf" else {
    "command": "npx",
    "args": ["-y", package, url],
}
print(json.dumps({name: server}, ensure_ascii=False))
PY
  fi
}

CLAUDE_CONFIG="$(build_remote_config command)"
CURSOR_CONFIG="$CLAUDE_CONFIG"
WINDSURF_CONFIG="$(build_remote_config windsurf)"

install_claude() {
  local path
  if [[ "$PLATFORM" == "mac" ]]; then
    path="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  else
    path="$HOME/.config/Claude/claude_desktop_config.json"
  fi
  log "Claude Desktop: $path"
  merge_config "$path" "$CLAUDE_CONFIG"
  ok "Claude Desktop 등록 완료. Claude를 재시작하세요."
}

install_cursor() {
  local path
  if [[ "$PLATFORM" == "mac" ]]; then
    path="$HOME/.cursor/mcp.json"
  else
    path="$HOME/.cursor/mcp.json"
  fi
  log "Cursor: $path"
  merge_config "$path" "$CURSOR_CONFIG"
  ok "Cursor 등록 완료. Cursor를 재시작하세요."
}

install_windsurf() {
  local path
  if [[ "$PLATFORM" == "mac" ]]; then
    path="$HOME/.codeium/windsurf/mcp_config.json"
  else
    path="$HOME/.codeium/windsurf/mcp_config.json"
  fi
  log "Windsurf: $path"
  merge_config "$path" "$WINDSURF_CONFIG"
  ok "Windsurf 등록 완료. Windsurf를 재시작하세요."
}

# 헬스 체크
log "원격 서버 헬스 체크..."
if [[ "$REMOTE_URL" == */mcp ]]; then
  HEALTH_URL="${REMOTE_URL%/mcp}/health"
else
  HEALTH_URL="${REMOTE_URL%/}/health"
fi
if curl -sSf -- "$HEALTH_URL" >/dev/null 2>&1; then
  ok "원격 서버 응답 정상"
else
  err "원격 서버 헬스 체크 실패. 설정을 변경하지 않습니다. URL: $REMOTE_URL"
  exit 1
fi
echo

case "$CLIENT" in
  claude)   install_claude ;;
  cursor)   install_cursor ;;
  windsurf) install_windsurf ;;
  all)
    install_claude
    echo
    install_cursor
    echo
    install_windsurf
    ;;
  *)
    err "알 수 없는 클라이언트: $CLIENT"
    exit 1
    ;;
esac

echo
ok "설치 완료. 통계 질의 예시:"
echo "  - \"한국 인구가 몇 명이야?\""
echo "  - \"광진구 인구 알려줘\"   ← 자치구 자동 라우팅"
echo "  - \"저출산 현황\"           ← 자연어 별칭"
echo "  - \"서울 아파트가격\""
echo "  - \"최근 10년 출산율 추이\""
