#!/usr/bin/env node
// UserPromptSubmit 钩子：预计算状态行并注入「附加行指令」。
//
// 为什么不让模型自己跑命令：命令是工具调用，ZCode 会把最后一次工具调用之前的
// 全部回复内容折叠进「已工作 X 分 X 秒」，导致正文不可见（实测复现）。
// 改为本钩子在提问时刻直接运行用量脚本，把结果作为字面文本注入指令，
// 模型零工具调用、纯文字回复，正文与状态行都能完整显示。
// 代价：数据定格在提问时刻，不含本轮进行中的增量——对状态行可接受。
// 输出必须是严格 JSON。

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "usage-line.mjs");

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(raw); } };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", finish);
    setTimeout(finish, 1500); // 客户端不给 stdin 时不挂起
  });
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })
  );
}

try {
  let sid = "";
  try {
    const payload = JSON.parse((await readStdin()) || "{}");
    sid = payload.session_id || "";
  } catch {}
  sid = sid || process.env.ZCODE_SESSION_ID || "";

  // 预计算状态行（复用与悬浮条同口径的用量脚本；无数据时输出为空 → 不注入指令）
  const r = spawnSync(process.execPath, [SCRIPT, ...(sid ? ["--session", sid] : [])], {
    timeout: 5000,
    encoding: "utf8",
  });
  const line = (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  if (!line) {
    emit("");
    process.exit(0);
  }

  emit(
    [
      "【状态栏·附加行】请照常完整回答用户，不要因本指令省略、缩减或折叠任何回答内容；",
      "全部回答内容输出完毕后，在本次回复的最后一行原样输出下面这一行",
      "（纯文本一行，不加引号、不加代码块、数字不要改写、其后不再有任何内容）：",
      line,
      "这是预先从本地 usage 数据库读取的本会话真实用量。若用户明确要求不要附加任何内容，则不输出这一行。",
    ].join("\n")
  );
} catch {
  emit("");
}
process.exit(0);
