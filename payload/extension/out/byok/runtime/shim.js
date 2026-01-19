"use strict";

const nodePath = require("path");

const { debug, warn } = require("../infra/log");
const { withTiming, traceAsyncGenerator } = require("../infra/trace");
const { ensureConfigManager, state, captureAugmentToolDefinitions } = require("../config/state");
const { decideRoute } = require("../core/router");
const { normalizeEndpoint, normalizeString, normalizeRawToken, safeTransform, emptyAsyncGenerator } = require("../infra/util");
const { normalizeBlobsMap, coerceBlobText } = require("../core/blob-utils");
const { extractDiagnosticsList, pickDiagnosticPath, pickDiagnosticStartLine, pickDiagnosticEndLine } = require("../core/diagnostics-utils");
const { pickPath, pickNumResults, pickBlobNameHint } = require("../core/next-edit-fields");
const { bestMatchIndex, bestInsertionIndex } = require("../core/text-match");
const { parseNextEditLocCandidatesFromText, mergeNextEditLocCandidates } = require("../core/next-edit-loc-utils");
const { buildNextEditStreamRuntimeContext } = require("../core/next-edit-stream-utils");
const { openAiCompleteText, openAiStreamTextDeltas, openAiChatStreamChunks } = require("../providers/openai");
const { openAiResponsesCompleteText, openAiResponsesStreamTextDeltas, openAiResponsesChatStreamChunks } = require("../providers/openai-responses");
const { anthropicCompleteText, anthropicStreamTextDeltas, anthropicChatStreamChunks } = require("../providers/anthropic");
const { geminiCompleteText, geminiStreamTextDeltas, geminiChatStreamChunks } = require("../providers/gemini");
const { getOfficialConnection } = require("../config/official");
const {
  fetchOfficialGetModels,
  mergeModels,
  maybeInjectOfficialCodebaseRetrieval,
  maybeInjectOfficialContextCanvas,
  maybeInjectOfficialExternalSources
} = require("./official");
const {
  normalizeAugmentChatRequest,
  buildSystemPrompt,
  convertOpenAiTools,
  convertOpenAiResponsesTools,
  convertAnthropicTools,
  convertGeminiTools,
  buildToolMetaByName,
  buildOpenAiMessages,
  buildOpenAiResponsesInput,
  buildAnthropicMessages,
  buildGeminiContents
} = require("../core/augment-chat");
const { maybeSummarizeAndCompactAugmentChatRequest, deleteHistorySummaryCache } = require("../core/augment-history-summary-auto");
const { REQUEST_NODE_TEXT, REQUEST_NODE_TOOL_RESULT, STOP_REASON_END_TURN, makeBackChatChunk } = require("../core/augment-protocol");
const { makeEndpointErrorText, guardObjectStream } = require("../core/stream-guard");
const {
  buildMessagesForEndpoint,
  makeBackTextResult,
  makeBackChatResult,
  makeBackCompletionResult,
  makeBackNextEditGenerationChunk,
  makeBackNextEditLocationResult,
  buildByokModelsFromConfig,
  makeBackGetModelsResult,
  makeModelInfo
} = require("../core/protocol");

const WORKSPACE_BLOB_MAX_CHARS = 2_000_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000;

