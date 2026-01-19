"use strict";

const fs = require("fs");
const path = require("path");

const { debug } = require("../../infra/log");
const { nowMs } = require("../../infra/trace");
const { normalizeString, randomId } = require("../../infra/util");

const shared = require("../augment-chat.shared");
const { sampleJsonFromSchema } = require("./schema-sample");
const { dedupeToolDefsByName } = require("./tool-defs");

function normalizeFsPath(p) {
  const s = normalizeString(p);
  if (!s) return "";
  return s.replace(/\\/g, "/");
}

async function ensureDir(dirPath) {
  const p = normalizeString(dirPath);
  if (!p) return false;
  await fs.promises.mkdir(p, { recursive: true });
  return true;
}

async function writeFileText(filePath, content) {
  const p = normalizeString(filePath);
  if (!p) throw new Error("filePath empty");
  await ensureDir(path.dirname(p));
  await fs.promises.writeFile(p, String(content ?? ""), "utf8");
  return true;
}

async function readFileText(filePath) {
  const p = normalizeString(filePath);
  if (!p) throw new Error("filePath empty");
  return await fs.promises.readFile(p, "utf8");
}

async function pathExists(filePath) {
  try {
    await fs.promises.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function rmPathRecursive(p) {
  const target = normalizeString(p);
  if (!target) return;
  // Node 18+ supports fs.promises.rm; VSCode extension host一般是 Node 18+，但这里做一次兼容兜底。
  try {
    if (typeof fs.promises.rm === "function") {
      await fs.promises.rm(target, { recursive: true, force: true });
      return;
    }
  } catch {}
  try {
    const st = await fs.promises.stat(target);
    if (st.isDirectory()) {
      const entries = await fs.promises.readdir(target);
      await Promise.all(entries.map((name) => rmPathRecursive(path.join(target, name))));
      await fs.promises.rmdir(target).catch(() => void 0);
    } else {
      await fs.promises.unlink(target).catch(() => void 0);
    }
  } catch {}
}

function getByokUpstreamGlobals() {
  const g = typeof globalThis !== "undefined" ? globalThis : null;
  const u = g && g.__augment_byok_upstream && typeof g.__augment_byok_upstream === "object" ? g.__augment_byok_upstream : null;
  return { global: g, upstream: u };
}

function isToolsModelCandidate(v) {
  return v && typeof v === "object" && typeof v.getToolDefinitions === "function" && typeof v.callTool === "function";
}

function findToolsModelDeep(root, { maxDepth = 4, maxNodes = 2000 } = {}) {
  const start = root && typeof root === "object" ? root : null;
  if (!start) return null;
  if (isToolsModelCandidate(start)) return start;

  const q = [{ v: start, d: 0 }];
  const seen = new Set();

  const push = (v, d) => {
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) return;
    if (seen.size >= maxNodes) return;
    seen.add(v);
    q.push({ v, d });
  };

  while (q.length) {
    const cur = q.shift();
    const v = cur?.v;
    const d = Number(cur?.d) || 0;
    if (!v || typeof v !== "object") continue;
    if (isToolsModelCandidate(v)) return v;
    if (d >= maxDepth) continue;

    let keys = [];
    try {
      keys = Object.keys(v);
    } catch {
      keys = [];
    }
    for (const k of keys) {
      let child;
      try {
        child = v[k];
      } catch {
        child = null;
      }
      if (!child || typeof child !== "object") continue;
      if (isToolsModelCandidate(child)) return child;
      push(child, d + 1);
    }
  }

  return null;
}

function getToolsModelFromUpstreamOrNull() {
  const { upstream } = getByokUpstreamGlobals();
  const direct = upstream?.toolsModel;
  if (isToolsModelCandidate(direct)) return direct;
  const ext = upstream?.augmentExtension;
  return findToolsModelDeep(ext, { maxDepth: 5, maxNodes: 4000 }) || findToolsModelDeep(upstream, { maxDepth: 4, maxNodes: 4000 });
}

async function fetchLocalToolDefinitionsFromUpstream({ timeoutMs, abortSignal, log } = {}) {
  const emit = (line) => {
    try {
      if (typeof log === "function") log(String(line || ""));
    } catch {}
  };

  const { upstream } = getByokUpstreamGlobals();
  const maybeExt = upstream?.augmentExtension;
  const direct = upstream?.toolsModel;

  const toolsModel =
    (isToolsModelCandidate(direct) && direct) ||
    findToolsModelDeep(maybeExt, { maxDepth: 5, maxNodes: 4000 }) ||
    findToolsModelDeep(upstream, { maxDepth: 4, maxNodes: 4000 });

  if (!toolsModel) {
    debug("[self-test] upstream toolsModel not exposed/found");
    return { ok: false, detail: "upstream toolsModel not exposed/found" };
  }

  // 这里不做超时强杀（工具定义拉取通常较快）；由外层 Self Test abortSignal 兜底。
  const defsRaw = await toolsModel.getToolDefinitions();
  const list = Array.isArray(defsRaw) ? defsRaw : [];
  const defs = [];
  const seen = new Set();
  for (const it of list) {
    const def = it && typeof it === "object" ? it.definition ?? it.toolDefinition ?? it : null;
    if (!def || typeof def !== "object") continue;
    const name = normalizeString(def?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    defs.push(def);
  }

  const count = defs.length;
  if (!count) {
    emit("[captured tools] upstream toolsModel.getToolDefinitions 返回空列表（可能未初始化/无可用工具/或上游变更）");
    debug("[self-test] upstream toolsModel.getToolDefinitions empty list");
    return { ok: false, detail: "empty list" };
  }
  debug(`[self-test] upstream toolsModel.getToolDefinitions ok tools=${count}`);

  return {
    ok: true,
    toolsModel,
    defs,
    detail: `tools=${count}`,
    meta: {
      source: "upstream(toolsModel)",
      count,
      capturedAtMs: nowMs(),
      // 可选：方便排查（不是严格契约）
      hasAugmentExtensionRef: Boolean(maybeExt),
      hasDirectToolsModelRef: Boolean(direct)
    }
  };
}

function extractExactStringRequirementFromSchema(propSchema) {
  const desc = normalizeString(propSchema?.description);
  if (!desc) return "";
  const m = desc.match(/exactly this string:\s*'([^']+)'/i) || desc.match(/exactly this string:\s*"([^"]+)"/i);
  return m ? String(m[1] || "").trim() : "";
}

function buildToolInputFromSchema(toolDef, { overrides, defaults } = {}) {
  const schema = shared.resolveToolSchema(toolDef);
  const props = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required.map((x) => normalizeString(x)).filter(Boolean) : [];

  const out = {};
  const hasProp = (k) => Object.prototype.hasOwnProperty.call(props, k);
  const set = (k, v) => {
    if (!k || !hasProp(k)) return false;
    out[k] = v;
    return true;
  };

  // 1) 先填 required（否则部分工具会直接拒绝）
  for (const k of required) {
    if (!k || !hasProp(k)) continue;
    out[k] = sampleJsonFromSchema(props[k], 0);
  }

  // 2) 对 reminder 类字段，尝试从 schema.description 中解析出“必须完全一致”的字符串
  for (const k of required) {
    if (!k) continue;
    if (!/reminder/i.test(k)) continue;
    const expected = extractExactStringRequirementFromSchema(props[k]);
    if (expected) set(k, expected);
  }

  // 3) defaults（安全的“环境默认值”）
  const d = defaults && typeof defaults === "object" ? defaults : {};
  for (const [k, v] of Object.entries(d)) {
    if (hasProp(k) && out[k] == null) out[k] = v;
  }

  // 4) overrides（测试用例强制覆盖）
  const o = overrides && typeof overrides === "object" ? overrides : {};
  for (const [k, v] of Object.entries(o)) set(k, v);

  return out;
}

function summarizeToolResult(res, { maxLen = 180 } = {}) {
  const isError = Boolean(res?.isError ?? res?.is_error);
  const text = typeof res?.text === "string" ? res.text : res?.text != null ? String(res.text) : "";
  const s = text.trim();
  const lim = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 180;
  const preview = s.length > lim ? s.slice(0, lim) + "…" : s;
  const extraKeys = res && typeof res === "object" ? Object.keys(res).filter((k) => !["text", "isError", "is_error"].includes(k)).slice(0, 6) : [];
  return { isError, text: s, preview, extraKeys };
}

function extractReferenceIdFromText(text) {
  const s = normalizeString(text);
  if (!s) return "";
  const patterns = [
    /reference_id\s*[:=]\s*['"]?([A-Za-z0-9_-]{4,})['"]?/i,
    /reference id\s*[:=]\s*['"]?([A-Za-z0-9_-]{4,})['"]?/i,
    /reference-id\s*[:=]\s*['"]?([A-Za-z0-9_-]{4,})['"]?/i,
    /referenceId\s*[:=]\s*['"]?([A-Za-z0-9_-]{4,})['"]?/i,
    /<reference[_-]?id>\s*([A-Za-z0-9_-]{4,})\s*<\/reference[_-]?id>/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return String(m[1]).trim();
  }
  return "";
}

function extractReferenceIdFromToolResult(res) {
  const root = res && typeof res === "object" ? res : null;
  if (!root) return "";

  const directCandidates = [
    root.reference_id,
    root.referenceId,
    root.reference,
    root.ref_id,
    root.refId,
    root.untruncated_reference_id,
    root.untruncatedReferenceId
  ];
  for (const v of directCandidates) {
    const s = normalizeString(v);
    if (s) return s;
  }

  const fromText = extractReferenceIdFromText(root?.text);
  if (fromText) return fromText;

  const seen = new Set();
  const q = [{ v: root, d: 0 }];
  while (q.length) {
    const cur = q.shift();
    const v = cur?.v;
    const d = Number(cur?.d) || 0;
    if (!v || typeof v !== "object") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (d > 6 || seen.size > 3000) break;

    for (const [k, child] of Object.entries(v)) {
      if (!child) continue;
      const key = normalizeString(k).toLowerCase();
      if (key.includes("reference") && (typeof child === "string" || typeof child === "number")) {
        const s = normalizeString(child);
        if (s) return s;
      }
      if (typeof child === "object") q.push({ v: child, d: d + 1 });
    }
  }

  return "";
}

function extractTerminalIdsFromText(text) {
  const s = normalizeString(text);
  if (!s) return [];
  const out = [];
  const re = /Terminal\s+(\d+)/gi;
  for (const m of s.matchAll(re)) {
    const n = Number(m?.[1]);
    if (Number.isFinite(n)) out.push(Math.floor(n));
  }
  return out;
}

function extractTerminalIdsFromToolResult(res) {
  const root = res && typeof res === "object" ? res : null;
  if (!root) return [];

  const ids = new Set();
  for (const n of extractTerminalIdsFromText(root?.text)) ids.add(n);

  const tryAdd = (v) => {
    const n = typeof v === "string" ? Number(v.trim()) : Number(v);
    if (Number.isFinite(n) && n >= 0) ids.add(Math.floor(n));
  };

  // 常见字段
  tryAdd(root?.terminal_id);
  tryAdd(root?.terminalId);
  tryAdd(root?.terminal);
  tryAdd(root?.terminalID);

  // 递归扫描：只在 key 名包含 terminal 时提取数字，避免误伤
  const seen = new Set();
  const q = [{ v: root, d: 0 }];
  while (q.length) {
    const cur = q.shift();
    const v = cur?.v;
    const d = Number(cur?.d) || 0;
    if (!v || typeof v !== "object") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (d > 6 || seen.size > 2000) break;

    for (const [k, child] of Object.entries(v)) {
      if (!child) continue;
      const key = normalizeString(k).toLowerCase();
      if (key.includes("terminal")) {
        if (typeof child === "number" || typeof child === "string") tryAdd(child);
      }
      if (typeof child === "object") q.push({ v: child, d: d + 1 });
    }
  }

  return Array.from(ids.values()).sort((a, b) => a - b);
}

function findTaskUuidInPlan(plan, predicate) {
  const root = plan && typeof plan === "object" ? plan : null;
  if (!root) return "";
  const seen = new Set();
  const q = [root];
  while (q.length) {
    const cur = q.shift();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const uuid = normalizeString(cur.uuid);
    const name = normalizeString(cur.name);
    if (uuid && typeof predicate === "function" && predicate({ uuid, name, node: cur })) return uuid;
    const subs = Array.isArray(cur.subTasksData) ? cur.subTasksData : Array.isArray(cur.sub_tasks_data) ? cur.sub_tasks_data : [];
    for (const st of subs) q.push(st);
  }
  return "";
}

function maybeAugmentAgentsApiHint(errorMessage) {
  const s = normalizeString(errorMessage).toLowerCase();
  if (!s) return "";
  const is404 = s.includes(" 404") || s.includes("404:") || s.includes("not found") || s.includes("route not found");
  if (!is404) return "";
  if (s.includes("agents/check-tool-safety") || s.includes("agents/run-remote-tool") || s.includes("/relay/agents/")) {
    return "（提示：当前 completion_url 指向的服务可能不支持 Augment Agents API（/agents/*）。web-search 等 remote tool 会失败；completion_url 应为 https://<tenant>.augmentcode.com/ 或你的代理需完整实现 Agents 路由。）";
  }
  return "";
}

async function toolsModelCallTool({ toolsModel, toolName, input, conversationId, log, abortSignal } = {}) {
  const emit = (line) => {
    try {
      if (typeof log === "function") log(String(line || ""));
    } catch {}
  };

  const tm = isToolsModelCandidate(toolsModel) ? toolsModel : null;
  const name = normalizeString(toolName);
  if (!tm) return { ok: false, detail: "toolsModel missing" };
  if (!name) return { ok: false, detail: "toolName empty" };

  if (abortSignal && abortSignal.aborted) throw new Error("aborted");

  // 1) 尽可能走上游 safety gating（真实环境一致）
  if (typeof tm.checkToolCallSafe === "function") {
    try {
      const safe = await tm.checkToolCallSafe({ toolName: name, input, agentMode: "auto" });
      if (!safe) return { ok: false, detail: "blocked_by_policy", blocked: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `checkToolCallSafe failed: ${msg}${maybeAugmentAgentsApiHint(msg)}`.trim() };
    }
  }

  // 2) 执行
  const requestId = `byok_selftest_tool_${randomId()}`;
  const toolUseId = `tooluse_${randomId()}`;
  try {
    const res = await tm.callTool(requestId, toolUseId, name, input && typeof input === "object" ? input : {}, [], String(conversationId ?? ""));
    const sum = summarizeToolResult(res, { maxLen: 220 });
    if (sum.isError) {
      emit(`[tool ${name}] FAIL isError=true ${sum.preview ? `preview=${sum.preview}` : ""}`.trim());
      return { ok: false, detail: sum.preview || "isError=true", res };
    }
    emit(`[tool ${name}] ok ${sum.preview ? `preview=${sum.preview}` : ""}`.trim());
    return { ok: true, detail: sum.preview, res };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(`[tool ${name}] FAIL exception=${msg}`);
    return { ok: false, detail: `${msg}${maybeAugmentAgentsApiHint(msg)}`.trim() };
  }
}

async function selfTestToolsModelExec({ toolDefinitions, timeoutMs, abortSignal, log } = {}) {
  const emit = (line) => {
    try {
      if (typeof log === "function") log(String(line || ""));
    } catch {}
  };

  const defs = dedupeToolDefsByName(toolDefinitions);
  const byName = new Map(defs.map((d) => [normalizeString(d?.name), d]).filter((x) => x[0]));
  const toolNames = Array.from(byName.keys()).sort((a, b) => a.localeCompare(b));
  if (!toolNames.length) return { ok: false, ms: 0, detail: "no tools" };

  const toolsModel = getToolsModelFromUpstreamOrNull();
  if (!isToolsModelCandidate(toolsModel)) return { ok: false, ms: 0, detail: "toolsModel not available (need patched upstream)" };

  // workspace root（view/save-file/diagnostics 等都要求 workspace 相对路径）
  let workspaceRoot = "";
  try {
    const vscode = require("vscode");
    const wf = Array.isArray(vscode?.workspace?.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
    workspaceRoot = normalizeString(wf?.[0]?.uri?.fsPath);
  } catch {}
  if (!workspaceRoot) return { ok: false, ms: 0, detail: "no workspace folder (tools require workspace-relative paths)" };

  const runId = randomId();
  const scratchRelDir = normalizeFsPath(path.posix.join("BYOK-test", `run-${runId}`));
  const scratchAbsDir = path.join(workspaceRoot, scratchRelDir);
  const fileRel = normalizeFsPath(path.posix.join(scratchRelDir, "tool_test.txt"));
  const fileAbs = path.join(workspaceRoot, fileRel);
  const bigRel = normalizeFsPath(path.posix.join(scratchRelDir, "big.txt"));
  const bigAbs = path.join(workspaceRoot, bigRel);
  const diagRel = normalizeFsPath(path.posix.join(scratchRelDir, "diag_test.js"));
  const diagAbs = path.join(workspaceRoot, diagRel);

  // toolsModel.callTool 的 conversationId 主要用于 tasklist / rules / telemetry 等“会话绑定”工具。
  // Self Test 不应污染用户真实会话，因此固定使用专用 conversationId。
  const conversationId = "byok-selftest-toolsexec";

  const results = new Map(); // toolName -> {ok, detail}
  const mark = (name, ok, detail) => {
    if (!name) return;
    const nextOk = Boolean(ok);
    const prev = results.get(name);
    // “覆盖”语义：只要有一次成功就算该工具可用；失败只在尚无成功时才记录。
    if (prev && prev.ok === true && nextOk === false) return;
    results.set(name, { ok: nextOk, detail: normalizeString(detail) || "" });
  };

  const callIfPresent = async (name, input) => {
    if (!byName.has(name)) return { ok: true, skipped: true, detail: "tool not in captured list" };
    emit(`[toolsExec] calling ${name} ...`);
    const r = await toolsModelCallTool({ toolsModel, toolName: name, input, conversationId, log, abortSignal });
    mark(name, r.ok, r.detail);
    return r;
  };

  const t0 = nowMs();
  debug(`[self-test][toolsExec] start tools=${toolNames.length}`);
  emit(
    `[toolsExec] start tools=${toolNames.length} workspace=${normalizeFsPath(workspaceRoot)} scratch=${scratchRelDir} conversationId=${conversationId}`
  );

  try {
    await ensureDir(scratchAbsDir);

    // 1) save-file：创建测试文件
    const fileContent = ["BYOK-TEST-LINE-1", "BYOK-TEST-LINE-2", "BYOK-TEST-LINE-3"].join("\n") + "\n";
    const saveDef = byName.get("save-file");
    if (saveDef) {
      const saveInput = buildToolInputFromSchema(saveDef, {
        overrides: { path: fileRel, file_content: fileContent, add_last_line_newline: true }
      });
      await callIfPresent("save-file", saveInput);
      if (!(await pathExists(fileAbs))) throw new Error("save-file succeeded but file missing");
    } else {
      // fallback：如果 save-file 不存在也要能继续（但按 23 工具期望通常存在）
      await writeFileText(fileAbs, fileContent);
    }

    // 2) view：文件/目录/正则（至少一次 call 即算覆盖；这里做更贴近真实使用的 3 次）
    const viewDef = byName.get("view");
    if (viewDef) {
      await callIfPresent("view", buildToolInputFromSchema(viewDef, { overrides: { type: "file", path: fileRel } }));
      await callIfPresent("view", buildToolInputFromSchema(viewDef, { overrides: { type: "directory", path: scratchRelDir } }));
      await callIfPresent(
        "view",
        buildToolInputFromSchema(viewDef, { overrides: { type: "file", path: fileRel, search_query_regex: "BYOK-TEST-LINE-2", case_sensitive: true } })
      );
    }

    // 3) str-replace-editor：替换一行
    const sreDef = byName.get("str-replace-editor");
    if (sreDef) {
      const schema = shared.resolveToolSchema(sreDef);
      const props = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      const isNested = Object.prototype.hasOwnProperty.call(props, "str_replace_entries");
      const isFlat = Object.prototype.hasOwnProperty.call(props, "old_str_1") || Object.prototype.hasOwnProperty.call(props, "new_str_1");
      let sreInput;
      if (isNested) {
        sreInput = buildToolInputFromSchema(sreDef, {
          overrides: {
            command: "str_replace",
            path: fileRel,
            str_replace_entries: [
              {
                old_str: "BYOK-TEST-LINE-2",
                new_str: "BYOK-TEST-LINE-2-REPLACED",
                old_str_start_line_number: 2,
                old_str_end_line_number: 2
              }
            ]
          }
        });
      } else if (isFlat) {
        sreInput = buildToolInputFromSchema(sreDef, {
          overrides: {
            command: "str_replace",
            path: fileRel,
            old_str_1: "BYOK-TEST-LINE-2",
            new_str_1: "BYOK-TEST-LINE-2-REPLACED",
            old_str_start_line_number_1: 2,
            old_str_end_line_number_1: 2
          }
        });
      } else {
        // schema 变更：尽量兜底（至少确保 path/command）
        sreInput = buildToolInputFromSchema(sreDef, { overrides: { command: "str_replace", path: fileRel } });
      }
      await callIfPresent("str-replace-editor", sreInput);
      const after = await readFileText(fileAbs);
      if (!after.includes("BYOK-TEST-LINE-2-REPLACED")) emit("[toolsExec] WARN str-replace-editor executed but file content not updated as expected");
    }

    // 4) remove-files：删除文件
    const rmDef = byName.get("remove-files");
    if (rmDef) {
      await callIfPresent("remove-files", buildToolInputFromSchema(rmDef, { overrides: { file_paths: [fileRel] } }));
      if (await pathExists(fileAbs)) emit("[toolsExec] WARN remove-files executed but file still exists");
    }

    // 5) 为 view-range-untruncated/search-untruncated 准备“可被截断”的大输出
    // 注意：reference_id 来自 truncation footer（通常由 launch-process 的截断输出提供），而不是 view 的 <response clipped>。
    const untruncatedNeedle = "NEEDLE_4242";
    try {
      const bigLines = [];
      for (let i = 1; i <= 6000; i++) {
        bigLines.push(`LINE ${String(i).padStart(4, "0")} :: ${"x".repeat(60)}${i === 4242 ? ` ${untruncatedNeedle}` : ""}`);
      }
      await writeFileText(bigAbs, bigLines.join("\n") + "\n");
    } catch (err) {
      emit(`[toolsExec] WARN failed to prepare truncated content: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6) 终端/进程：launch-process -> list -> read/write -> kill
    const isWin = typeof process !== "undefined" && process && process.platform === "win32";

    let terminalId = null;
    let maxTerminalIdBeforeInteractive = null;
    const lpDef = byName.get("launch-process");
    if (lpDef) {
      const cwdOverrides = {
        cwd: workspaceRoot,
        workdir: workspaceRoot,
        working_dir: workspaceRoot,
        working_directory: workspaceRoot,
        workingDirectory: workspaceRoot,
        workingDir: workspaceRoot,
        directory: workspaceRoot,
        dir: workspaceRoot
      };
      // 先用大输出触发 truncation footer（生成 reference_id），再跑后续终端交互测试。
      // - mac/linux: cat -n
      // - windows: PowerShell Get-Content
      const bigOutCmd = isWin
        ? `powershell -NoProfile -Command "Get-Content -Path '${bigRel.replace(/'/g, "''")}'; Write-Output 'BYOK_SELFTEST'"`
        : `cat -n \"${bigRel}\"; echo BYOK_SELFTEST`;
      const lp1 = await callIfPresent(
        "launch-process",
        buildToolInputFromSchema(lpDef, { overrides: { ...cwdOverrides, command: bigOutCmd, wait: true, max_wait_seconds: 15, maxWaitSeconds: 15 } })
      );
      const ids = extractTerminalIdsFromToolResult(lp1?.res);
      if (ids.length) terminalId = Math.max(...ids);

      // view-range-untruncated + search-untruncated：reference_id 在截断 footer 里（Reference ID: xxx）
      const referenceId = extractReferenceIdFromToolResult(lp1?.res);
      if (!referenceId) emit("[toolsExec] WARN no reference_id detected from launch-process output (untruncated tools may fail; check enableUntruncatedContentStorage)");

      const vrDef = byName.get("view-range-untruncated");
      if (vrDef) {
        await callIfPresent(
          "view-range-untruncated",
          buildToolInputFromSchema(vrDef, { overrides: { reference_id: referenceId, referenceId: referenceId, start_line: 1, end_line: 30, startLine: 1, endLine: 30 } })
        );
      }
      const suDef = byName.get("search-untruncated");
      if (suDef) {
        const sr = await callIfPresent(
          "search-untruncated",
          buildToolInputFromSchema(suDef, {
            overrides: { reference_id: referenceId, referenceId: referenceId, search_term: untruncatedNeedle, searchTerm: untruncatedNeedle, context_lines: 2, contextLines: 2 }
          })
        );
        const st = normalizeString(sr?.res?.text);
        if (st && !st.includes(untruncatedNeedle)) emit("[toolsExec] WARN search-untruncated ok but missing expected needle (unexpected truncation or schema mismatch?)");
      }
    }
    const listDef = byName.get("list-processes");
    let listText = "";
    if (listDef) {
      const lr = await callIfPresent("list-processes", buildToolInputFromSchema(listDef, {}));
      listText = normalizeString(lr?.res?.text);
      const idsAll = extractTerminalIdsFromText(listText);
      if (idsAll.length) maxTerminalIdBeforeInteractive = Math.max(...idsAll);
      if (terminalId == null) {
        const ids = idsAll;
        if (ids.length) terminalId = Math.max(...ids);
      }
    }

    const rpDef = byName.get("read-process");
    if (rpDef && terminalId != null) {
      await callIfPresent(
        "read-process",
        buildToolInputFromSchema(rpDef, {
          overrides: { terminal_id: terminalId, terminalId: terminalId, wait: true, max_wait_seconds: 5, maxWaitSeconds: 5 }
        })
      );
    }

    const rtDef = byName.get("read-terminal");
    let interactiveTerminalId = null;
    const wpDef = byName.get("write-process");
    const kpDef = byName.get("kill-process");

    // write-process：需要一个可交互进程；这里用跨平台 shell（win: powershell, unix: sh）
    if (lpDef) {
      const shellCmd = isWin ? "powershell -NoProfile -NoLogo" : "sh";
      const lp2 = await callIfPresent(
        "launch-process",
        buildToolInputFromSchema(lpDef, {
          overrides: {
            cwd: workspaceRoot,
            workdir: workspaceRoot,
            working_dir: workspaceRoot,
            working_directory: workspaceRoot,
            workingDirectory: workspaceRoot,
            workingDir: workspaceRoot,
            directory: workspaceRoot,
            dir: workspaceRoot,
            command: shellCmd,
            wait: false,
            max_wait_seconds: 1,
            maxWaitSeconds: 1
          }
        })
      );
      const ids2 = extractTerminalIdsFromToolResult(lp2?.res);
      if (ids2.length) interactiveTerminalId = Math.max(...ids2);

      // fallback：通过 list-processes 的“增量”推断新 terminal_id
      if (interactiveTerminalId == null && listDef) {
        const lr2 = await callIfPresent("list-processes", buildToolInputFromSchema(listDef, {}));
        const idsFromList = extractTerminalIdsFromText(lr2?.res?.text);
        const prevMax = Number.isFinite(Number(maxTerminalIdBeforeInteractive)) ? Number(maxTerminalIdBeforeInteractive) : null;
        const candidates = prevMax == null ? idsFromList : idsFromList.filter((x) => x > prevMax);
        if (candidates.length) interactiveTerminalId = Math.max(...candidates);
        else if (idsFromList.length) interactiveTerminalId = Math.max(...idsFromList);
      }
    }

    const activeTerminalId = interactiveTerminalId != null ? interactiveTerminalId : terminalId;

    if (wpDef && activeTerminalId != null) {
      const token = "BYOK_WRITE_TEST";
      const inputText = `echo ${token}\n`;
      const writeOverrides = {
        terminal_id: activeTerminalId,
        terminalId: activeTerminalId,
        input_text: inputText,
        inputText: inputText,
        text: inputText,
        command: inputText
      };
      await callIfPresent("write-process", buildToolInputFromSchema(wpDef, { overrides: writeOverrides }));
    }

    if (rpDef && activeTerminalId != null) {
      const rr = await callIfPresent(
        "read-process",
        buildToolInputFromSchema(rpDef, { overrides: { terminal_id: activeTerminalId, terminalId: activeTerminalId, wait: true, max_wait_seconds: 5, maxWaitSeconds: 5 } })
      );
      if (rr?.ok) {
        const text = normalizeString(rr?.res?.text);
        if (text && !text.includes("BYOK_WRITE_TEST")) emit("[toolsExec] WARN read-process ok but missing expected token");
      }
    }

    if (rtDef) {
      const overrides = { wait: true, max_wait_seconds: 2, maxWaitSeconds: 2 };
      if (activeTerminalId != null) {
        overrides.terminal_id = activeTerminalId;
        overrides.terminalId = activeTerminalId;
      }
      await callIfPresent("read-terminal", buildToolInputFromSchema(rtDef, { overrides }));
    }

    if (kpDef && activeTerminalId != null) {
      await callIfPresent("kill-process", buildToolInputFromSchema(kpDef, { overrides: { terminal_id: activeTerminalId, terminalId: activeTerminalId } }));
    }
    if (kpDef && terminalId != null && activeTerminalId != null && terminalId !== activeTerminalId) {
      await callIfPresent("kill-process", buildToolInputFromSchema(kpDef, { overrides: { terminal_id: terminalId, terminalId: terminalId } }));
    }

    // 7) diagnostics
    const diagDef = byName.get("diagnostics");
    if (diagDef) {
      await writeFileText(diagAbs, "const x = ;\n");
      await callIfPresent("diagnostics", buildToolInputFromSchema(diagDef, { overrides: { paths: [diagRel] } }));
    }

    // 8) codebase-retrieval
    const cbrDef = byName.get("codebase-retrieval");
    if (cbrDef) {
      await callIfPresent("codebase-retrieval", buildToolInputFromSchema(cbrDef, { overrides: { information_request: "BYOK-test 目录在本仓库/环境中的用途是什么？" } }));
    }

    // 9) web-search / web-fetch / open-browser
    const wsDef = byName.get("web-search");
    if (wsDef)
      await callIfPresent(
        "web-search",
        buildToolInputFromSchema(wsDef, { overrides: { query: "example.com robots.txt", search_term: "example.com robots.txt", q: "example.com robots.txt" } })
      );
    const wfDef = byName.get("web-fetch");
    if (wfDef) await callIfPresent("web-fetch", buildToolInputFromSchema(wfDef, { overrides: { url: "https://example.com" } }));
    const obDef = byName.get("open-browser");
    if (obDef) await callIfPresent("open-browser", buildToolInputFromSchema(obDef, { overrides: { url: "https://example.com" } }));

    // 10) render-mermaid
    const mmDef = byName.get("render-mermaid");
    if (mmDef) {
      await callIfPresent(
        "render-mermaid",
        buildToolInputFromSchema(mmDef, {
          overrides: {
            title: "BYOK Self Test",
            diagram_definition: "flowchart LR\n  A[Self Test] --> B{ToolsModel}\n  B --> C[callTool]\n  C --> D[Result]"
          }
        })
      );
    }

    // 11) tasklist：view/add/update/reorganize
    const vtDef = byName.get("view_tasklist");
    const atDef = byName.get("add_tasks");
    const utDef = byName.get("update_tasks");
    const rt2Def = byName.get("reorganize_tasklist");

    // tasklist 工具要求 conversationId 已初始化 root task（否则会报 `No root task found.`）。
    // upstream ToolsModel 暴露了 taskManager；如可用，优先为 self-test 的 conversationId 建立 root task。
    try {
      const taskManager = toolsModel?.taskManager;
      if (taskManager && typeof taskManager.getRootTaskUuid === "function") {
        const root = taskManager.getRootTaskUuid(conversationId);
        if (!root && typeof taskManager.createNewTaskList === "function") {
          await taskManager.createNewTaskList(conversationId);
        }
      }
    } catch (err) {
      emit(`[toolsExec] WARN failed to initialize tasklist root: ${err instanceof Error ? err.message : String(err)}`);
    }

    let taskMarkdown = "";
    if (vtDef) {
      const r = await callIfPresent("view_tasklist", buildToolInputFromSchema(vtDef, {}));
      taskMarkdown = normalizeString(r?.res?.text);
    }
    let newTaskUuid = "";
    if (atDef) {
      const addRes = await callIfPresent(
        "add_tasks",
        buildToolInputFromSchema(atDef, {
          overrides: { tasks: [{ name: "BYOK Self Test Task", description: "Created by self test", state: "NOT_STARTED" }] }
        })
      );
      const plan = addRes?.res?.plan;
      newTaskUuid = findTaskUuidInPlan(plan, ({ name }) => name.includes("BYOK Self Test Task"));

      // 刷新一次 tasklist，便于从 markdown 中提取 uuid（plan 结构在不同版本可能不返回/不一致）
      if (vtDef) {
        const r2 = await callIfPresent("view_tasklist", buildToolInputFromSchema(vtDef, {}));
        const md2 = normalizeString(r2?.res?.text);
        if (md2) taskMarkdown = md2;
        if (!newTaskUuid && md2) {
          const lines = md2.split(/\r?\n/);
          const line = lines.find((l) => l.includes("BYOK Self Test Task")) || "";
          const m = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          if (m && m[1]) newTaskUuid = String(m[1]);
        }
      }
    }
    if (utDef && newTaskUuid) {
      await callIfPresent("update_tasks", buildToolInputFromSchema(utDef, { overrides: { tasks: [{ task_id: newTaskUuid, state: "IN_PROGRESS" }] } }));
      await callIfPresent("update_tasks", buildToolInputFromSchema(utDef, { overrides: { tasks: [{ task_id: newTaskUuid, state: "COMPLETE" }] } }));
    }
    if (rt2Def && taskMarkdown) {
      // 最小“重排”：把 BYOK Self Test Task 移到 root task 的第一个子任务位置（避免插到 header 前导致 “level 1 has no parent”）
      const normalizeMarkdownForReorg = (md) => {
        const raw = normalizeString(md);
        if (!raw) return "";

        const lines = raw.split(/\r?\n/);
        const tasks = [];

        const parseTaskLine = (line) => {
          const s = typeof line === "string" ? line : "";
          const m = s.match(/^(\s*)(-*)\s*(\[[ x\/-]\]\s*UUID:.*)$/);
          if (!m) return null;
          const dashes = m[2] || "";
          const body = (m[3] || "").trimEnd();
          if (!body) return null;
          return { dashCount: dashes.length, body };
        };

        for (const l of lines) {
          const t = parseTaskLine(l);
          if (t) tasks.push(t);
        }
        if (!tasks.length) return raw;

        // view_tasklist 输出可能包含 header/空行；reorganize_tasklist 的 parser 对“根任务必须是 level=0”非常敏感。
        // 这里把 markdown 归一化为“仅 task 行”，并保证第一行是 root(level 0)。
        const pickRootIdx = () => {
          const preferred = tasks.findIndex(
            (t) => t.body.includes("NAME:Current Task List") || t.body.includes("Root task for conversation") || t.body.includes("Root task")
          );
          if (preferred >= 0) return preferred;
          let best = 0;
          let bestDash = Number.POSITIVE_INFINITY;
          for (let i = 0; i < tasks.length; i++) {
            const d = Number(tasks[i].dashCount) || 0;
            if (d < bestDash) {
              bestDash = d;
              best = i;
            }
          }
          return best;
        };

        const rootIdx = pickRootIdx();
        const baseDash = Math.max(0, Math.floor(Number(tasks[rootIdx]?.dashCount) || 0));

        const normalized = tasks.map((t) => ({
          dashCount: Math.max(0, Math.floor(Number(t.dashCount) || 0) - baseDash),
          body: t.body
        }));

        // 确保 root 是第一行，且 level=0
        const [rootLine] = normalized.splice(rootIdx, 1);
        normalized.unshift({ ...rootLine, dashCount: 0 });

        // 保证：除 root 外不允许出现 level=0；同时避免出现 level 跳跃导致 “missing parent”
        for (let i = 1; i < normalized.length; i++) {
          let d = Math.floor(Number(normalized[i].dashCount) || 0);
          if (d <= 0) d = 1;
          const prev = Math.floor(Number(normalized[i - 1].dashCount) || 0);
          if (d > prev + 1) d = prev + 1;
          normalized[i].dashCount = d;
        }

        // 最小重排：把 BYOK Self Test Task 移到 root 的第一个子任务位置
        const byokIdx = normalized.findIndex((t) => t.body.includes("BYOK Self Test Task"));
        if (byokIdx > 1) {
          const [line] = normalized.splice(byokIdx, 1);
          normalized.splice(1, 0, { ...line, dashCount: 1 });
        } else if (byokIdx === 1) {
          normalized[1].dashCount = 1;
        }

        return normalized.map((t) => `${"-".repeat(Math.max(0, t.dashCount))}${t.body}`).join("\n");
      };

      const markdownToSubmit = normalizeMarkdownForReorg(taskMarkdown) || taskMarkdown;
      await callIfPresent("reorganize_tasklist", buildToolInputFromSchema(rt2Def, { overrides: { markdown: markdownToSubmit } }));
    }

    // 12) remember
    const remDef = byName.get("remember");
    if (remDef) {
      const schema = shared.resolveToolSchema(remDef);
      const props = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      // remember schema 在不同版本可能是 {text} 或 {memory} 等；这里尽量兼容
      const overrides = {};
      if (Object.prototype.hasOwnProperty.call(props, "text")) overrides.text = "BYOK-test 是工具全量测试目录";
      if (Object.prototype.hasOwnProperty.call(props, "memory")) overrides.memory = "BYOK-test 是工具全量测试目录";
      if (Object.prototype.hasOwnProperty.call(props, "content")) overrides.content = "BYOK-test 是工具全量测试目录";
      if (Object.keys(overrides).length === 0) overrides.text = "BYOK-test 是工具全量测试目录";
      await callIfPresent("remember", buildToolInputFromSchema(remDef, { overrides }));
    }
  } finally {
    // 清理：尽量删除 scratch；如果用户想保留，可以手动取消或自行复制。
    try {
      await rmPathRecursive(scratchAbsDir);
    } catch {}
  }

  // 覆盖检查：确保 toolNames 都至少记录了一次（否则属于“没有走到该工具”）
  const missing = toolNames.filter((n) => !results.has(n));
  for (const n of missing) results.set(n, { ok: false, detail: "not executed" });

  const failed = Array.from(results.entries()).filter(([, v]) => v && v.ok === false);
  const failedNames = failed.map(([name]) => name).filter(Boolean);
  const ok = failed.length === 0;
  const ms = nowMs() - t0;
  debug(`[self-test][toolsExec] done ok=${String(ok)} failed=${failed.length} ms=${ms}`);
  const failedPreview = failedNames.slice(0, 8).join(",");
  const detail =
    `tools=${toolNames.length} executed=${results.size} failed=${failed.length}` +
    (failed.length ? ` first=${failed[0][0]}` : "") +
    (failedNames.length ? ` failed_tools=${failedPreview}${failedNames.length > 8 ? ",…" : ""}` : "");
  emit(`[toolsExec] done ok=${String(ok)} ${detail}`);

  const toolResults = {};
  for (const [name, r] of results.entries()) toolResults[name] = r;
  return { ok, ms, detail, failedTools: failedNames.slice(0, 12), failedToolsTruncated: failedNames.length > 12, toolResults };
}

module.exports = {
  getByokUpstreamGlobals,
  fetchLocalToolDefinitionsFromUpstream,
  getToolsModelFromUpstreamOrNull,
  selfTestToolsModelExec
};
