"use strict";

const { debug } = require("../infra/log");
const { nowMs } = require("../infra/trace");
const { normalizeString, randomId } = require("../infra/util");
const { captureAugmentToolDefinitions, getLastCapturedToolDefinitions } = require("../config/state");
const { fetchProviderModels } = require("../providers/models");
const { openAiCompleteText, openAiStreamTextDeltas, openAiChatStreamChunks } = require("../providers/openai");
const { openAiResponsesCompleteText, openAiResponsesStreamTextDeltas, openAiResponsesChatStreamChunks } = require("../providers/openai-responses");
const { anthropicCompleteText, anthropicStreamTextDeltas, anthropicChatStreamChunks } = require("../providers/anthropic");
const { geminiCompleteText, geminiStreamTextDeltas, geminiChatStreamChunks } = require("../providers/gemini");
const { buildMessagesForEndpoint } = require("./protocol");
const {
  REQUEST_NODE_IMAGE,
  REQUEST_NODE_TOOL_RESULT,
  REQUEST_NODE_HISTORY_SUMMARY,
  RESPONSE_NODE_TOOL_USE,
  RESPONSE_NODE_TOKEN_USAGE,
  STOP_REASON_TOOL_USE_REQUESTED,
  TOOL_RESULT_CONTENT_TEXT
} = require("./augment-protocol");
const {
  buildSystemPrompt,
  buildToolMetaByName,
  convertOpenAiTools,
  convertAnthropicTools,
  convertGeminiTools,
  convertOpenAiResponsesTools,
  buildOpenAiMessages,
  buildOpenAiResponsesInput,
  buildAnthropicMessages,
  buildGeminiContents
} = require("./augment-chat");
const shared = require("./augment-chat.shared");
const { maybeSummarizeAndCompactAugmentChatRequest, deleteHistorySummaryCache } = require("./augment-history-summary-auto");
const { sampleJsonFromSchema } = require("./self-test/schema-sample");
const { summarizeToolDefs, dedupeToolDefsByName } = require("./self-test/tool-defs");
const { getByokUpstreamGlobals, fetchLocalToolDefinitionsFromUpstream, selfTestToolsModelExec } = require("./self-test/tools-model");

function hasAuthHeader(headers) {
  const h = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const keys = Object.keys(h).map((k) => String(k || "").trim().toLowerCase());
  return keys.some((k) => k === "authorization" || k === "x-api-key" || k === "api-key" || k === "x-goog-api-key");
}

function providerLabel(provider) {
  const id = normalizeString(provider?.id);
  const type = normalizeString(provider?.type);
  return id ? `${id} (${type || "unknown"})` : `(${type || "unknown"})`;
}

function formatMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n >= 0 ? `${Math.floor(n)}ms` : "n/a";
}

function formatMaybeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.floor(n)) : "";
}

function onePixelPngBase64() {
  // 1x1 png (RGBA). 用于多模态链路连通性测试。
  // 旧的灰度+alpha PNG 在少数网关/上游解码器中会被误判为“invalid image”，这里改为最通用的 RGBA。
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
}

function makeSelfTestToolDefinitions() {
  return [
    {
      name: "echo_self_test",
      description: "BYOK self-test tool. Echo back the input.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string" }
        }
      }
    }
  ];
}

function makeToolResultNode({ id, toolUseId, contentText, isError }) {
  const nodeIdNum = Number(id);
  const nodeId = Number.isFinite(nodeIdNum) && nodeIdNum > 0 ? Math.floor(nodeIdNum) : 1;
  return {
    id: nodeId,
    type: REQUEST_NODE_TOOL_RESULT,
    content: "",
    tool_result_node: {
      tool_use_id: String(toolUseId || ""),
      content: String(contentText || ""),
      is_error: Boolean(isError),
      content_nodes: [
        {
          type: TOOL_RESULT_CONTENT_TEXT,
          text_content: String(contentText || "")
        }
      ]
    }
  };
}

function makeImageNode() {
  return {
    id: 1,
    type: REQUEST_NODE_IMAGE,
    content: "",
    image_node: {
      // format=0 → 默认为 image/png
      format: 0,
      image_data: onePixelPngBase64()
    }
  };
}

function makeBaseAugmentChatRequest({ message, conversationId, toolDefinitions, nodes, chatHistory } = {}) {
  return {
    message: typeof message === "string" ? message : "",
    conversation_id: normalizeString(conversationId) || "",
    chat_history: Array.isArray(chatHistory) ? chatHistory : [],
    tool_definitions: Array.isArray(toolDefinitions) ? toolDefinitions : [],
    nodes: Array.isArray(nodes) ? nodes : [],
    structured_request_nodes: [],
    request_nodes: [],
    agent_memories: "",
    mode: "AGENT",
    prefix: "",
    selected_code: "",
    disable_selected_code_details: false,
    suffix: "",
    diff: "",
    lang: "",
    path: "",
    user_guidelines: "",
    workspace_guidelines: "",
    persona_type: 0,
    silent: false,
    canvas_id: "",
    request_id_override: "",
    rules: null,
    feature_detection_flags: {}
  };
}

async function collectChatStream(gen, { maxChunks = 500 } = {}) {
  const chunks = [];
  const nodes = [];
  let text = "";
  let stop_reason = null;
  for await (const ch of gen) {
    if (chunks.length >= maxChunks) break;
    chunks.push(ch);
    if (typeof ch?.text === "string" && ch.text) text += ch.text;
    if (Array.isArray(ch?.nodes)) nodes.push(...ch.nodes);
    if (ch && typeof ch === "object" && "stop_reason" in ch) stop_reason = ch.stop_reason;
  }
  return { chunks, nodes, text, stop_reason };
}

function extractToolUsesFromNodes(nodes) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const r = n && typeof n === "object" ? n : null;
    if (!r) continue;
    if (Number(r.type) !== RESPONSE_NODE_TOOL_USE) continue;
    const tu = r.tool_use && typeof r.tool_use === "object" ? r.tool_use : r.toolUse && typeof r.toolUse === "object" ? r.toolUse : null;
    const tool_use_id = normalizeString(tu?.tool_use_id ?? tu?.toolUseId);
    const tool_name = normalizeString(tu?.tool_name ?? tu?.toolName);
    const input_json = typeof (tu?.input_json ?? tu?.inputJson) === "string" ? (tu.input_json ?? tu.inputJson) : "";
    const mcp_server_name = normalizeString(tu?.mcp_server_name ?? tu?.mcpServerName);
    const mcp_tool_name = normalizeString(tu?.mcp_tool_name ?? tu?.mcpToolName);
    if (!tool_use_id || !tool_name) continue;
    out.push({ tool_use_id, tool_name, input_json, mcp_server_name, mcp_tool_name });
  }
  return out;
}

function extractTokenUsageFromNodes(nodes) {
  let last = null;
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const r = n && typeof n === "object" ? n : null;
    if (!r) continue;
    if (Number(r.type) !== RESPONSE_NODE_TOKEN_USAGE) continue;
    const tu = r.token_usage && typeof r.token_usage === "object" ? r.token_usage : r.tokenUsage && typeof r.tokenUsage === "object" ? r.tokenUsage : null;
    if (!tu) continue;
    last = tu;
  }
  return last;
}

