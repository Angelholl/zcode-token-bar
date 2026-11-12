#!/usr/bin/env node
// session-stats CDP 注入器（自研，零依赖，Node 22+）
// ------------------------------------------------------------
// 功能对齐 DeepSeek Harness 原生胶囊统计（插件版同口径）：
//   · 活动胶囊  「N 轮 M 步 · X tok/s」      点击 → 模型用时 / 工具用时 / TTFT 平均 / 输出速度
//   · 用量胶囊  「X tok · 缓存命中 P%」      点击 → 精确总量 + 未命中输入/缓存读/缓存写/输出 分桶
//   · 上下文胶囊「上下文 P%」+ 迷你进度条     点击 → 最近一轮上下文 / 上限 / 百分比
//   · 模型明细行 + 数据时间戳
// 原理：每 5s 只读轮询 ~/.zcode/cli/db/db.sqlite，经 CDP（--remote-debugging-port）推进渲染层。
// 统计条锚在聊天输入框（textarea）所在 composer 容器正下方；失败退化为底部悬浮条。
//
// 用法：node cdp-bar.mjs
//   环境变量：ZSTB_PORT（默认 9333）、ZSTB_INTERVAL（默认 5000ms）
//            ZSTB_CONTEXT_LIMIT（可选，强制指定上下文上限；不设则按当前模型自动识别）
//   上下文上限识别顺序：环境变量 > ZCode provider 配置里的 contextWindow（精确匹配模型）
//                     > 同模型在各 provider 的目录值 > 默认 1000000
//   停止：stop.cmd（按 controller.pid）

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { execSync, spawn as spawnProc } from "node:child_process";

const PORT = Number(process.env.ZSTB_PORT) || 9333;
const INTERVAL = Number(process.env.ZSTB_INTERVAL) || 5000;
const CTX_ENV_OVERRIDE = Number(process.env.ZSTB_CONTEXT_LIMIT) || 0; // 显式指定时优先
const DEFAULT_CTX_LIMIT = 1_000_000;                                   // 识别不到才兜底
const DB_PATH = process.env.ZSTB_DB || join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const TOOL_DIR = process.env.ZSTB_TOOL_DIR || join(homedir(), ".zcode", "tools", "session-stats-cdp");
const PID_FILE = join(TOOL_DIR, "controller.pid");
const CTX_SOURCES_FILE = join(TOOL_DIR, "ctx-sources.json");

// ---------- 上下文上限：按当前模型识别（ZCode 是 per-model 配置，不能写死） ----------
const JSON_CACHE = new Map(); // path -> { mtimeMs, size, data }
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

// 已知 provider 配置文件位置：环境变量 / ZCode home / 各盘根 <dir>\.zcode\v2
// 首次发现的结果写入 ctx-sources.json，供插件版 stats.mjs 复用，避免重复扫盘。
let ctxFilesCache = { at: 0, files: [] };
function candidateConfigFiles() {
  if (Date.now() - ctxFilesCache.at < 300_000) return ctxFilesCache.files;
  const files = new Set();
  const addFile = (p) => { try { if (p && existsSync(p)) files.add(p); } catch {} };

  for (const name of ["ZSTB_PROVIDER_CONFIGS", "ZCODE_HOME", "ZCODE_CONFIG_DIR"]) {
    const v = process.env[name];
    if (!v) continue;
    if (name === "ZSTB_PROVIDER_CONFIGS") for (const p of v.split(";")) addFile(p.trim());
    else { addFile(join(v, "v2", "provider_config.json")); addFile(join(v, "v2", "config.json")); }
  }
  // 上次发现过的路径（由本控制器写盘，插件共用）
  try {
    for (const p of JSON.parse(readFileSync(CTX_SOURCES_FILE, "utf8"))) addFile(p);
  } catch {}
  const homes = new Set([dirname(dirname(DB_PATH)), join(homedir(), ".zcode")]);
  for (const h of homes) {
    addFile(join(h, "v2", "provider_config.json"));
    addFile(join(h, "v2", "config.json"));
  }
  // 盘根扫一层：<drive>:\<dir>\.zcode\v2\provider_config.json（ZCode portable home 可能不在 C 盘）
  for (let c = 67; c <= 90; c++) {
    const root = String.fromCharCode(c) + ":\\";
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      addFile(join(root, e.name, ".zcode", "v2", "provider_config.json"));
    }
  }
  ctxFilesCache = { at: Date.now(), files: [...files] };
  try { writeFileSync(CTX_SOURCES_FILE, JSON.stringify(ctxFilesCache.files, null, 1)); } catch {}
  return ctxFilesCache.files;
}

