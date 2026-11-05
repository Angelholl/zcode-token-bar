#!/usr/bin/env node
// 用量状态行（只读）：node usage-line.mjs [--session <id>]
// 数据源：~/.zcode/cli/db/db.sqlite（只读打开）。口径与悬浮条版（cdp-bar.mjs）一致：
//   已结束轮次取 turn_usage，进行中轮次从 model_usage / tool_usage 反连接补算，
//   input_tokens 是完整 prompt 总量，cache_read 只是其中子集、不可重复相加。
// 输出：一行纯文本；无任何数据时输出空（模型侧据此不附加状态行）。

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

const DB_PATH = process.env.ZSTB_DB || join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const CTX_ENV_OVERRIDE = Number(process.env.ZSTB_CONTEXT_LIMIT) || 0;
const DEFAULT_CTX_LIMIT = 1_000_000;
const sidArg = (() => {
  const i = process.argv.indexOf("--session");
  return i > 0 ? process.argv[i + 1] || "" : "";
})();

function fmtTok(n) {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(1) + "亿";
  if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (a >= 1e4) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}

// ---------- 上下文上限识别（与悬浮条同序：env > provider 精确 > 同 provider 唯一 > 同模型 > 默认） ----------
const JSON_CACHE = new Map();
function readJSONCached(p) {
  try {
    const st = statSync(p);
    const hit = JSON_CACHE.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
    const data = JSON.parse(readFileSync(p, "utf8"));
    JSON_CACHE.set(p, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch { return null; }
}
function resolveContextLimit(providerId, modelId) {
  if (CTX_ENV_OVERRIDE > 0) return CTX_ENV_OVERRIDE;
  const files = new Set();
  const add = (p) => { try { if (p && existsSync(p)) files.add(p); } catch {} };
  const home = join(homedir(), ".zcode");
  add(join(home, "v2", "provider_config.json"));
  add(join(home, "v2", "config.json"));
  try {
    const cache = join(home, "tools", "session-stats-cdp", "ctx-sources.json");
    for (const p of JSON.parse(readFileSync(cache, "utf8"))) add(p);
  } catch {}
  const exact = new Map(), byModel = new Map(), byProvider = new Map();
  for (const file of files) {
    const j = readJSONCached(file);
    if (!j || typeof j !== "object") continue;
    const rules = j?.config?.modelConfigRules;
    if (rules && typeof rules === "object") {
      for (const key of ["manualProviderModelRules", "providerModelRules"]) {
        for (const r of rules[key] || []) {
          const limit = Number(r?.config?.properties?.contextWindow);
          const mid = r?.modelId;
          if (!(limit > 0) || !mid) continue;
          if (key === "manualProviderModelRules" || !exact.has(String(r.providerId || "") + "\u0000" + mid)) {
            exact.set(String(r.providerId || "") + "\u0000" + mid, limit);
          }
          if (!byModel.has(mid)) byModel.set(mid, limit);
          if (r.providerId) { const s = byProvider.get(r.providerId) || new Set(); s.add(limit); byProvider.set(r.providerId, s); }
        }
      }
    }
    const providers = j?.provider || j?.config?.provider;
    if (providers && typeof providers === "object") {
      for (const [pid, pv] of Object.entries(providers)) {
        for (const [mid, mv] of Object.entries(pv?.models || {})) {
          const limit = Number(mv?.limit?.context);
          if (!(limit > 0)) continue;
          if (!exact.has(pid + "\u0000" + mid)) exact.set(pid + "\u0000" + mid, limit);
          if (!byModel.has(mid)) byModel.set(mid, limit);
          const s = byProvider.get(pid) || new Set(); s.add(limit); byProvider.set(pid, s);
        }
      }
    }
  }
  const hit = providerId && modelId ? exact.get(providerId + "\u0000" + modelId) : null;
  if (hit) return hit;
  const pl = providerId ? byProvider.get(providerId) : null;
  if (pl && pl.size === 1) return [...pl][0];
  return byModel.get(modelId) || DEFAULT_CTX_LIMIT;
}

let db;
try {
  if (!existsSync(DB_PATH)) process.exit(0);
  db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch { process.exit(0); }

try {
  // 会话识别：优先参数传入的会话 ID，取不到退回最近更新
  let session = sidArg
    ? db.prepare("SELECT id FROM session WHERE id = ? AND time_deleted IS NULL").get(sidArg)
    : null;
  if (!session) {
    session = db.prepare("SELECT id FROM session WHERE time_deleted IS NULL ORDER BY time_updated DESC LIMIT 1").get();
  }
  if (!session) process.exit(0);
  const sid = session.id;

  // 已结束轮次（turn_usage）+ 进行中轮次（model_usage/tool_usage 反连接）
  const t = db.prepare(
    `SELECT COUNT(*) AS n, SUM(tool_call_count) AS steps,
            SUM(input_tokens) AS input, SUM(output_tokens) AS output,
            SUM(cache_read_input_tokens) AS cacheRead, SUM(duration_ms) AS wallMs,
            SUM(CASE WHEN time_to_first_token_ms > 0 THEN 1 ELSE 0 END) AS ttftSteps,
            AVG(CASE WHEN time_to_first_token_ms > 0 THEN time_to_first_token_ms END) AS ttftAvg
     FROM turn_usage WHERE session_id = ?`
  ).get(sid);
  const live = db.prepare(
    `SELECT COUNT(DISTINCT m.turn_id) AS turns, SUM(m.input_tokens) AS input, SUM(m.output_tokens) AS output,
            SUM(m.cache_read_input_tokens) AS cacheRead, SUM(m.duration_ms) AS dur,
            SUM(CASE WHEN m.time_to_first_token_ms > 0 THEN m.time_to_first_token_ms ELSE 0 END) AS ttft,
            SUM(CASE WHEN m.time_to_first_token_ms > 0 THEN 1 ELSE 0 END) AS ttftSteps
     FROM model_usage m
     WHERE m.session_id = ? AND m.turn_id NOT IN (SELECT turn_id FROM turn_usage WHERE session_id = ?)`
  ).get(sid, sid);
  const liveSteps = db.prepare(
    `SELECT COUNT(*) AS n FROM tool_usage
     WHERE session_id = ? AND turn_id NOT IN (SELECT turn_id FROM turn_usage WHERE session_id = ?)`
  ).get(sid, sid).n || 0;

  const input = (t.input || 0) + (live.input || 0);
  const output = (t.output || 0) + (live.output || 0);
  const cacheRead = (t.cacheRead || 0) + (live.cacheRead || 0);
  const turns = (t.n || 0) + (live.turns || 0);
  const steps = (t.steps || 0) + liveSteps;
  const total = input + output;
  if (total <= 0) process.exit(0); // 还没有任何模型请求

  // 输出速度：解码时长 = 请求时长 - TTFT
  const ms = db.prepare(
    `SELECT SUM(duration_ms) AS dur,
            SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN time_to_first_token_ms ELSE 0 END) AS ttft
     FROM model_usage WHERE session_id = ? AND output_tokens > 0`
  ).get(sid);
  const decodeMs = (ms.dur || 0) - (ms.ttft || 0);
  const speed = decodeMs > 0 && output > 0 ? Math.max(1, Math.round(output / (decodeMs / 1000))) : null;

  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : null;

  // 上下文：最近一次发出 prompt 的轮次里的最大单次请求（不能用 turn_usage 累加值）
  let ctxTokens = 0;
  const last = db.prepare(
    "SELECT turn_id FROM model_usage WHERE session_id = ? AND input_tokens > 0 ORDER BY started_at DESC, rowid DESC LIMIT 1"
  ).get(sid);
  if (last) {
    ctxTokens = db.prepare(
      "SELECT MAX(input_tokens) AS p FROM model_usage WHERE session_id = ? AND turn_id = ?"
    ).get(sid, last.turn_id).p || 0;
  }
  // 当前模型 → 上限
  let providerId = "", modelId = "";
  try {
    const row = db.prepare(
      "SELECT data FROM session_entry WHERE session_id = ? AND type = 'runtime/model_selection' ORDER BY time_created DESC, rowid DESC LIMIT 1"
    ).get(sid);
    if (row?.data) {
      const j = JSON.parse(row.data);
      const s = j?.modelSelection || j;
      if (s?.modelId) { providerId = s.providerId || ""; modelId = s.modelId; }
    }
  } catch {}
  if (!modelId) {
    try {
      const m = db.prepare(
        "SELECT provider_id, model_id FROM model_usage WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1"
      ).get(sid);
      if (m?.model_id) { providerId = m.provider_id || ""; modelId = m.model_id; }
    } catch {}
  }
  const ctxLimit = resolveContextLimit(providerId, modelId);
  const ctxPct = ctxTokens > 0 ? Math.min(100, Math.round((ctxTokens / ctxLimit) * 100)) : 0;

  const parts = [];
  if (turns) parts.push(`${turns} 轮 ${steps} 步${speed ? ` · ${speed} tok/s` : ""}`);
  parts.push(`${fmtTok(total)} tok${hit != null ? ` · 缓存命中 ${hit}%` : ""}`);
  if (ctxTokens > 0) parts.push(`上下文 ${ctxPct}%`);
  console.log(parts.join(" · "));
} catch {
  process.exit(0);
} finally {
  try { db.close(); } catch {}
}
