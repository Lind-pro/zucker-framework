#!/bin/bash
# zucker-framework e2e 冒烟测试
# 用法: ./scripts/e2e-smoke-test.sh [base_url]
# 默认: http://localhost:4200/api

set -euo pipefail

BASE="${1:-http://localhost:4200/api}"
PASS=0
FAIL=0
ERRORS=""

check() {
  local name="$1" code="$2" body="$3"
  if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then
    PASS=$((PASS+1))
    echo "  ✅ $name ($code)"
  elif [ "$code" -ge 400 ] && [ "$code" -lt 500 ] && echo "$name" | grep -q "→[0-9]"; then
    # 期望的错误码
    local expected=$(echo "$name" | grep -oE '→[0-9]+' | tr -d '→')
    if [ "$code" = "$expected" ]; then
      PASS=$((PASS+1))
      echo "  ✅ $name ($code)"
    else
      FAIL=$((FAIL+1))
      echo "  ❌ $name (期望 $expected, 实际 $code)"
      ERRORS="$ERRORS\n  $name: $body"
    fi
  else
    FAIL=$((FAIL+1))
    echo "  ❌ $name ($code)"
    ERRORS="$ERRORS\n  $name ($code): $(echo "$body" | head -c 200)"
  fi
}

req() {
  local method="$1" path="$2" data="${3:-}" auth="${4:-}"
  local args=(-s -w "\n%{http_code}" -X "$method" "$BASE$path" -H "Content-Type: application/json")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  [ -n "$data" ] && args+=(-d "$data")
  local resp
  resp=$(curl "${args[@]}" 2>/dev/null)
  local code=$(echo "$resp" | tail -1)
  local body=$(echo "$resp" | sed '$d')
  echo "$code|$body"
}

echo "═══════════════════════════════════════════════════"
echo "  zucker-framework E2E 冒烟测试"
echo "  Target: $BASE"
echo "═══════════════════════════════════════════════════"

# ─── 1. 公开端点 ────────────────────────────────────
echo ""
echo "── 公开端点 ──"
r=$(req GET /health); check "Health" "${r%%|*}" "${r#*|}"

# ─── 2. 登录 ────────────────────────────────────────
echo ""
echo "── 认证 ──"
r=$(req POST /authorize/login '{"username":"admin","password":"admin123"}')
code="${r%%|*}"; body="${r#*|}"
check "Login" "$code" "$body"
TOKEN=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
  echo "  ⛔ 无法获取 token，终止测试"
  echo ""
  echo "RESULT: $PASS passed, $FAIL failed"
  exit 1
fi

r=$(req GET /authorize/me "" "$TOKEN"); check "Me" "${r%%|*}" "${r#*|}"

# ─── 3. Dashboard ───────────────────────────────────
echo ""
echo "── Dashboard ──"
r=$(req GET /dashboard/stats "" "$TOKEN"); check "Dashboard stats" "${r%%|*}" "${r#*|}"

# ─── 4. 用户 CRUD ───────────────────────────────────
echo ""
echo "── 用户 ──"
r=$(req POST /users/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "Users query" "${r%%|*}" "${r#*|}"
r=$(req POST /users/_count '{}' "$TOKEN"); check "Users count" "${r%%|*}" "${r#*|}"

# ─── 5. 角色 CRUD ───────────────────────────────────
echo ""
echo "── 角色 ──"
r=$(req POST /roles/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "Roles query" "${r%%|*}" "${r#*|}"
r=$(req POST /roles/_count '{}' "$TOKEN"); check "Roles count" "${r%%|*}" "${r#*|}"

# ─── 6. 权限 CRUD ───────────────────────────────────
echo ""
echo "── 权限 ──"
r=$(req POST /permissions/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "Permissions query" "${r%%|*}" "${r#*|}"
r=$(req GET /permissions "" "$TOKEN"); check "Permissions list" "${r%%|*}" "${r#*|}"
r=$(req GET /permissions/tree "" "$TOKEN"); check "Permissions tree" "${r%%|*}" "${r#*|}"

# ─── 7. 菜单 ────────────────────────────────────────
echo ""
echo "── 菜单 ──"
r=$(req GET /menu/tree "" "$TOKEN"); check "Menu tree" "${r%%|*}" "${r#*|}"
r=$(req GET /menu/all "" "$TOKEN"); check "Menu all" "${r%%|*}" "${r#*|}"

# ─── 8. 配置 ────────────────────────────────────────
echo ""
echo "── 配置 ──"
r=$(req GET /config "" "$TOKEN"); check "Config get" "${r%%|*}" "${r#*|}"

# ─── 9. 字典 ────────────────────────────────────────
echo ""
echo "── 字典 ──"
r=$(req POST /dictionary/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "Dictionary query" "${r%%|*}" "${r#*|}"

# ─── 10. 积分 ───────────────────────────────────────
echo ""
echo "── 积分 ──"
r=$(req POST /credit/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "Credit query" "${r%%|*}" "${r#*|}"

# ─── 11. 日志 ───────────────────────────────────────
echo ""
echo "── 日志 ──"
r=$(req POST /logging/access/_query '{"pageIndex":0,"pageSize":5}' "$TOKEN"); check "Access log query" "${r%%|*}" "${r#*|}"

# ─── 12. 通知 ───────────────────────────────────────
echo ""
echo "── 通知 ──"
r=$(req POST /notification/template/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "Notify template query" "${r%%|*}" "${r#*|}"

# ─── 13. 表单 ───────────────────────────────────────
echo ""
echo "── 表单 ──"
r=$(req POST /form/definition/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "Form query" "${r%%|*}" "${r#*|}"

# ─── 14. 租户 ───────────────────────────────────────
echo ""
echo "── 租户 ──"
r=$(req POST /tenant/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "Tenant query" "${r%%|*}" "${r#*|}"

# ─── 15. 国际化 ─────────────────────────────────────
echo ""
echo "── 国际化 ──"
r=$(req POST /i18n/_query '{"pageIndex":0,"pageSize":10}' "$TOKEN"); check "I18n query" "${r%%|*}" "${r#*|}"

# ─── 16. 告警 ───────────────────────────────────────
echo ""
echo "── 监控 ──"
r=$(req GET /monitoring/alerts "" "$TOKEN"); check "Alerts list" "${r%%|*}" "${r#*|}"
r=$(req GET /monitoring/alerts/rules "" "$TOKEN"); check "Alert rules" "${r%%|*}" "${r#*|}"

# ─── 17. 错误处理 ───────────────────────────────────
echo ""
echo "── 错误处理 ──"
r=$(req POST /authorize/login '{"username":"","password":"x"}'); check "Empty user →400" "${r%%|*}" "${r#*|}"
r=$(req POST /authorize/login '{"username":"admin","password":"wrong"}'); check "Wrong pwd →401" "${r%%|*}" "${r#*|}"
r=$(req GET /users/nonexistent "" "$TOKEN"); check "Not found →404" "${r%%|*}" "${r#*|}"
r=$(req GET /dashboard/stats ""); check "No token →401" "${r%%|*}" "${r#*|}"

# ─── 结果 ────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
TOTAL=$((PASS+FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ ALL PASS: $PASS / $TOTAL"
else
  echo "  ❌ $PASS / $TOTAL passed ($FAIL failed)"
  echo ""
  echo "  失败详情:"
  echo -e "$ERRORS"
fi
echo "═══════════════════════════════════════════════════"
exit $FAIL