// 汇总成两张表：providerId+modelId 精确值，以及“同名模型”兜底值
function buildContextIndex() {
  const exact = new Map();   // providerId \0 modelId -> tokens
  const byModel = new Map(); // modelId -> tokens
  const byProvider = new Map(); // providerId -> Set(tokens)，用于同 provider 的别名模型兜底
  const noteProvider = (pid, limit) => {
    if (!pid) return;
    if (!byProvider.has(pid)) byProvider.set(pid, new Set());
    byProvider.get(pid).add(limit);
  };
  for (const file of candidateConfigFiles()) {
    const j = readJSONCached(file);
    if (!j || typeof j !== "object") continue;
    // 新格式：{ config: { modelConfigRules: { providerModelRules:[{providerId,modelId,config.properties.contextWindow}] } } }
    const rules = j?.config?.modelConfigRules;
    if (rules && typeof rules === "object") {
      for (const key of ["manualProviderModelRules", "providerModelRules"]) {
        for (const r of rules[key] || []) {
          const limit = Number(r?.config?.properties?.contextWindow);
          const mid = r?.modelId;
          if (!(limit > 0) || !mid) continue;
          const k = String(r.providerId || "") + "\u0000" + mid;
          if (key === "manualProviderModelRules" || !exact.has(k)) exact.set(k, limit);
          if (!byModel.has(mid)) byModel.set(mid, limit);
          noteProvider(r.providerId, limit);
        }
      }
    }
    // 旧格式：{ provider: { <id>: { models: { <modelId>: { limit: { context } } } } } }
    const providers = j?.provider || j?.config?.provider;
    if (providers && typeof providers === "object") {
      for (const [pid, pv] of Object.entries(providers)) {
        const models = pv && typeof pv === "object" ? pv.models : null;
        if (!models || typeof models !== "object") continue;
        for (const [mid, mv] of Object.entries(models)) {
          const limit = Number(mv?.limit?.context);
          if (!(limit > 0)) continue;
          const k = pid + "\u0000" + mid;
          if (!exact.has(k)) exact.set(k, limit);
          if (!byModel.has(mid)) byModel.set(mid, limit);
          noteProvider(pid, limit);
        }
      }
    }
  }
  return { exact, byModel, byProvider };
}

function resolveContextLimit(model) {
  const providerId = model?.providerId || "";
  const modelId = model?.modelId || "";
  if (CTX_ENV_OVERRIDE > 0) return { limit: CTX_ENV_OVERRIDE, source: "env" };
  const { exact, byModel, byProvider } = buildContextIndex();
  if (providerId && modelId) {
    const hit = exact.get(providerId + "\u0000" + modelId);
    if (hit) return { limit: hit, source: "provider" };
  }
  // 同一 provider 下只声明过一种上下文窗口时，别名/新模型沿用它（如某些代理网关暴露多个模型名）
  const providerLimits = providerId ? byProvider.get(providerId) : null;
  if (providerLimits && providerLimits.size === 1) {
    return { limit: [...providerLimits][0], source: "provider" };
  }
  if (modelId) {
    const hit = byModel.get(modelId);
    if (hit) return { limit: hit, source: "model" };
  }
  return { limit: DEFAULT_CTX_LIMIT, source: "default" };
}

// 当前会话真正在跑的模型：优先 runtime/model_selection，其次最近一条 model_usage
function currentModel(db, sid) {
  try {
    const row = db.prepare(
      "SELECT data FROM session_entry WHERE session_id = ? AND type = 'runtime/model_selection' ORDER BY time_created DESC, rowid DESC LIMIT 1"
    ).get(sid);
    if (row?.data) {
      const j = JSON.parse(row.data);
      const s = j?.modelSelection || j;
      if (s?.modelId) return { providerId: s.providerId || "", modelId: s.modelId };
    }
  } catch {}
  try {
    const m = db.prepare(
      "SELECT provider_id, model_id FROM model_usage WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1"
    ).get(sid);
    if (m?.model_id) return { providerId: m.provider_id || "", modelId: m.model_id };
  } catch {}
  return { providerId: "", modelId: "" };
}

writeFileSync(PID_FILE, String(process.pid));