async function maybeDeleteHistorySummaryCacheForEndpoint(ep, body) {
  const endpoint = normalizeEndpoint(ep);
  if (!endpoint) return false;
  const lower = endpoint.toLowerCase();
  if (!lower.includes("delete") && !lower.includes("remove") && !lower.includes("archive")) return false;
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  const conversationId = normalizeString(b?.conversation_id ?? b?.conversationId ?? b?.conversationID);
  if (!conversationId) return false;
  try {
    const ok = await deleteHistorySummaryCache(conversationId);
    if (ok) debug(`historySummary cache deleted: conv=${conversationId} endpoint=${endpoint}`);
    return ok;
  } catch (err) {
    debug(`historySummary cache delete failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function resolveProviderApiKey(provider, label) {
  if (!provider || typeof provider !== "object") throw new Error(`${label} provider 无效`);
  return normalizeRawToken(provider.apiKey);
}

function providerLabel(provider) {
  const id = normalizeString(provider?.id);
  const type = normalizeString(provider?.type);
  return `Provider(${id || type || "unknown"})`;
}

function formatRouteForLog(route) {
  const r = route && typeof route === "object" ? route : {};
  const endpoint = normalizeString(r.endpoint);
  const mode = normalizeString(r.mode) || "unknown";
  const reason = normalizeString(r.reason);
  const providerId = normalizeString(r.provider?.id);
  const providerType = normalizeString(r.provider?.type);
  const model = normalizeString(r.model);
  const requestedModel = normalizeString(r.requestedModel);

  const parts = [];
  if (endpoint) parts.push(`ep=${endpoint}`);
  parts.push(`mode=${mode}`);
  if (reason) parts.push(`reason=${reason}`);
  if (providerId || providerType) parts.push(`provider=${providerId || providerType}`);
  if (model) parts.push(`model=${model}`);
  if (requestedModel) parts.push(`requestedModel=${requestedModel}`);
  return parts.join(" ");
}

function providerRequestContext(provider) {
  if (!provider || typeof provider !== "object") throw new Error("BYOK provider 未选择");
  const type = normalizeString(provider.type);
  const baseUrl = normalizeString(provider.baseUrl);
  const apiKey = resolveProviderApiKey(provider, providerLabel(provider));
  const extraHeaders = provider.headers && typeof provider.headers === "object" ? provider.headers : {};
  const requestDefaultsRaw = provider.requestDefaults && typeof provider.requestDefaults === "object" ? provider.requestDefaults : {};

  const requestDefaults =
    requestDefaultsRaw && typeof requestDefaultsRaw === "object" && !Array.isArray(requestDefaultsRaw) ? requestDefaultsRaw : {};
  if (!apiKey && Object.keys(extraHeaders).length === 0) throw new Error(`${providerLabel(provider)} 未配置 api_key（且 headers 为空）`);
  return { type, baseUrl, apiKey, extraHeaders, requestDefaults };
}

function asOpenAiMessages(system, messages) {
  const sys = typeof system === "string" ? system : "";
  const ms = Array.isArray(messages) ? messages : [];
  return [{ role: "system", content: sys }, ...ms].filter((m) => m && typeof m.content === "string" && m.content);
}

function asAnthropicMessages(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const out = ms
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  return { system: sys, messages: out };
}

function asGeminiContents(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const contents = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "model" : m.role === "user" ? "user" : "";
    const content = typeof m.content === "string" ? m.content : "";
    if (!role || !content) continue;
    contents.push({ role, parts: [{ text: content }] });
  }
  return { systemInstruction: sys, contents };
}

function asOpenAiResponsesInput(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const input = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "";
    const content = typeof m.content === "string" ? m.content : "";
    if (!role || !content) continue;
    input.push({ type: "message", role, content });
  }
  return { instructions: sys, input };
}

function isTelemetryDisabled(cfg, ep) {
  const list = Array.isArray(cfg?.telemetry?.disabledEndpoints) ? cfg.telemetry.disabledEndpoints : [];
  return list.includes(ep);
}

function normalizeLineNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  return Math.floor(n);
}

function normalizeNewlines(s) {
  return typeof s === "string" ? s.replace(/\r\n/g, "\n") : "";
}

function countNewlines(s) {
  const text = typeof s === "string" ? s : "";
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function clampLineNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  if (v <= 1) return 1;
  return Math.floor(v);
}

function trimTrailingNewlines(s) {
  const t = normalizeNewlines(s);
  return t.replace(/\n+$/g, "");
}

function resolveTextField(obj, keys) {
  const b = obj && typeof obj === "object" ? obj : {};
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof b[k] === "string") return b[k];
  }
  return "";
}

async function readWorkspaceFileTextByPath(p) {
  const raw = normalizeString(p);
  if (!raw) return "";
  const vscode = state.vscode;
  const ws = vscode && vscode.workspace ? vscode.workspace : null;
  const Uri = vscode && vscode.Uri ? vscode.Uri : null;
  if (!ws || !ws.fs || typeof ws.fs.readFile !== "function" || !Uri) return "";

  const tryRead = async (uri) => {
    try {
      const bytes = await ws.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return "";
    }
  };

  if (raw.includes("://")) {
    try { return await tryRead(Uri.parse(raw)); } catch {}
  }

  try {
    if (nodePath.isAbsolute(raw)) return await tryRead(Uri.file(raw));
  } catch {}

  const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const folders = Array.isArray(ws.workspaceFolders) ? ws.workspaceFolders : [];
  for (const f of folders) {
    const base = f && f.uri ? f.uri : null;
    if (!base) continue;
    const u = Uri.joinPath(base, rel);
    const txt = await tryRead(u);
    if (txt) return txt;
  }
  return "";
}

async function maybeAugmentBodyWithWorkspaceBlob(body, { pathHint, blobKey } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const blobs = normalizeBlobsMap(b.blobs);

  const hint = normalizeString(pathHint);
  const path = hint || pickPath(b);
  if (!path) return b;

  const key = normalizeString(blobKey) || path;
  if (blobs && coerceBlobText(blobs[key])) return b;

  const txt = await readWorkspaceFileTextByPath(path);
  if (!txt) return b;
  if (txt.length > WORKSPACE_BLOB_MAX_CHARS) return b;
  return { ...b, blobs: { ...(blobs || {}), [key]: txt } };
}

async function buildInstructionReplacementMeta(body) {
  const b = body && typeof body === "object" ? body : {};
  const selectedTextRaw = resolveTextField(b, ["selected_text", "selectedText"]);
  const prefixRaw = resolveTextField(b, ["prefix"]);
  const suffixRaw = resolveTextField(b, ["suffix"]);
  const targetPath = normalizeString(resolveTextField(b, ["target_file_path", "targetFilePath"]));
  const path = normalizeString(resolveTextField(b, ["path", "pathName"]));
  const filePath = targetPath || path;

  const targetFileContentRaw = resolveTextField(b, ["target_file_content", "targetFileContent"]);
  const fileTextRaw = targetFileContentRaw ? targetFileContentRaw : await readWorkspaceFileTextByPath(filePath);
  const fileText = normalizeNewlines(fileTextRaw);
  const selectedText = normalizeNewlines(selectedTextRaw);
  const prefix = normalizeNewlines(prefixRaw);
  const suffix = normalizeNewlines(suffixRaw);

  const prefixHint = prefix ? prefix.slice(Math.max(0, prefix.length - 400)) : "";
  const suffixHint = suffix ? suffix.slice(0, 400) : "";

  if (fileText && selectedText) {
    const idx = bestMatchIndex(fileText, selectedText, { prefixHint, suffixHint });
    if (idx >= 0) {
      const startLine = 1 + countNewlines(fileText.slice(0, idx));
      const trimmed = trimTrailingNewlines(selectedText);
      const endLine = startLine + countNewlines(trimmed);
      return { replacement_start_line: clampLineNumber(startLine), replacement_end_line: clampLineNumber(endLine), replacement_old_text: selectedText };
    }
  }

  const insertIdx = fileText ? bestInsertionIndex(fileText, { prefixHint, suffixHint }) : 0;
  const insertLine = fileText ? 1 + countNewlines(fileText.slice(0, insertIdx)) : 1;
  const lines = fileText ? fileText.split("\n") : [];
  const lineBefore = insertLine > 1 && lines[insertLine - 2] != null ? String(lines[insertLine - 2]).trimEnd() : "";
  const oldText = selectedText ? selectedText : `PURE INSERTION AFTER LINE:${lineBefore}`;
  return { replacement_start_line: clampLineNumber(insertLine), replacement_end_line: clampLineNumber(insertLine), replacement_old_text: oldText };
}

function pickNextEditLocationCandidates(body) {
  const b = body && typeof body === "object" ? body : {};
  const max = pickNumResults(b, { defaultValue: 1, max: 6 });

  const out = [];
  const seen = new Set();
  const push = ({ path, start, stop, score = 1, source }) => {
    const p = normalizeString(path);
    const a = normalizeLineNumber(start);
    const z = normalizeLineNumber(stop);
    if (!p || a === null || z === null) return false;
    const key = `${p}:${a}:${Math.max(a, z)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({ item: { path: p, range: { start: a, stop: Math.max(a, z) } }, score, debug_info: { source: normalizeString(source) || "unknown" } });
    return true;
  };

  const diags = extractDiagnosticsList(b.diagnostics);
  for (const d of diags) {
    const path = pickDiagnosticPath(d);
    if (!path) continue;
    const start = pickDiagnosticStartLine(d);
    if (start === null) continue;
    const stop = pickDiagnosticEndLine(d, start);
    push({ path, start, stop, score: 1, source: "diagnostic" });
    if (out.length >= max) break;
  }

  if (out.length < max) {
    const path = pickPath(b);
    if (path) push({ path, start: 0, stop: 0, score: 1, source: "fallback:path" });
  }

  if (out.length < max) {
    // 某些请求不带 path，但会带 blobs（key 往往是 path/blobName）。
    const blobs = normalizeBlobsMap(b.blobs);
    if (blobs) {
      for (const k of Object.keys(blobs)) {
        push({ path: k, start: 0, stop: 0, score: 1, source: "fallback:blobs" });
        if (out.length >= max) break;
      }
    }
  }

  return out;
}

async function byokCompleteText({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);

  if (type === "openai_compatible") {
    return await openAiCompleteText({
      baseUrl,
      apiKey,
      model,
      messages: asOpenAiMessages(system, messages),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults
    });
  }
  if (type === "anthropic") {
    const { system: sys, messages: msgs } = asAnthropicMessages(system, messages);
    return await anthropicCompleteText({ baseUrl, apiKey, model, system: sys, messages: msgs, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "openai_responses") {
    const { instructions, input } = asOpenAiResponsesInput(system, messages);
    return await openAiResponsesCompleteText({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = asGeminiContents(system, messages);
    return await geminiCompleteText({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function* byokStreamText({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);

  if (type === "openai_compatible") {
    yield* openAiStreamTextDeltas({
      baseUrl,
      apiKey,
      model,
      messages: asOpenAiMessages(system, messages),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults
    });
    return;
  }
  if (type === "anthropic") {
    const { system: sys, messages: msgs } = asAnthropicMessages(system, messages);
    yield* anthropicStreamTextDeltas({ baseUrl, apiKey, model, system: sys, messages: msgs, timeoutMs, abortSignal, extraHeaders, requestDefaults });
    return;
  }
  if (type === "openai_responses") {
    const { instructions, input } = asOpenAiResponsesInput(system, messages);
    yield* openAiResponsesStreamTextDeltas({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults });
    return;
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = asGeminiContents(system, messages);
    yield* geminiStreamTextDeltas({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults });
    return;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function* byokChatStream({ cfg, provider, model, requestedModel, body, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);
  const req = normalizeAugmentChatRequest(body);
  const conversationId = normalizeString(req?.conversation_id ?? req?.conversationId ?? req?.conversationID);
  try {
    captureAugmentToolDefinitions(req.tool_definitions, {
      endpoint: "/chat-stream",
      providerId: normalizeString(provider?.id),
      providerType: type,
      requestedModel: normalizeString(requestedModel),
      conversationId
    });
  } catch {}
  const msg = normalizeString(req.message);
  const hasNodes = Array.isArray(req.nodes) && req.nodes.length;
  const hasHistory = Array.isArray(req.chat_history) && req.chat_history.length;
  const hasReqNodes = (Array.isArray(req.structured_request_nodes) && req.structured_request_nodes.length) || (Array.isArray(req.request_nodes) && req.request_nodes.length);
  debug(
    `[chat-stream] start provider=${providerLabel(provider)} type=${type || "unknown"} model=${normalizeString(model) || "unknown"} requestedModel=${normalizeString(requestedModel) || "unknown"} conv=${conversationId || "n/a"} tool_defs=${Array.isArray(req.tool_definitions) ? req.tool_definitions.length : 0} msg_len=${msg.length} has_nodes=${String(Boolean(hasNodes))} has_history=${String(Boolean(hasHistory))} has_req_nodes=${String(Boolean(hasReqNodes))}`
  );
  if (!msg && !hasNodes && !hasHistory && !hasReqNodes) {
    yield makeBackChatChunk({ text: "", stop_reason: STOP_REASON_END_TURN });
    return;
  }
  try {
    await maybeSummarizeAndCompactAugmentChatRequest({ cfg, req, requestedModel, fallbackProvider: provider, fallbackModel: model, timeoutMs, abortSignal });
  } catch (err) {
    warn(`historySummary failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
  await maybeInjectOfficialCodebaseRetrieval({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken });
  await maybeInjectOfficialContextCanvas({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken });
  await maybeInjectOfficialExternalSources({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken });
  const toolMetaByName = buildToolMetaByName(req.tool_definitions);
  const fdf = req && typeof req === "object" && req.feature_detection_flags && typeof req.feature_detection_flags === "object" ? req.feature_detection_flags : {};
  const supportToolUseStart = fdf.support_tool_use_start === true || fdf.supportToolUseStart === true;
  const traceLabel = `[chat-stream] upstream provider=${providerLabel(provider)} type=${type || "unknown"} model=${normalizeString(model) || "unknown"}`;
  if (type === "openai_compatible") {
    const gen = openAiChatStreamChunks({ baseUrl, apiKey, model, messages: buildOpenAiMessages(req), tools: convertOpenAiTools(req.tool_definitions), timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    yield* traceAsyncGenerator(`${traceLabel} openai_compatible`, gen);
    return;
  }
  if (type === "anthropic") {
    const gen = anthropicChatStreamChunks({ baseUrl, apiKey, model, system: buildSystemPrompt(req), messages: buildAnthropicMessages(req), tools: convertAnthropicTools(req.tool_definitions), timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    yield* traceAsyncGenerator(`${traceLabel} anthropic`, gen);
    return;
  }
  if (type === "openai_responses") {
    const { instructions, input } = buildOpenAiResponsesInput(req);
    const gen = openAiResponsesChatStreamChunks({ baseUrl, apiKey, model, instructions, input, tools: convertOpenAiResponsesTools(req.tool_definitions), timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    yield* traceAsyncGenerator(`${traceLabel} openai_responses`, gen);
    return;
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = buildGeminiContents(req);
    const gen = geminiChatStreamChunks({ baseUrl, apiKey, model, systemInstruction, contents, tools: convertGeminiTools(req.tool_definitions), timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    yield* traceAsyncGenerator(`${traceLabel} gemini_ai_studio`, gen);
    return;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function maybeHandleCallApi({ endpoint, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL }) {
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return undefined;
  await maybeDeleteHistorySummaryCacheForEndpoint(ep, body);

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  if (!state.runtimeEnabled) return undefined;

  if (isTelemetryDisabled(cfg, ep)) {
    try {
      return safeTransform(transform, {}, `telemetry:${ep}`);
    } catch (err) {
      warn(`telemetry stub transform failed, fallback official: ${ep}`);
      return undefined;
    }
  }

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  debug(`[callApi] ${formatRouteForLog(route)}`);
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") {
    try {
      return safeTransform(transform, {}, `disabled:${ep}`);
    } catch {
      return {};
    }
  }
  if (route.mode !== "byok") return undefined;

  const t = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_UPSTREAM_TIMEOUT_MS;

  if (ep === "/get-models") {
    const byokModels = buildByokModelsFromConfig(cfg);
    const byokDefaultModel = byokModels.length ? byokModels[0] : "";
    const activeProvider = Array.isArray(cfg?.providers) ? cfg.providers[0] : null;
    const activeProviderId = normalizeString(activeProvider?.id);
    const activeProviderDefaultModel = normalizeString(activeProvider?.defaultModel) || normalizeString(activeProvider?.models?.[0]);
    const preferredByok = activeProviderId && activeProviderDefaultModel ? `byok:${activeProviderId}:${activeProviderDefaultModel}` : "";
    const preferredDefaultModel = byokModels.includes(preferredByok) ? preferredByok : byokDefaultModel;
    try {
      const off = getOfficialConnection();
      const completionURL = normalizeString(upstreamCompletionURL) || off.completionURL;
      const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
      const upstream = await withTiming(`[callApi ${ep}] official/get-models`, async () =>
        await fetchOfficialGetModels({ completionURL, apiToken, timeoutMs: Math.min(12000, t), abortSignal })
      );
      const merged = mergeModels(upstream, byokModels, { defaultModel: preferredDefaultModel });
      return safeTransform(transform, merged, ep);
    } catch (err) {
      warn(`get-models fallback to local: ${err instanceof Error ? err.message : String(err)}`);
      const local = makeBackGetModelsResult({ defaultModel: preferredDefaultModel || "unknown", models: byokModels.map(makeModelInfo) });
      return safeTransform(transform, local, ep);
    }
  }

  if (ep === "/completion" || ep === "/chat-input-completion") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const label = `[callApi ${ep}] complete provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
    const text = await withTiming(label, async () => await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal }));
    return safeTransform(transform, makeBackCompletionResult(text), ep);
  }

  if (ep === "/edit") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const label = `[callApi ${ep}] edit provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
    const text = await withTiming(label, async () => await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal }));
    return safeTransform(transform, makeBackTextResult(text), ep);
  }

  if (ep === "/chat") {
    const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(route.provider);
    const req = normalizeAugmentChatRequest(body);
    const conversationId = normalizeString(req?.conversation_id ?? req?.conversationId ?? req?.conversationID);
    try {
      captureAugmentToolDefinitions(req.tool_definitions, {
        endpoint: "/chat",
        providerId: normalizeString(route?.provider?.id),
        providerType: type,
        requestedModel: normalizeString(route?.requestedModel),
        conversationId
      });
    } catch {}
    const msg = normalizeString(req.message);
    const hasNodes = Array.isArray(req.nodes) && req.nodes.length;
    const hasHistory = Array.isArray(req.chat_history) && req.chat_history.length;
    const hasReqNodes = (Array.isArray(req.structured_request_nodes) && req.structured_request_nodes.length) || (Array.isArray(req.request_nodes) && req.request_nodes.length);
    debug(
      `[chat] start provider=${providerLabel(route.provider)} type=${type || "unknown"} model=${normalizeString(route.model) || "unknown"} requestedModel=${normalizeString(route.requestedModel) || "unknown"} conv=${conversationId || "n/a"} tool_defs=${Array.isArray(req.tool_definitions) ? req.tool_definitions.length : 0} msg_len=${msg.length} has_nodes=${String(Boolean(hasNodes))} has_history=${String(Boolean(hasHistory))} has_req_nodes=${String(Boolean(hasReqNodes))}`
    );
    if (!msg && !hasNodes && !hasHistory && !hasReqNodes) return safeTransform(transform, makeBackChatResult("", { nodes: [] }), ep);
    try {
      await maybeSummarizeAndCompactAugmentChatRequest({ cfg, req, requestedModel: route.requestedModel, fallbackProvider: route.provider, fallbackModel: route.model, timeoutMs: t, abortSignal });
    } catch (err) {
      warn(`historySummary failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
    await maybeInjectOfficialCodebaseRetrieval({ req, timeoutMs: t, abortSignal, upstreamCompletionURL, upstreamApiToken });
    await maybeInjectOfficialContextCanvas({ req, timeoutMs: t, abortSignal, upstreamCompletionURL, upstreamApiToken });
    await maybeInjectOfficialExternalSources({ req, timeoutMs: t, abortSignal, upstreamCompletionURL, upstreamApiToken });
    const chatLabel = `[callApi ${ep}] provider=${providerLabel(route.provider)} type=${type || "unknown"} model=${normalizeString(route.model) || "unknown"}`;
    if (type === "openai_compatible") {
      const text = await withTiming(chatLabel, async () =>
        await openAiCompleteText({ baseUrl, apiKey, model: route.model, messages: buildOpenAiMessages(req), timeoutMs: t, abortSignal, extraHeaders, requestDefaults })
      );
      return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
    }
    if (type === "anthropic") {
      const text = await withTiming(chatLabel, async () =>
        await anthropicCompleteText({ baseUrl, apiKey, model: route.model, system: buildSystemPrompt(req), messages: buildAnthropicMessages(req), timeoutMs: t, abortSignal, extraHeaders, requestDefaults })
      );
      return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
    }
    if (type === "openai_responses") {
      const { instructions, input } = buildOpenAiResponsesInput(req);
      const text = await withTiming(chatLabel, async () =>
        await openAiResponsesCompleteText({ baseUrl, apiKey, model: route.model, instructions, input, timeoutMs: t, abortSignal, extraHeaders, requestDefaults })
      );
      return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
    }
    if (type === "gemini_ai_studio") {
      const { systemInstruction, contents } = buildGeminiContents(req);
      const text = await withTiming(chatLabel, async () =>
        await geminiCompleteText({ baseUrl, apiKey, model: route.model, systemInstruction, contents, timeoutMs: t, abortSignal, extraHeaders, requestDefaults })
      );
      return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
    }
    throw new Error(`未知 provider.type: ${type}`);
  }

  if (ep === "/next_edit_loc") {
    const b = body && typeof body === "object" ? body : {};
    const max = pickNumResults(b, { defaultValue: 1, max: 6 });

    const baseline = pickNextEditLocationCandidates(body);
    const fallbackPath =
      pickPath(b) ||
      normalizeString(baseline?.[0]?.item?.path);
    let llmCandidates = [];

    try {
      const bodyForPrompt = await maybeAugmentBodyWithWorkspaceBlob(body, { pathHint: fallbackPath });
      const { system, messages } = buildMessagesForEndpoint(ep, bodyForPrompt);
      const label = `[callApi ${ep}] llm provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
      const text = await withTiming(label, async () => await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal }));
      llmCandidates = parseNextEditLocCandidatesFromText(text, { fallbackPath, max, source: "byok:llm" });
    } catch (err) {
      warn(`next_edit_loc llm fallback to diagnostics: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!llmCandidates.length) {
      return safeTransform(transform, makeBackNextEditLocationResult(baseline), ep);
    }
    const merged = mergeNextEditLocCandidates({ baseline, llmCandidates, max });
    return safeTransform(transform, makeBackNextEditLocationResult(merged), ep);
  }

  return undefined;
}

async function maybeHandleCallApiStream({ endpoint, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL }) {
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return undefined;
  await maybeDeleteHistorySummaryCacheForEndpoint(ep, body);

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  if (!state.runtimeEnabled) return undefined;

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  debug(`[callApiStream] ${formatRouteForLog(route)}`);
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") return emptyAsyncGenerator();
  if (route.mode !== "byok") return undefined;

  const t = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_UPSTREAM_TIMEOUT_MS;

  if (isTelemetryDisabled(cfg, ep)) return emptyAsyncGenerator();

  if (ep === "/chat-stream") {
    const src = byokChatStream({ cfg, provider: route.provider, model: route.model, requestedModel: route.requestedModel, body, timeoutMs: t, abortSignal, upstreamApiToken, upstreamCompletionURL });
    return guardObjectStream({
      ep,
      src,
      transform,
      makeErrorChunk: (err) => makeBackChatChunk({ text: makeEndpointErrorText(ep, err), stop_reason: STOP_REASON_END_TURN })
    });
  }

  if (ep === "/prompt-enhancer" || ep === "/generate-conversation-title") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const label = `[callApiStream ${ep}] delta provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
    const src = traceAsyncGenerator(label, byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal }));
    return guardObjectStream({
      ep,
      transform,
      src: (async function* () { for await (const delta of src) yield makeBackChatResult(delta, { nodes: [] }); })(),
      makeErrorChunk: (err) => makeBackChatResult(makeEndpointErrorText(ep, err), { nodes: [] })
    });
  }

  if (ep === "/instruction-stream" || ep === "/smart-paste-stream") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const meta = await buildInstructionReplacementMeta(body);
    const label = `[callApiStream ${ep}] delta provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
    const src = traceAsyncGenerator(label, byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal }));
    return guardObjectStream({
      ep,
      transform,
      src: (async function* () {
        yield { text: "", ...meta };
        for await (const delta of src) {
          const t = typeof delta === "string" ? delta : String(delta ?? "");
          if (!t) continue;
          yield { text: t, replacement_text: t };
        }
      })(),
      makeErrorChunk: (err) => ({ text: makeEndpointErrorText(ep, err), ...meta })
    });
  }

  if (ep === "/generate-commit-message-stream") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const label = `[callApiStream ${ep}] delta provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
    const src = traceAsyncGenerator(label, byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal }));
    return guardObjectStream({
      ep,
      transform,
      src: (async function* () { for await (const delta of src) yield makeBackChatResult(delta, { nodes: [] }); })(),
      makeErrorChunk: (err) => makeBackChatResult(makeEndpointErrorText(ep, err), { nodes: [] })
    });
  }

  if (ep === "/next-edit-stream") {
    const b = body && typeof body === "object" ? body : {};
    const hasPrefix = typeof b.prefix === "string";
    const hasSuffix = typeof b.suffix === "string";
    const bodyForContext =
      hasPrefix && hasSuffix
        ? b
        : await maybeAugmentBodyWithWorkspaceBlob(body, { pathHint: pickPath(body), blobKey: pickBlobNameHint(body) });
    const { promptBody, path, blobName, selectionBegin, selectionEnd, existingCode } = buildNextEditStreamRuntimeContext(bodyForContext);
    const { system, messages } = buildMessagesForEndpoint(ep, promptBody);
    const label = `[callApiStream ${ep}] complete provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
    const suggestedCode = await withTiming(label, async () => await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal }));

    const raw = makeBackNextEditGenerationChunk({
      path: path || blobName,
      blobName,
      charStart: selectionBegin,
      charEnd: selectionEnd,
      existingCode,
      suggestedCode
    });
    return (async function* () { yield safeTransform(transform, raw, ep); })();
  }

  return undefined;
}

module.exports = { maybeHandleCallApi, maybeHandleCallApiStream };