async function withTimed(labelOrFn, maybeFn) {
  const label = typeof labelOrFn === "string" ? labelOrFn : "";
  const fn = typeof labelOrFn === "function" ? labelOrFn : maybeFn;
  if (typeof fn !== "function") throw new Error("withTimed: fn missing");
  const t0 = nowMs();
  try {
    const res = await fn();
    const ms = nowMs() - t0;
    if (label) debug(`[self-test] ${label} ok (${formatMs(ms)})`);
    return { ok: true, ms, res };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const ms = nowMs() - t0;
    if (label) debug(`[self-test] ${label} FAIL (${formatMs(ms)}): ${m}`);
    return { ok: false, ms, error: m };
  }
}

function countSchemaProperties(schema) {
  const s = schema && typeof schema === "object" && !Array.isArray(schema) ? schema : null;
  const props = s && s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? s.properties : null;
  return props ? Object.keys(props).length : 0;
}

function summarizeCapturedToolsSchemas(toolDefs) {
  const defs = dedupeToolDefsByName(toolDefs);
  let withMcpMeta = 0;
  let sampleOk = 0;
  const failed = [];

  for (const d of defs) {
    const name = normalizeString(d?.name);
    const schema = shared.resolveToolSchema(d);
    const hasMcp = Boolean(normalizeString(d?.mcp_server_name ?? d?.mcpServerName) || normalizeString(d?.mcp_tool_name ?? d?.mcpToolName));
    if (hasMcp) withMcpMeta += 1;
    try {
      const sample = sampleJsonFromSchema(schema, 0);
      JSON.stringify(sample);
      sampleOk += 1;
    } catch {
      if (name) failed.push(name);
    }
  }

  return { toolCount: defs.length, withMcpMeta, sampleOk, sampleFailedNames: failed.slice(0, 12), sampleFailedTruncated: failed.length > 12 };
}

function pickRealToolsForUsabilityProbe(toolDefs, { maxTools = 4 } = {}) {
  const defs = dedupeToolDefsByName(toolDefs);
  const max = Math.max(1, Number(maxTools) || 4);
  if (max >= defs.length) {
    return defs.slice().sort((a, b) => normalizeString(a?.name).localeCompare(normalizeString(b?.name)));
  }
  const byName = new Map(defs.map((d) => [normalizeString(d?.name), d]).filter((x) => x[0]));

  const chosen = [];
  const seen = new Set();
  const pickByName = (name) => {
    const k = normalizeString(name);
    const d = k ? byName.get(k) : null;
    if (!d || seen.has(k)) return false;
    seen.add(k);
    chosen.push(d);
    return true;
  };

  // 明确优先：覆盖常用 + 复杂 schema（如果存在）
  const preferredNames = ["str-replace-editor", "codebase-retrieval", "web-fetch", "web-search", "diagnostics"];
  for (const n of preferredNames) {
    if (chosen.length >= maxTools) break;
    pickByName(n);
  }

  // 覆盖 MCP meta（用于验证 mcp_server_name/mcp_tool_name 能回填到 tool_use）
  if (chosen.length < maxTools) {
    const mcp = defs.filter((d) => normalizeString(d?.mcp_server_name ?? d?.mcpServerName) || normalizeString(d?.mcp_tool_name ?? d?.mcpToolName));
    mcp.sort((a, b) => normalizeString(a?.name).localeCompare(normalizeString(b?.name)));
    for (const d of mcp) {
      if (chosen.length >= maxTools) break;
      pickByName(d.name);
    }
  }

  // 覆盖最大 properties（更容易触发 schema 边界）
  if (chosen.length < maxTools) {
    const ranked = defs
      .map((d) => ({ d, props: countSchemaProperties(shared.resolveToolSchema(d)) }))
      .sort((a, b) => b.props - a.props || normalizeString(a.d?.name).localeCompare(normalizeString(b.d?.name)));
    for (const it of ranked) {
      if (chosen.length >= maxTools) break;
      pickByName(it.d.name);
    }
  }

  // 最后兜底：按 name 排序补齐
  if (chosen.length < maxTools) {
    const sorted = defs.slice().sort((a, b) => normalizeString(a?.name).localeCompare(normalizeString(b?.name)));
    for (const d of sorted) {
      if (chosen.length >= maxTools) break;
      pickByName(d.name);
    }
  }

  return chosen.slice(0, max);
}

function validateOpenAiStrictJsonSchema(schema, issues, path, depth) {
  const d = Number.isFinite(Number(depth)) ? Number(depth) : 0;
  if (d > 50) return;
  if (!schema) return;
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i++) validateOpenAiStrictJsonSchema(schema[i], issues, `${path}[${i}]`, d + 1);
    return;
  }
  if (typeof schema !== "object") return;

  const t = schema.type;
  const hasObjectType =
    t === "object" || (Array.isArray(t) && t.some((x) => normalizeString(x).toLowerCase() === "object"));
  const props = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties : null;
  const hasProps = Boolean(props);

  if (hasObjectType || hasProps) {
    if (schema.additionalProperties !== false) issues.push(`${path || "<root>"}: additionalProperties must be false`);
    const req = Array.isArray(schema.required) ? schema.required : null;
    if (!req) {
      issues.push(`${path || "<root>"}: required must be array`);
    } else if (props) {
      for (const k of Object.keys(props)) {
        if (!req.includes(k)) issues.push(`${path || "<root>"}: required missing '${k}'`);
      }
    }
  }

  if (props) {
    for (const k of Object.keys(props)) validateOpenAiStrictJsonSchema(props[k], issues, `${path ? path + "." : ""}properties.${k}`, d + 1);
  }

  if (schema.items != null) validateOpenAiStrictJsonSchema(schema.items, issues, `${path ? path + "." : ""}items`, d + 1);
  if (schema.prefixItems != null) validateOpenAiStrictJsonSchema(schema.prefixItems, issues, `${path ? path + "." : ""}prefixItems`, d + 1);
  if (schema.not != null) validateOpenAiStrictJsonSchema(schema.not, issues, `${path ? path + "." : ""}not`, d + 1);
  if (schema.if != null) validateOpenAiStrictJsonSchema(schema.if, issues, `${path ? path + "." : ""}if`, d + 1);
  if (schema.then != null) validateOpenAiStrictJsonSchema(schema.then, issues, `${path ? path + "." : ""}then`, d + 1);
  if (schema.else != null) validateOpenAiStrictJsonSchema(schema.else, issues, `${path ? path + "." : ""}else`, d + 1);

  if (Array.isArray(schema.anyOf)) validateOpenAiStrictJsonSchema(schema.anyOf, issues, `${path ? path + "." : ""}anyOf`, d + 1);
  if (Array.isArray(schema.oneOf)) validateOpenAiStrictJsonSchema(schema.oneOf, issues, `${path ? path + "." : ""}oneOf`, d + 1);
  if (Array.isArray(schema.allOf)) validateOpenAiStrictJsonSchema(schema.allOf, issues, `${path ? path + "." : ""}allOf`, d + 1);

  if (schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)) {
    for (const k of Object.keys(schema.$defs)) validateOpenAiStrictJsonSchema(schema.$defs[k], issues, `${path ? path + "." : ""}$defs.${k}`, d + 1);
  }
  if (schema.definitions && typeof schema.definitions === "object" && !Array.isArray(schema.definitions)) {
    for (const k of Object.keys(schema.definitions)) validateOpenAiStrictJsonSchema(schema.definitions[k], issues, `${path ? path + "." : ""}definitions.${k}`, d + 1);
  }
}