// ---------- 统计（与 stats.mjs / DSH 同口径） ----------
function fmtTokens(n) {
  if (n == null || Number.isNaN(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(1) + "亿";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e4) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}
function fmtDuration(ms) {
  if (!ms || ms <= 0) return "0秒";
  const s = ms / 1000;
  if (s < 60) return (Math.round(s * 10) / 10) + "秒";
  const w = Math.round(s);
  return `${Math.floor(w / 60)}分${w % 60}秒`;
}
function fmtPercent(hit, total) {
  if (!total || total <= 0) return null;
  const p = (hit / total) * 100;
  return p >= 99.95 && p < 100 ? +p.toFixed(1) : Math.round(p);
}
function computeStats(sessionId) {
  if (!existsSync(DB_PATH)) return null;
  let db;
  try { db = new DatabaseSync(DB_PATH, { readOnly: true }); } catch { return null; }
  try {
    // 会话识别：优先用页面 DOM 上报的当前会话；取不到才退回“最近更新”
    let session = sessionId
      ? db.prepare("SELECT id, title FROM session WHERE id = ? AND time_deleted IS NULL").get(sessionId)
      : null;
    if (!session) {
      session = db.prepare(
        "SELECT id, title FROM session WHERE time_deleted IS NULL ORDER BY time_updated DESC LIMIT 1"
      ).get();
    }
    if (!session) return null;
    const sid = session.id;

    // 已结束轮次：turn_usage
    const t = db.prepare(
      `SELECT COUNT(*) AS n, SUM(tool_call_count) AS steps,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(cache_read_input_tokens) AS cacheRead,
              SUM(cache_creation_input_tokens) AS cacheWrite,
              SUM(computed_total_tokens) AS total,
              AVG(CASE WHEN time_to_first_token_ms > 0 THEN time_to_first_token_ms END) AS ttftAvg,
              SUM(CASE WHEN time_to_first_token_ms > 0 THEN 1 ELSE 0 END) AS ttftSteps,
              SUM(duration_ms) AS wallMs
       FROM turn_usage WHERE session_id = ?`
    ).get(sid);

    // 进行中的轮次：ZCode 只在轮次结束时写 turn_usage，运行期的实时数据在 model_usage / tool_usage
    const live = db.prepare(
      `SELECT COUNT(DISTINCT m.turn_id) AS turns,
              SUM(m.input_tokens) AS input, SUM(m.output_tokens) AS output,
              SUM(m.cache_read_input_tokens) AS cacheRead,
              SUM(m.cache_creation_input_tokens) AS cacheWrite,
              SUM(m.duration_ms) AS dur,
              SUM(CASE WHEN m.time_to_first_token_ms > 0 THEN m.time_to_first_token_ms ELSE 0 END) AS ttft,
              SUM(CASE WHEN m.time_to_first_token_ms > 0 THEN 1 ELSE 0 END) AS ttftSteps,
              COUNT(*) AS reqs
       FROM model_usage m
       WHERE m.session_id = ?
         AND m.turn_id NOT IN (SELECT turn_id FROM turn_usage WHERE session_id = ?)`
    ).get(sid, sid);

    const liveSteps = db.prepare(
      `SELECT COUNT(*) AS n FROM tool_usage
       WHERE session_id = ?
         AND turn_id NOT IN (SELECT turn_id FROM turn_usage WHERE session_id = ?)`
    ).get(sid, sid).n || 0;

    const input = (t.input || 0) + (live.input || 0);
    const output = (t.output || 0) + (live.output || 0);
    const cacheRead = (t.cacheRead || 0) + (live.cacheRead || 0);
    const cacheWrite = (t.cacheWrite || 0) + (live.cacheWrite || 0);
    const turns = (t.n || 0) + (live.turns || 0);
    const steps = (t.steps || 0) + liveSteps;

    const models = db.prepare(
      `SELECT model_id, COUNT(*) AS reqs, SUM(output_tokens) AS output,
              SUM(input_tokens) AS promptSide,
              SUM(cache_read_input_tokens) AS cacheRead,
              SUM(duration_ms) AS dur,
              SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN time_to_first_token_ms ELSE 0 END) AS ttft
       FROM model_usage WHERE session_id = ? AND output_tokens > 0
       GROUP BY model_id ORDER BY output DESC`
    ).all(sid);

    // 关键口径：ZCode 的 input_tokens 是完整 prompt 总量，
    // cache_read / cache_creation 只是其中的子集，不能相加（相加会把命中率稀释到 ~50%）
    const uncachedInput = Math.max(0, input - cacheRead - cacheWrite);
    const total = input + output;
    let out = 0, decodeMs = 0;
    for (const m of models) { out += m.output || 0; const d = (m.dur || 0) - (m.ttft || 0); decodeMs += d > 0 ? d : 0; }
    const speed = decodeMs > 0 && out > 0 ? Math.max(1, Math.round(out / (decodeMs / 1000))) : null;
    const llmMs = models.reduce((a, m) => a + (m.dur || 0), 0);
    const toolMs = db.prepare("SELECT SUM(duration_ms) AS dur FROM tool_usage WHERE session_id = ?").get(sid).dur || 0;

    const ttftSteps = (t.ttftSteps || 0) + (live.ttftSteps || 0);
    const ttftMs = ttftSteps > 0 ? ((t.ttftAvg || 0) * (t.ttftSteps || 0) + (live.ttft || 0)) / ttftSteps : 0;

    // 上下文：最近一次真实发出的 prompt 侧（取它所在轮次里的最大单次请求）。
    // 注意不能退回 turn_usage.input_tokens —— 那是整轮所有请求的累加，会算出 14M/512k 这种假数值。
    let ctxTokens = 0;
    const lastPrompted = db.prepare(
      "SELECT turn_id FROM model_usage WHERE session_id = ? AND input_tokens > 0 ORDER BY started_at DESC, rowid DESC LIMIT 1"
    ).get(sid);
    if (lastPrompted) {
      ctxTokens = db.prepare(
        `SELECT MAX(input_tokens) AS p
         FROM model_usage WHERE session_id = ? AND turn_id = ?`
      ).get(sid, lastPrompted.turn_id).p || 0;
    }

    // 上下文上限跟着“当前会话实际在跑的模型”走（ZCode 是 per-model 配置）
    const model = currentModel(db, sid);
    const ctx = resolveContextLimit(model);

    return {
      title: session.title || "",
      // 活动胶囊（含进行中轮次）
      turns, steps, speed,
      llmMs, toolMs, ttftMs, ttftSteps,
      // 用量胶囊（含进行中轮次）
      totalTokens: total,
      inputTokens: input, uncachedInputTokens: uncachedInput, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output,
      cacheHit: fmtPercent(cacheRead, input),
      // 上下文
      ctxTokens, ctxLimit: ctx.limit, ctxLimitSource: ctx.source, ctxModel: model.modelId || "",
      ctxPct: ctxTokens > 0 ? Math.min(100, fmtPercent(ctxTokens, ctx.limit)) : 0,
      // 模型明细
      models: models.map((m) => ({
        id: m.model_id, reqs: m.reqs, output: m.output || 0,
        promptSide: m.promptSide || 0, cacheRead: m.cacheRead || 0,
      })),
      updatedAt: Date.now(),
    };
  } catch { return null; } finally { try { db.close(); } catch {} }
}

// ---------- 页面端脚本（常驻：锚点 + 胶囊 + 点击对话框） ----------
const PAGE_INSTALLER = String.raw`
(function () {
  // 无守卫：每次推送都用最新逻辑覆盖（自愈旧版本残留），元素按 id 复用
  const ID = "zstb-bar", DLG = "zstb-dialog";
  let bar = null, dlg = null, dlgOpenFor = null;
  // 识别当前会话：ZCode 在 DOM 上暴露 data-session-id；切换会话立即唤醒控制器
  try {
    const sidEl = document.querySelector('[data-session-id]');
    const sid = sidEl && sidEl.getAttribute('data-session-id');
    if (sid) {
      if (window.__zstbSession) window.__zstbSession(sid);
      if (window.__zstbSeenSession && window.__zstbSeenSession !== sid && window.__zstbWake) window.__zstbWake('session');
      window.__zstbSeenSession = sid;
    }
  } catch (e) {}
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function fmtTok(n) {
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return Math.round(n / 1e3) + 'k';
    return String(Math.round(n));
  }
  function fmtDur(ms) {
    if (!ms || ms <= 0) return '0秒';
    const s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10) + '秒';
    const w = Math.round(s);
    return Math.floor(w / 60) + '分' + (w % 60) + '秒';
  }
  // 对齐 DSH 原生 StatsPills：无底色、无描边，只保留文字与前置图标；悬浮时才出现浅色反馈
  const PILL = 'display:inline-flex;align-items:center;gap:6px;background:transparent;border:none;border-radius:6px;padding:1px 8px;color:color-mix(in srgb, var(--foreground, #222) 76%, transparent);cursor:pointer;font:inherit;font-weight:500;white-space:nowrap;';
  function pill(txt, tip, meter, key) {
    return '<button data-zstb-pill="' + key + '" title="' + esc(tip) + '" style="' + PILL + '">' +
      (meter !== undefined
        ? '<span style="width:52px;height:4px;border-radius:999px;background:color-mix(in srgb, currentColor 18%, transparent);overflow:hidden;display:inline-block"><span style="display:block;height:100%;width:' + Math.min(100, meter) + '%;background:var(--primary,#7c8cff)"></span></span>'
        : '<span style="width:6px;height:6px;border-radius:999px;background:var(--primary,#7c8cff)"></span>') +
      '<span>' + txt + '</span></button>';
  }
  function row(label, value, weight) {
    // 视觉均衡：字重越粗同色越显深，数值列降到 74% 混合补偿，字重按内容传参；
    // CJK 数值（X分X秒）字形笔画粗，用 500；纯数字（Token 用量）用 600
    const w = weight || 600;
    return '<div style="display:flex;justify-content:space-between;gap:24px"><span style="color:color-mix(in srgb, var(--foreground,#1a1a1a) 86%, transparent)">' + label + '</span><span style="color:color-mix(in srgb, var(--foreground,#1a1a1a) 74%, transparent);font-weight:' + w + '">' + value + '</span></div>';
  }
  function ctxSourceLabel(s) {
    return s === 'env' ? '手动指定' : s === 'provider' ? '模型配置' : s === 'model' ? '同模型目录' : '默认值';
  }
  function dialogHTML(key, d) {
    let rows = '', title = '';
    if (key === 'activity') {
      title = '会话统计';
      // 数值含 CJK（X分X秒/X轮X步），字形笔画粗，字重降到 500 保持与标签观感均衡
      rows = row('模型用时', fmtDur(d.llmMs), 500) + row('工具调用用时', fmtDur(d.toolMs), 500) +
        (d.ttftSteps > 0 ? row('首 token 平均（TTFT）', fmtDur(d.ttftMs), 500) : '') +
        (d.speed ? row('输出速度（TPS）', d.speed + ' tok/s', 500) : '') + row('轮次 / 步骤', d.turns + ' 轮 ' + (d.steps || 0) + ' 步', 500);
    } else if (key === 'usage') {
      title = 'Token 用量';
      rows = row('总量（精确 ' + Number(d.totalTokens).toLocaleString() + '）', fmtTok(d.totalTokens) + ' tok') +
        (d.cacheHit != null ? row('缓存命中', d.cacheHit + '%') : '') +
        row('未命中输入', Number(d.uncachedInputTokens != null ? d.uncachedInputTokens : Math.max(0, (d.inputTokens || 0) - (d.cacheReadTokens || 0) - (d.cacheWriteTokens || 0))).toLocaleString()) +
        row('缓存读', Number(d.cacheReadTokens).toLocaleString()) +
        row('缓存写', Number(d.cacheWriteTokens).toLocaleString()) +
        row('输出', Number(d.outputTokens).toLocaleString());
    } else if (key === 'context') {
      title = '上下文';
      rows = row('最近一轮 prompt 侧', fmtTok(d.ctxTokens) + ' tok') +
        row('上下文上限', fmtTok(d.ctxLimit) + ' tok') +
        row('占比', d.ctxPct + '%');
    }
    return '<div style="min-width:260px;max-width:340px"><div style="font-weight:700;margin-bottom:6px;color:var(--foreground,#1a1a1a)">' + title +
      '</div><div style="height:1px;background:var(--border,#3338);margin:4px 0 8px"></div>' + rows +
      '<div style="margin-top:8px;font-size:10px;color:var(--muted-foreground,#899)">数据时间 ' + new Date(d.updatedAt).toLocaleTimeString() + ' · 来自本地数据库只读查询</div>' +
      (key === 'context' ? '<div style="font-size:10px;color:var(--muted-foreground,#899)">上限识别：' + (d.ctxModel || '未知模型') + ' · ' + ctxSourceLabel(d.ctxLimitSource) + '</div>' : '') +
      '</div>';
  }
  function openDlg(key, d, anchorEl) {
    closeDlg();
    dlg = document.createElement('div');
    dlg.id = DLG;
    dlg.setAttribute('role', 'dialog');
    dlg.style.cssText = 'position:absolute;z-index:2147483001;background:var(--card,#fff);border:1px solid var(--border,#e5e5e5);border-radius:10px;padding:10px 12px;font:12px/1.7 "Segoe UI",system-ui,sans-serif;box-shadow:0 6px 24px #0003;font-size:12px;visibility:hidden;';
    dlg.innerHTML = dialogHTML(key, d);
    document.body.appendChild(dlg);
    const r = anchorEl.getBoundingClientRect();
    dlg.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 360)) + 'px';
    // 默认向上弹出（统计条贴着输入框，下方没有空间）；上方放不下才改向下
    const h = dlg.offsetHeight;
    const aboveTop = r.top - h - 8 + window.scrollY;
    dlg.style.top = (aboveTop >= 8 ? aboveTop : r.bottom + 8 + window.scrollY) + 'px';
    dlg.style.visibility = 'visible';
    dlgOpenFor = key;
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  }
  function closeDlg() {
    if (dlg) { dlg.remove(); dlg = null; }
    dlgOpenFor = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }
  function onOutside(e) { if (dlg && !dlg.contains(e.target)) closeDlg(); }
  function onEsc(e) { if (e.key === 'Escape') closeDlg(); }
  const STYLE_ID = 'zstb-style';
  function ensureStyle() {
    let st = document.getElementById(STYLE_ID);
    if (!st) { st = document.createElement('style'); st.id = STYLE_ID; (document.head || document.documentElement).appendChild(st); }
    st.textContent = '#zstb-bar [data-zstb-pill]{transition:background-color .12s ease,color .12s ease}' +
      '#zstb-bar [data-zstb-pill]:hover{background:color-mix(in srgb, var(--foreground,#222) 7%, transparent) !important;color:var(--foreground,#222) !important}' +
      '#zstb-bar [data-zstb-pill]:active{background:color-mix(in srgb, var(--foreground,#222) 11%, transparent) !important}' +
      '#zstb-bar [data-zstb-pill]:focus-visible{outline:2px solid var(--primary,#7c8cff);outline-offset:1px}' +
      '#zstb-bar [data-zstb-refresh]{transition:background-color .12s ease,color .12s ease}' +
      '#zstb-bar [data-zstb-refresh]:hover{background:color-mix(in srgb, var(--foreground,#222) 7%, transparent) !important;color:var(--foreground,#222) !important}' +
      '#zstb-bar [data-zstb-refresh]:active{background:color-mix(in srgb, var(--foreground,#222) 11%, transparent) !important}' +
      '#zstb-bar [data-zstb-refresh]:focus-visible{outline:2px solid var(--primary,#7c8cff);outline-offset:1px}';
  }
  function render(d) {
    ensureStyle();
    const parts = [];
    if (d.turns) parts.push(pill(d.turns + ' 轮 ' + (d.steps || 0) + ' 步' + (d.speed ? ' · ' + d.speed + ' tok/s' : ''), '点击查看用时与速度明细', undefined, 'activity'));
    if (d.totalTokens > 0) parts.push(pill(fmtTok(d.totalTokens) + ' tok' + (d.cacheHit != null ? ' · 缓存命中 ' + d.cacheHit + '%' : ''), '点击查看 Token 分桶', undefined, 'usage'));
    if (d.ctxTokens > 0) parts.push(pill('上下文 ' + d.ctxPct + '%', '点击查看上下文明细 · 上限 ' + fmtTok(d.ctxLimit) + ' tok' + (d.ctxModel ? '（' + ctxSourceLabel(d.ctxLimitSource) + '）' : ''), d.ctxPct, 'context'));
    // 模型明细已去掉：ZCode 客户端自带（输入框右侧模型选择器）
    // 刷新标记与胶囊同字号、同字重，仅在垂直方向居中
    parts.push('<button type="button" data-zstb-refresh title="每 5 秒自动刷新 · 点击立即刷新" style="display:inline-flex;align-items:center;gap:4px;padding:1px 8px;background:transparent;border:none;border-radius:6px;font:inherit;font-weight:500;color:color-mix(in srgb, var(--foreground,#222) 62%, transparent);cursor:pointer;">⟳ 5s</button>');
    bar.innerHTML = parts.join('');
    bar.querySelectorAll('[data-zstb-pill]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const k = el.getAttribute('data-zstb-pill');
        if (dlgOpenFor === k) { closeDlg(); return; }
        openDlg(k, window.__zstbData || d, el);
      });
    });
    const rf = bar.querySelector('[data-zstb-refresh]');
    if (rf) {
      rf.addEventListener('click', (ev) => {
        ev.stopPropagation();
        try { if (window.__zstbWake) window.__zstbWake('refresh'); } catch (e) {}
        rf.textContent = '⟳ 刷新中';
      });
    }
  }
  function baseStyle() {
    // 紧凑行高（1.4）+ 无纵向 padding：卡片下方往往只有 ~22px 空隙，条高必须 ≤18px 才放得下
    return 'display:flex;gap:2px;align-items:center;justify-content:center;font:12px/1.4 "Segoe UI",system-ui,sans-serif;padding:0 12px;color:var(--foreground,#222);flex-wrap:wrap;user-select:none;background:transparent;border:0;box-shadow:none;';
  }
  function composerRect() {
    // ZCode 的输入框是 contenteditable DIV（不是 textarea）；两类都找，取可见里最宽的
    const sel = '[contenteditable="true"],[contenteditable=""],textarea';
    const cands = [...document.querySelectorAll(sel)]
      .filter((t) => t.offsetParent !== null)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    if (!cands.length) return null;
    // composer 卡片特征（CDP 实测）：最小祖先里首个「圆角≥6 或有阴影/描边、宽≥380、
    // 高<80% 视口」的容器——它包含输入框 + 底部工具行，bottom 才是卡片真实底边。
    // 不再用高度区间判断：长内容会把卡片撑到 300px 以上，区间法会锚错层。
    const isCard = (el) => {
      const cs = getComputedStyle(el);
      return (parseFloat(cs.borderTopLeftRadius) >= 6 || (cs.boxShadow && cs.boxShadow !== 'none') || parseFloat(cs.borderTopWidth) > 0);
    };
    let cur = cands[0], plain = null;
    for (let i = 0; i < 10 && cur.parentElement; i++) {
      cur = cur.parentElement;
      const pr = cur.getBoundingClientRect();
      // display:contents 等透明包装层矩形为 0，跳过（不能 break，真卡片在其上层）
      if (pr.width < 8 && pr.height < 8) continue;
      if (pr.width < 380 || pr.height >= window.innerHeight * 0.8) break;
      if (isCard(cur)) return pr;
      if (!plain && pr.height >= 60) plain = pr; // 兜底：样式特征识别不到时取第一个像面板的祖先
    }
    return plain;
  }
  function place() {
    const cr = composerRect();
    if (!cr) return false;
    // 无底色：胶囊直接浮在应用背景上（对齐 DSH 胶囊 UI），水平居中对齐 composer
    bar.style.cssText = baseStyle() +
      'position:fixed;z-index:2147483000;';
    bar.style.left = Math.max(8, cr.left) + 'px';
    bar.style.width = Math.min(cr.width, window.innerWidth - 16) + 'px';
    // 优先放卡片正下方；下方空间不足时改放卡片上方（只盖消息列表底部），
    // 绝不能垂直夹取压回卡片——工具行就在卡片底部，夹取必然与它重合（实测复现过）。
    const h = Math.max(bar.offsetHeight || 0, 20);
    // 上移 3px 视觉居中：条盒透明，与卡片边框重叠 1px 不可见，字形与卡片留出呼吸感
    let top = cr.bottom - 1;
    if (top + h > window.innerHeight - 1) {
      top = cr.top - h - 4;
      if (top < 4) top = Math.max(4, window.innerHeight - 2 - h);
    }
    bar.style.top = top + 'px';
    return true;
  }
  function fallbackFloat() {
    bar.style.cssText = baseStyle() +
      'position:fixed;left:50%;transform:translateX(-50%);bottom:6px;z-index:2147483000;';
  }
  function ensureBar() {
    bar = document.getElementById(ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = ID;
      bar.setAttribute('aria-label', '会话统计条（CDP 注入）');
      (document.body || document.documentElement).appendChild(bar);
    }
  }
  // 输入框高度随内容实时变化（长文本换行、工具行增减），只靠 5s 推送重定位会与输入框重合：
  // 用 ResizeObserver 跟踪输入框到卡片整条祖先链 + window resize，任何一层变形都立刻重锚。
  // React 可能重建 composer 元素，观察目标需要跟随，这里低频轮询换绑（与 5s 推送互不依赖）。
  function watchComposer() {
    if (window.__zstbWatchInstalled) return;
    window.__zstbWatchInstalled = true;
    const reflow = () => { try { if (bar) place() || fallbackFloat(); } catch (e) {} };
    window.addEventListener('resize', reflow);
    let ro = null, lastChain = '';
    setInterval(() => {
      try {
        const el = [...document.querySelectorAll('[contenteditable="true"],[contenteditable=""],textarea')]
          .find((t) => t.offsetParent !== null);
        // 观察链：输入框 + 上层有效祖先（跳过 display:contents 零矩形层，最多 6 层到卡片）
        const chain = [];
        let cur = el;
        for (let i = 0; cur && i < 8; i++) {
          const r = cur.getBoundingClientRect ? cur.getBoundingClientRect() : { width: 0, height: 0 };
          if (!((r.width < 8 && r.height < 8) || i > 0 && r.width < 380)) chain.push(cur);
          if (i > 0 && r.width >= 380 && r.height < window.innerHeight * 0.8) {
            const cs = getComputedStyle(cur);
            if (parseFloat(cs.borderTopLeftRadius) >= 6 || (cs.boxShadow && cs.boxShadow !== 'none')) break; // 到卡片为止
          }
          cur = cur.parentElement;
        }
        const sig = chain.map((e) => e.tagName + ':' + (e.className || '')).join('|');
        if (sig !== lastChain) {
          lastChain = sig;
          if (ro) ro.disconnect();
          if (chain.length) { ro = ro || new ResizeObserver(reflow); chain.forEach((e) => ro.observe(e)); }
          reflow();
        }
      } catch (e) {}
    }, 800);
  }
  window.__zstbUpdate = function (d) {
    try {
      window.__zstbData = d;
      ensureBar();
      // 空会话（刚新建/还没有任何模型请求）整条隐藏：只渲染 ⟳5s 的残条看起来像坏了
      const hasData = d && (d.turns || d.totalTokens > 0);
      if (!hasData) { bar.style.display = 'none'; return; }
      bar.style.display = '';
      watchComposer();
      render(d);                       // 先渲染拿到真实高度
      if (!place()) fallbackFloat();   // 再定位（推送 + 尺寸变化双触发），避免底部被窗口裁切
    } catch (e) { /* 页面过渡期丢弃 */ }
  };
})();
`;

// ---------- CDP 连接管理 ----------
const conns = new Map(); // targetId -> WebSocket
let lastPayload = "";
let activeSessionId = null; // 页面 DOM 上报的当前会话

function log(...a) { console.log(new Date().toLocaleTimeString(), "[cdp-bar]", ...a); }

async function listPages() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
    const list = await res.json();
    return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !/^devtools:/i.test(t.url || ""));
  } catch { return []; }
}

