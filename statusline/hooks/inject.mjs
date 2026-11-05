#!/usr/bin/env node
// UserPromptSubmit 钩子：注入「状态栏指令」。
// ZCode 没有插件可写的界面扩展点，钩子输出里只有 additionalContext 会进入会话；
// 让状态行出现在界面里的唯一通道，是让模型在收尾时把用量脚本的输出原样写成回复最后一行。
// 本钩子把当前会话 ID 与脚本绝对路径固化进指令，模型收尾时无需自行解析。
// 输出必须是严格 JSON。

import fs from "node:fs";
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

  const cmd = `node "${SCRIPT}"${sid ? ` --session ${sid}` : ""}`;
  emit(
    [
      "【状态栏指令·附加行】请先照常完整回答用户的问题，不要因本指令省略、缩减或折叠任何回答内容；",
      "在全部回答内容输出完毕后，追加本次回复的最后一行：原样输出下面这条命令打印的那一行",
      "（纯文本一行，不加引号、不加代码块、其后不再有任何内容；命令没有输出就不加）：",
      cmd,
      "它只读查询 ZCode 本地 usage 数据库，给出本轮真实用量：轮数、步数、tok/s、token 总量、缓存命中率与上下文占比。若用户明确要求不要附加任何内容，则不执行。",
    ].join("\n")
  );
} catch {
  emit("");
}
process.exit(0);