function pickProviderModel(provider, fetchedModels) {
  const dm = normalizeString(provider?.defaultModel);
  if (dm) return dm;
  const ms = Array.isArray(provider?.models) ? provider.models : [];
  const firstLocal = ms.map((x) => normalizeString(x)).find(Boolean);
  if (firstLocal) return firstLocal;
  const firstFetched = Array.isArray(fetchedModels) ? fetchedModels.map((x) => normalizeString(x)).find(Boolean) : "";
  return firstFetched || "";
}

function buildOpenAiSystemMessages(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const out = [];
  if (sys) out.push({ role: "system", content: sys });
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()) out.push({ role: m.role, content: m.content });
  }
  return out;
}

function buildAnthropicBlocks(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()) out.push({ role: m.role, content: m.content });
  }
  return { system: sys, messages: out };
}

function buildGeminiTextContents(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const contents = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "model" : m.role === "user" ? "user" : "";
    const content = typeof m.content === "string" ? m.content : "";
    if (!role || !content.trim()) continue;
    contents.push({ role, parts: [{ text: content }] });
  }
  return { systemInstruction: sys, contents };
}

function buildResponsesTextInput(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const input = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "";
    const content = typeof m.content === "string" ? m.content : "";
    if (!role || !content.trim()) continue;
    input.push({ type: "message", role, content });
  }
  return { instructions: sys, input };
}