function pushTo(ws, payload) {
  send(ws, 1, "Runtime.evaluate", { expression: PAGE_INSTALLER, silent: true });
  send(ws, 2, "Runtime.evaluate", {
    expression: `window.__zstbUpdate && window.__zstbUpdate(${JSON.stringify(payload)})`,
    silent: true,
    returnByValue: true,
  });
}
function send(ws, id, method, params) {
  ws.send(JSON.stringify({ id, method, params }));
}

let ticking = false;
let refreshQueued = false;
function requestRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  let tries = 0;
  const run = () => {
    if (ticking && tries++ < 20) { setTimeout(run, 50); return; }
    refreshQueued = false;
    tick().catch(() => {});
  };
  setTimeout(run, 30);
}

// ---------- 端口丢失自愈：ZCode 更新器重启后不带调试端口，此处检测并带端口重启 ----------
const HEAL_ENABLED = process.env.ZSTB_HEAL !== "0";
const ZCODE_IMAGE = process.env.ZSTB_ZCODE_IMAGE || "ZCode.exe";
const ZCODE_EXE_CANDIDATES = [
  process.env.ZSTB_ZCODE_EXE,
  "D:\\ZCode\\ZCode.exe",
  join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "ZCode.exe"),
].filter(Boolean);
const HEAL_TICKS = Number(process.env.ZSTB_HEAL_TICKS) || 3;          // 连续失联 N 个 tick 才动手
const HEAL_MAX = Number(process.env.ZSTB_HEAL_MAX) || 3;              // 放弃上限（防无限杀循环）
const HEAL_COOLDOWN_MS = Number(process.env.ZSTB_HEAL_COOLDOWN_MS) || 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let healMisses = 0, healAttempts = 0, healNextAt = 0, healGaveUp = false;
function zcodeRunning() {
  try {
    return execSync(`tasklist /FI "IMAGENAME eq ${ZCODE_IMAGE}" /NH`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .toLowerCase().includes(ZCODE_IMAGE.toLowerCase());
  } catch { return false; }
}
async function maybeHeal(pages) {
  if (!HEAL_ENABLED) return;
  if (pages.length > 0 || !zcodeRunning()) {
    // 端口恢复即重置预算：3 次上限是"每个失效期"而非控制器终生，否则一次放弃永久罢工
    if (pages.length > 0 && (healAttempts || healGaveUp)) { healAttempts = 0; healGaveUp = false; }
    healMisses = 0;
    return; // 端口通，或 ZCode 没跑（用户主动关闭）都不插手
  }
  if (Date.now() < healNextAt) return;
  if (++healMisses < HEAL_TICKS) return;
  healMisses = 0;
  if (healAttempts >= HEAL_MAX) {
    if (!healGaveUp) { healGaveUp = true; const m = `自愈放弃：已尝试 ${healAttempts} 次端口仍不通，请手动排查 ${PORT} 端口占用`; flog(m); log(m); }
    return;
  }
  healAttempts++;
  healNextAt = Date.now() + HEAL_COOLDOWN_MS;
  const exe = ZCODE_EXE_CANDIDATES.find((p) => existsSync(p));
  if (!exe) { const m = `自愈中断：未找到 ZCode.exe（候选：${ZCODE_EXE_CANDIDATES.join("; ")}），可用 ZSTB_ZCODE_EXE 指定`; flog(m); log(m); return; }
  const m1 = `自愈：${ZCODE_IMAGE} 在运行但调试端口 ${PORT} 不通（如更新器重启所致），带端口重启 ZCode（第 ${healAttempts}/${HEAL_MAX} 次）`;
  flog(m1); log(m1);
  try { execSync(`taskkill /IM ${ZCODE_IMAGE} /F`, { stdio: "ignore" }); } catch {}
  await sleep(3000);
  try {
    const ch = spawnProc(exe, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: "ignore" });
    ch.unref();
    const m2 = `自愈：ZCode 已带端口重启（${exe}）`;
    flog(m2); log(m2);
  } catch (e) { flog("自愈失败:", e?.message); log("自愈失败:", e?.message); }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
  const pages = await listPages();
  await maybeHeal(pages);
  const stats = computeStats(activeSessionId);
  if (!stats) return;
  const payload = JSON.stringify(stats);
  const live = new Set();
  for (const p of pages) {
    live.add(p.id);
    let ws = conns.get(p.id);
    if (!ws || ws.readyState !== 1) {
      ws = new WebSocket(p.webSocketDebuggerUrl);
      ws.addEventListener("error", () => {});
      ws.addEventListener("open", () => {
        try {
          send(ws, 101, "Runtime.enable");
          send(ws, 102, "Runtime.addBinding", { name: "__zstbWake" });
          send(ws, 103, "Runtime.addBinding", { name: "__zstbSession" });
        } catch {}
      });
      ws.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.method === "Runtime.bindingCalled" && msg.params) {
            const name = msg.params.name;
            const payload = msg.params.payload;
            if (name === "__zstbSession" && typeof payload === "string" && payload) {
              if (payload !== activeSessionId) { activeSessionId = payload; requestRefresh(); }
            } else if (name === "__zstbWake") {
              requestRefresh();
            }
          }
        } catch {}
      });
      conns.set(p.id, ws);
      log("连接渲染进程:", (p.title || p.url || "").slice(0, 60));
    }
    try { pushTo(ws, stats); } catch { /* 连接过渡期 */ }
  }
  for (const id of [...conns.keys()]) {
    if (!live.has(id)) conns.delete(id);
  }
  lastPayload = payload;
  } finally { ticking = false; }
}

// ---------- 崩溃自愈：任何未捕获异常记录到日志并继续运行 ----------
const LOG_FILE = join(dirname(PID_FILE), "controller.log");
function flog(...a) {
  try { appendFileSync(LOG_FILE, new Date().toISOString() + " " + a.join(" ") + "\n"); } catch {}
}
process.on("uncaughtException", (e) => { flog("uncaughtException:", e?.stack || e); log("异常已捕获:", e?.message); });
process.on("unhandledRejection", (e) => { flog("unhandledRejection:", e?.stack || e?.message || e); log("拒绝已捕获:", e?.message || e); });

log(`session-stats CDP 控制器启动：port=${PORT} interval=${INTERVAL}ms db=${DB_PATH}`);
log(`等待 ZCode 以 --remote-debugging-port=${PORT} 启动…`);
setInterval(() => tick().catch((e) => log("tick 失败:", e.message)), INTERVAL);
tick().catch(() => {});