async function completeTextByProvider({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const type = normalizeString(provider?.type);
  const baseUrl = normalizeString(provider?.baseUrl);
  const apiKey = normalizeString(provider?.apiKey);
  const extraHeaders = provider?.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers) ? provider.headers : {};
  const requestDefaults = provider?.requestDefaults && typeof provider.requestDefaults === "object" && !Array.isArray(provider.requestDefaults) ? provider.requestDefaults : {};

  if (type === "openai_compatible") {
    return await openAiCompleteText({ baseUrl, apiKey, model, messages: buildOpenAiSystemMessages(system, messages), timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "anthropic") {
    const { system: sys, messages: ms } = buildAnthropicBlocks(system, messages);
    return await anthropicCompleteText({ baseUrl, apiKey, model, system: sys, messages: ms, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "openai_responses") {
    const { instructions, input } = buildResponsesTextInput(system, messages);
    return await openAiResponsesCompleteText({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = buildGeminiTextContents(system, messages);
    return await geminiCompleteText({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function streamTextByProvider({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const type = normalizeString(provider?.type);
  const baseUrl = normalizeString(provider?.baseUrl);
  const apiKey = normalizeString(provider?.apiKey);
  const extraHeaders = provider?.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers) ? provider.headers : {};
  const requestDefaults = provider?.requestDefaults && typeof provider.requestDefaults === "object" && !Array.isArray(provider.requestDefaults) ? provider.requestDefaults : {};

  if (type === "openai_compatible") {
    let out = "";
    for await (const d of openAiStreamTextDeltas({ baseUrl, apiKey, model, messages: buildOpenAiSystemMessages(system, messages), timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    return out;
  }
  if (type === "anthropic") {
    let out = "";
    const { system: sys, messages: ms } = buildAnthropicBlocks(system, messages);
    for await (const d of anthropicStreamTextDeltas({ baseUrl, apiKey, model, system: sys, messages: ms, timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    return out;
  }
  if (type === "openai_responses") {
    let out = "";
    const { instructions, input } = buildResponsesTextInput(system, messages);
    for await (const d of openAiResponsesStreamTextDeltas({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    return out;
  }
  if (type === "gemini_ai_studio") {
    let out = "";
    const { systemInstruction, contents } = buildGeminiTextContents(system, messages);
    for await (const d of geminiStreamTextDeltas({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    return out;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

function convertToolsByProviderType(providerType, toolDefs) {
  const t = normalizeString(providerType);
  if (t === "openai_compatible") return convertOpenAiTools(toolDefs);
  if (t === "anthropic") return convertAnthropicTools(toolDefs);
  if (t === "gemini_ai_studio") return convertGeminiTools(toolDefs);
  if (t === "openai_responses") return convertOpenAiResponsesTools(toolDefs);
  throw new Error(`未知 provider.type: ${t}`);
}

function validateConvertedToolsForProvider(providerType, convertedTools) {
  const t = normalizeString(providerType);
  const tools = Array.isArray(convertedTools) ? convertedTools : [];
  if (t !== "openai_responses") return { ok: true, issues: [] };

  const issues = [];
  for (const tool of tools) {
    const name = normalizeString(tool?.name) || normalizeString(tool?.function?.name);
    const params = tool?.parameters ?? tool?.function?.parameters;
    const toolIssues = [];
    validateOpenAiStrictJsonSchema(params, toolIssues, "", 0);
    if (toolIssues.length) {
      issues.push(`${name || "(unknown tool)"}: ${toolIssues[0]}`);
    }
    if (issues.length >= 30) break;
  }
  return { ok: issues.length === 0, issues };
}

async function chatStreamByProvider({ provider, model, req, timeoutMs, abortSignal }) {
  const type = normalizeString(provider?.type);
  const baseUrl = normalizeString(provider?.baseUrl);
  const apiKey = normalizeString(provider?.apiKey);
  const extraHeaders = provider?.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers) ? provider.headers : {};
  const requestDefaults = provider?.requestDefaults && typeof provider.requestDefaults === "object" && !Array.isArray(provider.requestDefaults) ? provider.requestDefaults : {};
  const toolMetaByName = buildToolMetaByName(req.tool_definitions);

  if (type === "openai_compatible") {
    return await collectChatStream(
      openAiChatStreamChunks({
        baseUrl,
        apiKey,
        model,
        messages: buildOpenAiMessages(req),
        tools: convertOpenAiTools(req.tool_definitions),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults,
        toolMetaByName,
        supportToolUseStart: true
      })
    );
  }
  if (type === "anthropic") {
    return await collectChatStream(
      anthropicChatStreamChunks({
        baseUrl,
        apiKey,
        model,
        system: buildSystemPrompt(req),
        messages: buildAnthropicMessages(req),
        tools: convertAnthropicTools(req.tool_definitions),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults,
        toolMetaByName,
        supportToolUseStart: true
      })
    );
  }
  if (type === "openai_responses") {
    const { instructions, input } = buildOpenAiResponsesInput(req);
    return await collectChatStream(
      openAiResponsesChatStreamChunks({
        baseUrl,
        apiKey,
        model,
        instructions,
        input,
        tools: convertOpenAiResponsesTools(req.tool_definitions),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults,
        toolMetaByName,
        supportToolUseStart: true
      })
    );
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = buildGeminiContents(req);
    return await collectChatStream(
      geminiChatStreamChunks({
        baseUrl,
        apiKey,
        model,
        systemInstruction,
        contents,
        tools: convertGeminiTools(req.tool_definitions),
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults,
        toolMetaByName,
        supportToolUseStart: true
      })
    );
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function realToolsToolRoundtripByProvider({ provider, model, toolDefinitions, timeoutMs, abortSignal, maxTools, log }) {
  const providerType = normalizeString(provider?.type);
  const toolDefsAll = Array.isArray(toolDefinitions) ? toolDefinitions : [];
  const uniqueDefs = dedupeToolDefsByName(toolDefsAll);
  const uniqueCount = uniqueDefs.length;
  if (!uniqueCount) return { ok: false, detail: "no tools" };

  const desired = Number.isFinite(Number(maxTools)) && Number(maxTools) > 0 ? Math.floor(Number(maxTools)) : uniqueCount;
  const pickedToolDefs = pickRealToolsForUsabilityProbe(toolDefsAll, { maxTools: Math.max(1, Math.min(desired, uniqueCount)) });
  const toolNames = pickedToolDefs.map((d) => normalizeString(d?.name)).filter(Boolean);
  if (!toolNames.length) return { ok: false, detail: "no toolNames" };

  const toolDefsByName = new Map(pickedToolDefs.map((d) => [normalizeString(d?.name), d]).filter((x) => x[0]));

  const metaMismatches = [];
  const callFailed = [];
  const roundtripFailed = [];
  let calledOk = 0;
  let roundtripOk = 0;

  const emit = (line) => {
    try {
      if (typeof log === "function") log(String(line || ""));
    } catch {}
  };

  const buildExampleArgsJson = (toolDef) => {
    const rawSchema = shared.resolveToolSchema(toolDef);
    const schema = providerType === "openai_responses" ? shared.coerceOpenAiStrictJsonSchema(rawSchema, 0) : rawSchema;
    const sample = sampleJsonFromSchema(schema, 0);
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      // 少量启发式：减少上游/网关对 format/pattern 的额外校验风险
      if (typeof sample.url === "string") sample.url = "https://example.com";
      if (typeof sample.uri === "string") sample.uri = "https://example.com";
      if (typeof sample.query === "string") sample.query = "hello";
      if (typeof sample.text === "string") sample.text = "hello";
      if (typeof sample.path === "string") sample.path = "selftest.txt";
    }
    try {
      return JSON.stringify(sample ?? {});
    } catch {
      return "{}";
    }
  };

  // 目标：覆盖所有真实工具，但减少请求量/配额压力。
  // 方案：按 batch 要求模型在同一条 assistant 消息里一次性调用多个工具，然后回填多个 tool_result。
  const batchSize = 6;
  const batches = [];
  for (let i = 0; i < toolNames.length; i += batchSize) batches.push(toolNames.slice(i, i + batchSize));

  for (let bi = 0; bi < batches.length; bi++) {
    const namesBatch = batches[bi];
    const defsBatch = namesBatch.map((n) => toolDefsByName.get(n)).filter(Boolean);
    if (!defsBatch.length) continue;

    const argsLines = [];
    for (const toolName of namesBatch) {
      const toolDef = toolDefsByName.get(toolName) || null;
      if (!toolDef) continue;
      argsLines.push(`- ${toolName}: ${buildExampleArgsJson(toolDef)}`);
    }

    const convId = `byok-selftest-realtools-batch-${randomId()}`;
    const req1 = makeBaseAugmentChatRequest({
      message:
        `Self-test (real tools) batch ${bi + 1}/${batches.length}.\n` +
        `You MUST call ALL tools below in THIS assistant message.\n` +
        `- Do NOT output normal text; only call tools.\n` +
        `- Call each tool exactly once.\n` +
        `- Use EXACT JSON arguments:\n` +
        argsLines.join("\n") +
        `\n`,
      conversationId: convId,
      toolDefinitions: defsBatch,
      nodes: [],
      chatHistory: []
    });

    let res1;
    try {
      res1 = await chatStreamByProvider({ provider, model, req: req1, timeoutMs, abortSignal });
    } catch (err) {
      if (abortSignal && abortSignal.aborted) throw err;
      for (const name of namesBatch) callFailed.push(name);
      emit(
        `[${providerLabel(provider)}] realTools batch ${bi + 1}/${batches.length}: FAIL (chat-stream error: ${err instanceof Error ? err.message : String(err)})`
      );
      continue;
    }

    const toolUses = extractToolUsesFromNodes(res1?.nodes);
    const usedByName = new Map(); // tool_name -> tool_use
    for (const t of toolUses) {
      const n = normalizeString(t?.tool_name);
      if (!n || usedByName.has(n)) continue;
      if (!namesBatch.includes(n)) continue;
      usedByName.set(n, t);
    }

    for (const toolName of namesBatch) {
      const toolDef = toolDefsByName.get(toolName) || null;
      const match = usedByName.get(toolName) || null;
      if (!match) {
        const sr = normalizeString(res1?.stop_reason) || "n/a";
        callFailed.push(toolName);
        emit(`[${providerLabel(provider)}] realTools batch ${bi + 1}/${batches.length}: FAIL tool=${toolName} (no tool_use, stop_reason=${sr})`);
        continue;
      }

      calledOk += 1;

      const expectedMcpServerName = normalizeString(toolDef?.mcp_server_name ?? toolDef?.mcpServerName);
      const expectedMcpToolName = normalizeString(toolDef?.mcp_tool_name ?? toolDef?.mcpToolName);
      if (expectedMcpServerName && normalizeString(match.mcp_server_name) !== expectedMcpServerName) {
        metaMismatches.push(`mcp_server_name ${toolName}: expected=${expectedMcpServerName} got=${normalizeString(match.mcp_server_name) || "?"}`);
      }
      if (expectedMcpToolName && normalizeString(match.mcp_tool_name) !== expectedMcpToolName) {
        metaMismatches.push(`mcp_tool_name ${toolName}: expected=${expectedMcpToolName} got=${normalizeString(match.mcp_tool_name) || "?"}`);
      }
    }

    // 没有任何 tool_use 时，不做 roundtrip（callFailed 已覆盖）
    if (usedByName.size === 0) continue;

    const exchange1 = {
      request_id: `selftest_realtools_batch_${bi + 1}_1`,
      request_message: req1.message,
      response_text: "",
      request_nodes: [],
      structured_request_nodes: [],
      nodes: [],
      response_nodes: Array.isArray(res1?.nodes) ? res1.nodes : [],
      structured_output_nodes: []
    };

    const req2 = makeBaseAugmentChatRequest({
      message: `Self-test (real tools) batch ${bi + 1}/${batches.length}: Tool results received. Reply with OK-realtools-batch. Do NOT call any tool.`,
      conversationId: convId,
      toolDefinitions: defsBatch,
      nodes: [],
      chatHistory: [exchange1]
    });

    let toolResultNodeId = 1;
    req2.request_nodes = Array.from(usedByName.entries()).map(([toolName, match]) =>
      makeToolResultNode({
        id: toolResultNodeId++,
        toolUseId: match.tool_use_id,
        contentText: JSON.stringify({ ok: true, tool: toolName }),
        isError: false
      })
    );

    let res2;
    try {
      res2 = await chatStreamByProvider({ provider, model, req: req2, timeoutMs, abortSignal });
    } catch (err) {
      if (abortSignal && abortSignal.aborted) throw err;
      for (const toolName of usedByName.keys()) roundtripFailed.push(toolName);
      emit(
        `[${providerLabel(provider)}] realTools batch ${bi + 1}/${batches.length}: FAIL (toolRoundtrip error: ${err instanceof Error ? err.message : String(err)})`
      );
      continue;
    }

    const text2 = normalizeString(res2?.text);
    if (!text2) {
      const sr = normalizeString(res2?.stop_reason) || "n/a";
      for (const toolName of usedByName.keys()) roundtripFailed.push(toolName);
      emit(`[${providerLabel(provider)}] realTools batch ${bi + 1}/${batches.length}: FAIL (empty assistant text after tool_result, stop_reason=${sr})`);
      continue;
    }

    for (const toolName of usedByName.keys()) roundtripOk += 1;

    emit(`[${providerLabel(provider)}] realTools progress: batch ${bi + 1}/${batches.length} called=${usedByName.size}/${namesBatch.length}`);
  }

  const detailParts = [`tools=${toolNames.length}/${uniqueCount}`, `call=${calledOk}/${toolNames.length}`, `roundtrip=${roundtripOk}/${toolNames.length}`];
  if (callFailed.length) detailParts.push(`call_fail=${callFailed.length} first=${callFailed[0]}`);
  if (roundtripFailed.length) detailParts.push(`roundtrip_fail=${roundtripFailed.length} first=${roundtripFailed[0]}`);
  if (metaMismatches.length) detailParts.push(`meta_mismatch=${metaMismatches.length} first=${metaMismatches[0]}`);

  const ok = callFailed.length === 0 && roundtripFailed.length === 0 && metaMismatches.length === 0;
  return { ok, detail: detailParts.join(" ").trim() };
}

async function selfTestProvider({ cfg, provider, timeoutMs, abortSignal, log, capturedToolDefinitions }) {
  const t0 = nowMs();
  const pid = normalizeString(provider?.id) || "";
  const type = normalizeString(provider?.type);

  const entry = {
    providerId: pid,
    providerType: type,
    model: "",
    tests: [],
    ok: true,
    msTotal: 0
  };

  const record = (t) => {
    const test = t && typeof t === "object" ? t : { name: "unknown", ok: false, ms: 0, detail: "invalid test record" };
    entry.tests.push(test);
    if (test.ok === false) entry.ok = false;
    const badge = test.ok === true ? "ok" : "FAIL";
    const d = normalizeString(test.detail);
    log(`[${providerLabel(provider)}] ${test.name}: ${badge} (${formatMs(test.ms)})${d ? ` ${d}` : ""}`.trim());
    if (test.ok === false) {
      debug(`[self-test] ${providerLabel(provider)} ${test.name}: FAIL (${formatMs(test.ms)})${d ? ` ${d}` : ""}`.trim());
    }
  };

  try {
  const baseUrl = normalizeString(provider?.baseUrl);
  const apiKey = normalizeString(provider?.apiKey);
  const headers = provider?.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers) ? provider.headers : {};
  const authOk = Boolean(apiKey) || hasAuthHeader(headers);
  if (!type || !baseUrl || !authOk) {
    record({
      name: "config",
      ok: false,
      ms: 0,
      detail: `type/baseUrl/auth 未配置完整（type=${type || "?"}, baseUrl=${baseUrl || "?"}, auth=${authOk ? "set" : "empty"}）`
    });
    log(`[${providerLabel(provider)}] done`);
    return entry;
  }

  log(`[${providerLabel(provider)}] start`);

  const modelsRes = await withTimed(async () => await fetchProviderModels({ provider, timeoutMs: Math.min(15000, timeoutMs), abortSignal }));
  if (modelsRes.ok) {
    const models = Array.isArray(modelsRes.res) ? modelsRes.res : [];
    record({ name: "models", ok: true, ms: modelsRes.ms, detail: `models=${models.length}` });
    entry.model = pickProviderModel(provider, models);
  } else {
    record({ name: "models", ok: false, ms: modelsRes.ms, detail: modelsRes.error });
    entry.model = pickProviderModel(provider, []);
  }

  const model = normalizeString(entry.model);
  if (!model) {
    record({ name: "model", ok: false, ms: 0, detail: "未找到可用 model（请配置 providers[].defaultModel 或 models[]）" });
    log(`[${providerLabel(provider)}] done`);
    return entry;
  }

  const completionRes = await withTimed(async () => {
    const text = await completeTextByProvider({
      provider,
      model,
      system: "You are running a connectivity self-test. Output only: OK",
      messages: [{ role: "user", content: "OK" }],
      timeoutMs,
      abortSignal
    });
    return text;
  });
  if (completionRes.ok && normalizeString(completionRes.res)) {
    record({ name: "completeText", ok: true, ms: completionRes.ms, detail: `len=${String(completionRes.res).length}` });
  } else {
    record({ name: "completeText", ok: false, ms: completionRes.ms, detail: completionRes.ok ? "empty output" : completionRes.error });
  }

  const streamRes = await withTimed(async () => {
    const text = await streamTextByProvider({
      provider,
      model,
      system: "You are running a streaming self-test. Output only: OK",
      messages: [{ role: "user", content: "OK" }],
      timeoutMs,
      abortSignal
    });
    return text;
  });
  if (streamRes.ok && normalizeString(streamRes.res)) {
    record({ name: "streamText", ok: true, ms: streamRes.ms, detail: `len=${String(streamRes.res).length}` });
  } else {
    record({ name: "streamText", ok: false, ms: streamRes.ms, detail: streamRes.ok ? "empty output" : streamRes.error });
  }

  // /next-edit-stream prompt builder smoke test（走非流式 completeText）
  const nextEditRes = await withTimed(async () => {
    const body = {
      instruction: "Replace foo with bar in the selected range.",
      path: "selftest.js",
      lang: "javascript",
      prefix: "const x = '",
      selected_text: "foo",
      suffix: "';\nconsole.log(x);\n"
    };
    const { system, messages } = buildMessagesForEndpoint("/next-edit-stream", body);
    return await completeTextByProvider({ provider, model, system, messages, timeoutMs, abortSignal });
  });
  if (nextEditRes.ok && normalizeString(nextEditRes.res)) {
    record({ name: "nextEdit", ok: true, ms: nextEditRes.ms, detail: `len=${String(nextEditRes.res).length}` });
  } else {
    record({ name: "nextEdit", ok: false, ms: nextEditRes.ms, detail: nextEditRes.ok ? "empty output" : nextEditRes.error });
  }

  // /next_edit_loc prompt builder smoke test（走非流式 completeText）
  const nextEditLocRes = await withTimed(async () => {
    const body = {
      instruction: "Find the most relevant place to apply the next edit.",
      path: "selftest.js",
      num_results: 2,
      diagnostics: [
        {
          path: "selftest.js",
          range: { start: { line: 0 }, end: { line: 0 } },
          message: "dummy diagnostic for smoke test"
        }
      ]
    };
    const { system, messages } = buildMessagesForEndpoint("/next_edit_loc", body);
    return await completeTextByProvider({ provider, model, system, messages, timeoutMs, abortSignal });
  });
  if (nextEditLocRes.ok && normalizeString(nextEditLocRes.res)) {
    record({ name: "nextEditLoc", ok: true, ms: nextEditLocRes.ms, detail: `len=${String(nextEditLocRes.res).length}` });
  } else {
    record({ name: "nextEditLoc", ok: false, ms: nextEditLocRes.ms, detail: nextEditLocRes.ok ? "empty output" : nextEditLocRes.error });
  }

  // chat-stream（基础）
  const chatReq = makeBaseAugmentChatRequest({
    message: "Self-test: reply with OK-chat (no markdown).",
    conversationId: `byok-selftest-${randomId()}`,
    toolDefinitions: [],
    nodes: [],
    chatHistory: []
  });
  const chatRes = await withTimed(async () => await chatStreamByProvider({ provider, model, req: chatReq, timeoutMs, abortSignal }));
  if (chatRes.ok && (normalizeString(chatRes.res?.text) || (Array.isArray(chatRes.res?.nodes) && chatRes.res.nodes.length))) {
    const tu = extractTokenUsageFromNodes(chatRes.res?.nodes);
    const usage = tu
      ? ` tokens=${formatMaybeInt(tu.input_tokens ?? tu.inputTokens) || "?"}/${formatMaybeInt(tu.output_tokens ?? tu.outputTokens) || "?"} cached=${formatMaybeInt(tu.cache_read_input_tokens ?? tu.cacheReadInputTokens) || "0"}`
      : "";
    record({
      name: "chatStream",
      ok: true,
      ms: chatRes.ms,
      detail: `textLen=${String(chatRes.res?.text || "").length} nodes=${Array.isArray(chatRes.res?.nodes) ? chatRes.res.nodes.length : 0}${usage}`
    });
  } else {
    record({ name: "chatStream", ok: false, ms: chatRes.ms, detail: chatRes.ok ? "empty output" : chatRes.error });
  }

  // 真实环境工具集：schema 校验 + tool_use/tool_result 往返（不执行真实工具，仅验证“真实工具集”能跑通工具链路/配对）
  const realToolDefs = Array.isArray(capturedToolDefinitions) ? capturedToolDefinitions : [];
  if (realToolDefs.length) {
    const sum = summarizeToolDefs(realToolDefs);
    const schemaRes = await withTimed(async () => {
      const converted = convertToolsByProviderType(type, realToolDefs);
      const v = validateConvertedToolsForProvider(type, converted);
      if (!v.ok) throw new Error(v.issues.slice(0, 8).join(" | "));
      return { convertedCount: Array.isArray(converted) ? converted.length : 0, firstNames: sum.names };
    });
    if (schemaRes.ok) {
      record({
        name: "realToolsSchema",
        ok: true,
        ms: schemaRes.ms,
        detail: `tools=${sum.count} converted=${schemaRes.res?.convertedCount ?? "?"} names=${sum.names.join(",")}${sum.namesTruncated ? ",…" : ""}`
      });
    } else {
      record({ name: "realToolsSchema", ok: false, ms: schemaRes.ms, detail: schemaRes.error });
    }

    // 真实工具可用性：在真实工具 schema 下触发 tool_use + tool_result 往返（不执行真实工具；仅验证工具链路/配对逻辑对真实工具集可用）
    const realToolsRoundtripRes = await withTimed(
      async () => await realToolsToolRoundtripByProvider({ provider, model, toolDefinitions: realToolDefs, timeoutMs, abortSignal, log, maxTools: 9999 })
    );
    if (realToolsRoundtripRes.ok && realToolsRoundtripRes.res?.ok) {
      record({ name: "realToolsToolRoundtrip", ok: true, ms: realToolsRoundtripRes.ms, detail: realToolsRoundtripRes.res?.detail || "" });
    } else {
      record({
        name: "realToolsToolRoundtrip",
        ok: false,
        ms: realToolsRoundtripRes.ms,
        detail: realToolsRoundtripRes.ok ? (realToolsRoundtripRes.res?.detail || "failed") : realToolsRoundtripRes.error
      });
    }
  } else {
    record({ name: "realToolsSchema", ok: true, ms: 0, detail: "skipped (no captured tool_definitions yet)" });
    record({ name: "realToolsToolRoundtrip", ok: true, ms: 0, detail: "skipped (no captured tool_definitions yet)" });
  }

  // chat-stream（多模态 + 工具）
  const toolDefs = makeSelfTestToolDefinitions();
  const toolReq = makeBaseAugmentChatRequest({
    message:
      "Self-test tool call.\n1) You MUST call the tool echo_self_test with JSON arguments {\"text\":\"hello\"}.\n2) Do not output normal text; only call the tool.",
    conversationId: `byok-selftest-${randomId()}`,
    toolDefinitions: toolDefs,
    nodes: [makeImageNode()],
    chatHistory: []
  });

  const toolChatRes = await withTimed(async () => await chatStreamByProvider({ provider, model, req: toolReq, timeoutMs, abortSignal }));
  if (!toolChatRes.ok) {
    record({ name: "tools+multimodal", ok: false, ms: toolChatRes.ms, detail: toolChatRes.error });
    return entry;
  }

  const toolUses = extractToolUsesFromNodes(toolChatRes.res?.nodes);
  if (!toolUses.length) {
    record({
      name: "tools+multimodal",
      ok: true,
      ms: toolChatRes.ms,
      detail: `no tool_use observed (stop_reason=${normalizeString(toolChatRes.res?.stop_reason) || "n/a"})`
    });
    record({ name: "toolRoundtrip", ok: true, ms: 0, detail: "skipped (no tool call)" });
    log(`[${providerLabel(provider)}] done`);
    return entry;
  }

  const first = toolUses[0];
  record({
    name: "tools+multimodal",
    ok: true,
    ms: toolChatRes.ms,
    detail: `tool=${first.tool_name} id=${first.tool_use_id} stop_reason=${normalizeString(toolChatRes.res?.stop_reason) || "n/a"}`
  });

  // tool_result round-trip：把 tool_use 放入 history，再在下一轮 request_nodes 回填 tool_result
  const exchange1 = {
    request_id: "selftest_req_1",
    request_message: toolReq.message,
    response_text: "",
    request_nodes: [],
    structured_request_nodes: [],
    nodes: toolReq.nodes,
    response_nodes: Array.isArray(toolChatRes.res?.nodes) ? toolChatRes.res.nodes : [],
    structured_output_nodes: []
  };

  const toolReq2 = makeBaseAugmentChatRequest({
    message: "Tool result received. Reply with OK-tool.",
    conversationId: toolReq.conversation_id,
    toolDefinitions: toolDefs,
    nodes: [],
    chatHistory: [exchange1]
  });
  toolReq2.request_nodes = [makeToolResultNode({ toolUseId: first.tool_use_id, contentText: "{\"ok\":true}", isError: false })];

  const toolRoundtripRes = await withTimed(async () => await chatStreamByProvider({ provider, model, req: toolReq2, timeoutMs, abortSignal }));
  if (toolRoundtripRes.ok && normalizeString(toolRoundtripRes.res?.text)) {
    record({ name: "toolRoundtrip", ok: true, ms: toolRoundtripRes.ms, detail: `textLen=${String(toolRoundtripRes.res?.text || "").length}` });
  } else {
    record({ name: "toolRoundtrip", ok: false, ms: toolRoundtripRes.ms, detail: toolRoundtripRes.ok ? "empty output" : toolRoundtripRes.error });
  }

  // 提示：并非所有模型都会稳定 tool-call（尤其是 defaultModel 不是工具模型时），因此 toolRoundtrip 失败不一定代表 BYOK 协议有问题。
  if (normalizeString(toolRoundtripRes.error) && normalizeString(toolRoundtripRes.error).includes("tool_result_missing")) {
    record({ name: "note", ok: true, ms: 0, detail: "观察到 tool_result_missing：说明工具执行/回填缺失被容错降级（不是 400/422）。" });
  }

  if (toolChatRes.res?.stop_reason && toolChatRes.res.stop_reason !== STOP_REASON_TOOL_USE_REQUESTED) {
    record({ name: "note", ok: true, ms: 0, detail: `模型 stop_reason=${toolChatRes.res.stop_reason}（可能未真正进入工具模式）` });
  }

  log(`[${providerLabel(provider)}] done`);
  return entry;
  } finally {
    entry.msTotal = nowMs() - t0;
    debug(`[self-test] provider done ${providerLabel(provider)} ok=${String(entry.ok)} (${formatMs(entry.msTotal)})`);
  }
}

async function selfTestHistorySummary({ cfg, fallbackProvider, fallbackModel, timeoutMs, abortSignal, log }) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const hs = c.historySummary && typeof c.historySummary === "object" && !Array.isArray(c.historySummary) ? c.historySummary : {};

  const convId = `byok-selftest-history-${randomId()}`;
  const mkEx = (i) => ({
    request_id: `selftest_h_${i}`,
    request_message: `User message ${i}: ` + "x".repeat(2000),
    response_text: `Assistant response ${i}: ` + "y".repeat(2000),
    request_nodes: [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  });
  const history = Array.from({ length: 6 }, (_, i) => mkEx(i + 1));

  // 只在内存中强制开启，避免用户必须手动启用 historySummary 才能自检
  const cfg2 = JSON.parse(JSON.stringify(c));
  cfg2.historySummary = {
    ...(hs && typeof hs === "object" ? hs : {}),
    enabled: true,
    triggerOnHistorySizeChars: 2000,
    historyTailSizeCharsToExclude: 0,
    minTailExchanges: 2,
    maxTokens: 256,
    timeoutSeconds: Math.max(5, Math.floor((Number(timeoutMs) || 30000) / 1000)),
    cacheTtlMs: 5 * 60 * 1000
  };

  const req1 = makeBaseAugmentChatRequest({ message: "continue", conversationId: convId, chatHistory: history });
  const req2 = makeBaseAugmentChatRequest({ message: "continue", conversationId: convId, chatHistory: history });

  const run1 = await withTimed(async () => {
    return await maybeSummarizeAndCompactAugmentChatRequest({
      cfg: cfg2,
      req: req1,
      requestedModel: fallbackModel,
      fallbackProvider,
      fallbackModel,
      timeoutMs,
      abortSignal
    });
  });

  const run2 = await withTimed(async () => {
    return await maybeSummarizeAndCompactAugmentChatRequest({
      cfg: cfg2,
      req: req2,
      requestedModel: fallbackModel,
      fallbackProvider,
      fallbackModel,
      timeoutMs,
      abortSignal
    });
  });

  try {
    await deleteHistorySummaryCache(convId);
  } catch {}

  const ok1 = run1.ok && run1.res === true;
  const ok2 = run2.ok && run2.res === true;
  const injected1 = Array.isArray(req1.request_nodes) && req1.request_nodes.some((n) => shared.normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY);
  const injected2 = Array.isArray(req2.request_nodes) && req2.request_nodes.some((n) => shared.normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY);

  if (ok1 && ok2) {
    log(`[historySummary] ok (run1=${run1.ms}ms injected=${injected1} run2=${run2.ms}ms injected=${injected2})`);
    // run2 应该命中 cache（一般更快），但不同环境也可能依旧触发网络；这里只做观察信息
    return { ok: true, ms: run1.ms + run2.ms, detail: `run1=${run1.ms}ms run2=${run2.ms}ms` };
  }

  const detail = `run1=${run1.ok ? String(run1.res) : run1.error} run2=${run2.ok ? String(run2.res) : run2.error}`;
  return { ok: false, ms: run1.ms + run2.ms, detail };
}

function selfTestOpenAiResponsesStrictSchema(log) {
  const defs = [
    {
      name: "schema_self_test",
      input_schema: {
        type: "object",
        properties: {
          a: { type: "string" },
          insert_line_1: { type: "integer" }
        },
        required: ["a"]
      }
    }
  ];
  const tools = convertOpenAiResponsesTools(defs);
  const p0 = tools?.[0]?.parameters;
  const props = p0 && typeof p0 === "object" && p0.properties && typeof p0.properties === "object" ? Object.keys(p0.properties) : [];
  const req = Array.isArray(p0?.required) ? p0.required : [];
  const missing = props.filter((k) => !req.includes(k));
  const ok = p0 && p0.additionalProperties === false && Array.isArray(p0.required) && missing.length === 0;
  log(`[responses strict schema] additionalProperties=${String(p0?.additionalProperties)} required_ok=${String(missing.length === 0)} props=${props.length}`);
  return ok;
}

async function runSelfTest({ cfg, timeoutMs, abortSignal, onEvent } = {}) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const providers = Array.isArray(c.providers) ? c.providers : [];
  const t = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : 30000;
  const runId = randomId();
  const runLabel = `run=${runId}`;

  const report = {
    runId,
    startedAtMs: nowMs(),
    finishedAtMs: 0,
    ok: true,
    global: { tests: [], capturedTools: null },
    providers: []
  };

  const emit = (ev) => {
    try {
      if (typeof onEvent === "function") onEvent(ev);
    } catch {}
  };
  const log = (line) => emit({ type: "log", line: String(line || "") });

  log("Self Test started.");
  debug(`[self-test] start ${runLabel} providers=${providers.length} timeoutMs=${t}`);

  const captured = getLastCapturedToolDefinitions();
  const capturedDefs0 = Array.isArray(captured?.toolDefinitions) ? captured.toolDefinitions : [];
  const capturedMeta0 = captured?.meta && typeof captured.meta === "object" ? captured.meta : null;
  const capturedAtMs0 = Number(captured?.capturedAtMs) || 0;

  let toolDefsForSelfTest = capturedDefs0;
  let toolDefsSource = capturedDefs0.length ? "captured" : "none";
  let toolDefsMeta = capturedMeta0;
  let toolDefsCapturedAtMs = capturedAtMs0;

  // captured tools 为空时，优先尝试从上游 toolsModel 直接获取（覆盖“真实环境”的本地/远程工具全集）
  if (!toolDefsForSelfTest.length) {
    log("[captured tools] none → 尝试从上游 toolsModel 直接拉取真实工具定义…");
    const localRes = await withTimed(`${runLabel} capturedTools.fetchFromUpstream`, async () => await fetchLocalToolDefinitionsFromUpstream({ timeoutMs: Math.min(20000, t), abortSignal, log }));
    if (localRes.ok && Array.isArray(localRes.res?.defs) && localRes.res.defs.length) {
      toolDefsForSelfTest = localRes.res.defs;
      toolDefsSource = "upstream(toolsModel)";
      toolDefsMeta = localRes.res.meta || null;
      toolDefsCapturedAtMs = Number(localRes.res.meta?.capturedAtMs) || nowMs();
      try {
        const convFromUpstream = normalizeString(getByokUpstreamGlobals().upstream?.augmentExtension?._checkpointManager?.currentConversationId);
        captureAugmentToolDefinitions(toolDefsForSelfTest, {
          ...(toolDefsMeta || {}),
          ...(convFromUpstream ? { conversationId: convFromUpstream } : {}),
          capturedBy: "self-test"
        });
      } catch {}
      log(`[captured tools] fetched count=${toolDefsForSelfTest.length} via ${toolDefsSource}`);
    } else {
      const msg = localRes.ok ? normalizeString(localRes.res?.detail) || "empty tool list" : localRes.error;
      log(`[captured tools] upstream toolsModel fetch failed: ${msg}`);
    }
  }

  if (!toolDefsForSelfTest.length) {
    log(
      "[captured tools] none（无法从上游 toolsModel 自动拉取；请确认你安装的是 dist/*.byok.vsix 打包版且 extension.js 已注入 __augment_byok_expose_upstream_v1；或先跑一次 Agent /chat-stream 以捕获 tool_definitions）"
    );
  }

  const capturedSummary = summarizeToolDefs(toolDefsForSelfTest);
  const capturedAgeMs = toolDefsCapturedAtMs ? Math.max(0, nowMs() - Number(toolDefsCapturedAtMs)) : 0;
  report.global.capturedTools = {
    count: capturedSummary.count,
    capturedAtMs: toolDefsCapturedAtMs,
    ageMs: capturedSummary.count ? capturedAgeMs : 0,
    meta: toolDefsMeta,
    source: toolDefsSource,
    namesPreview: capturedSummary.names
  };

  if (capturedSummary.count) {
    log(`[captured tools] count=${capturedSummary.count} age=${formatMs(capturedAgeMs)} source=${toolDefsSource} names=${capturedSummary.names.join(",")}${capturedSummary.namesTruncated ? ",…" : ""}`);
    report.global.tests.push({ name: "capturedToolsAvailable", ok: true, detail: `count=${capturedSummary.count} source=${toolDefsSource}` });
  } else {
    report.global.tests.push({
      name: "capturedToolsAvailable",
      ok: false,
      detail: "未捕获到真实 tool_definitions 且无法自动拉取；Self Test 无法覆盖真实工具集"
    });
    report.ok = false;
  }

  // captured tools：schema 可解析性/可 JSON 化（不执行工具）
  if (toolDefsForSelfTest.length) {
    const schemaSum = summarizeCapturedToolsSchemas(toolDefsForSelfTest);
    const ok = schemaSum.sampleOk === schemaSum.toolCount;
    report.global.tests.push({
      name: "capturedToolsSchemaSamples",
      ok,
      detail: `sampleable=${schemaSum.sampleOk}/${schemaSum.toolCount} mcpMeta=${schemaSum.withMcpMeta}${schemaSum.sampleFailedNames.length ? ` failed=${schemaSum.sampleFailedNames.join(",")}${schemaSum.sampleFailedTruncated ? ",…" : ""}` : ""}`
    });
    log(
      `[captured tools schema] sampleable=${schemaSum.sampleOk}/${schemaSum.toolCount} mcpMeta=${schemaSum.withMcpMeta}${schemaSum.sampleFailedNames.length ? ` failed=${schemaSum.sampleFailedNames.join(",")}${schemaSum.sampleFailedTruncated ? ",…" : ""}` : ""}`
    );
    if (!ok) report.ok = false;
  } else {
    report.global.tests.push({ name: "capturedToolsSchemaSamples", ok: true, detail: "skipped (no captured tools)" });
  }

  const localSchemaOk = selfTestOpenAiResponsesStrictSchema(log);
  report.global.tests.push({ name: "responsesStrictSchema", ok: Boolean(localSchemaOk) });
  if (!localSchemaOk) report.ok = false;

  if (toolDefsForSelfTest.length) {
    const strictCaptured = await withTimed(`${runLabel} responsesStrictSchema(capturedTools)`, async () => {
      const tools = convertOpenAiResponsesTools(toolDefsForSelfTest);
      const v = validateConvertedToolsForProvider("openai_responses", tools);
      if (!v.ok) throw new Error(v.issues.slice(0, 10).join(" | "));
      return { tools: Array.isArray(tools) ? tools.length : 0 };
    });
    if (strictCaptured.ok) {
      report.global.tests.push({ name: "responsesStrictSchema(capturedTools)", ok: true, ms: strictCaptured.ms, detail: `tools=${strictCaptured.res?.tools ?? "?"}` });
      log(`[responses strict schema][capturedTools] ok (${formatMs(strictCaptured.ms)}) tools=${strictCaptured.res?.tools ?? "?"}`);
    } else {
      report.global.tests.push({ name: "responsesStrictSchema(capturedTools)", ok: false, ms: strictCaptured.ms, detail: strictCaptured.error });
      log(`[responses strict schema][capturedTools] FAIL (${formatMs(strictCaptured.ms)}) ${strictCaptured.error}`);
      report.ok = false;
    }
  } else {
    report.global.tests.push({ name: "responsesStrictSchema(capturedTools)", ok: true, ms: 0, detail: "skipped (no captured tools)" });
  }

  // 真实工具执行：对真实环境的 tools 做一次“真实执行”验证（通过上游 toolsModel；会产生一定副作用/访问网络/打开浏览器）
  if (toolDefsForSelfTest.length) {
    const execRes = await withTimed(`${runLabel} toolsExec`, async () => await selfTestToolsModelExec({ toolDefinitions: toolDefsForSelfTest, timeoutMs: t, abortSignal, log }));
    if (execRes.ok) {
      const r = execRes.res && typeof execRes.res === "object" ? execRes.res : null;
      const ms = Number.isFinite(Number(r?.ms)) && Number(r?.ms) >= 0 ? Number(r.ms) : execRes.ms;
      const ok = Boolean(r?.ok);
      report.global.tests.push({ name: "toolsExec", ok, ms, detail: normalizeString(r?.detail) || "" });
      report.global.toolExec = {
        ok,
        ms,
        detail: normalizeString(r?.detail) || "",
        failedTools: Array.isArray(r?.failedTools) ? r.failedTools : [],
        failedToolsTruncated: Boolean(r?.failedToolsTruncated),
        toolResults: r?.toolResults && typeof r.toolResults === "object" ? r.toolResults : null
      };
      if (!ok) report.ok = false;
    } else {
      report.global.tests.push({ name: "toolsExec", ok: false, ms: execRes.ms, detail: execRes.error });
      report.ok = false;
    }
  } else {
    report.global.tests.push({ name: "toolsExec", ok: true, ms: 0, detail: "skipped (no tools)" });
  }

  const providerResults = [];
  for (const p of providers) {
    const res = await selfTestProvider({ cfg: c, provider: p, timeoutMs: t, abortSignal, log, capturedToolDefinitions: toolDefsForSelfTest });
    providerResults.push(res);
    report.providers.push(res);
    if (!res.ok) report.ok = false;
  }

  // historySummary：用第一个可用 provider 作为 fallback（真实逻辑也是：hs.providerId 不配时 fallback 到当前 provider）
  const firstOkProvider = providers.find((p) => normalizeString(p?.type) && normalizeString(p?.baseUrl) && (normalizeString(p?.apiKey) || hasAuthHeader(p?.headers)));
  const fallbackProvider = firstOkProvider || providers[0] || null;
  const fallbackModel = normalizeString(fallbackProvider?.defaultModel) || normalizeString(fallbackProvider?.models?.[0]) || "";
  if (fallbackProvider && fallbackModel) {
    const hsRes = await selfTestHistorySummary({ cfg: c, fallbackProvider, fallbackModel, timeoutMs: t, abortSignal, log });
    report.global.tests.push({ name: "historySummary", ok: Boolean(hsRes.ok), detail: hsRes.detail, ms: hsRes.ms });
    if (!hsRes.ok) report.ok = false;
  } else {
    report.global.tests.push({ name: "historySummary", ok: true, detail: "skipped (no provider configured)" });
  }

  report.finishedAtMs = nowMs();
  log(`Self Test finished. ok=${String(report.ok)}`);
  debug(`[self-test] done ${runLabel} providers=${report.providers.length} ok=${String(report.ok)} totalMs=${formatMs(report.finishedAtMs - report.startedAtMs)}`);
  emit({ type: "done", report });
  return report;
}

module.exports = { runSelfTest };
