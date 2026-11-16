/*
 * bottom-status — OpenCode 桌面版底部状态栏（参考 DSH 布局）
 *
 *   ⟳ 3 轮 93 步 · 90 tok/s   │   ⛁ 16.9M tok · 缓存命中率 98%   │   ◯ 27%
 *
 * 三段都可点按，各自弹出明细卡片（会话统计 / Token 用量 / 上下文）。
 *
 * 这是插件的 GUI 部位（./gui-experimental）。桌面版以 CommonJS 方式加载它，
 * 只能 require 宿主共享的模块；白名单外的模块会被直接拒绝（含 solid-js/h），
 * 所以这里用原生 DOM + solid-js 的 insert/createMemo 做响应式。
 *
 * 速度口径：工具/命令执行发生在两条 assistant 消息之间，按消息计算天然已排除；
 * 单条消息内部取「首 token → 最后一帧」，避免把等待和收尾算进速度。
 */
"use strict";

const pluginGui = require("@opencode/plugin/gui");
const solidWeb = require("solid-js/web");
const solid = require("solid-js");
const clientSolid = require("@opencode/client/solid");

const Plugin = pluginGui.Plugin;
const Slot = pluginGui.Slot;
const Command = pluginGui.Command;

const insert = solidWeb.insert;
const createRoot = solid.createRoot;
const createMemo = solid.createMemo;
const createEffect = solid.createEffect;
const lastAssistantWithUsage = clientSolid.lastAssistantWithUsage;

const GREEN = "#3fb950";
const ORANGE = "#d29922";
const RED = "#f85149";

/* ---------- 格式化 ---------- */

function compact(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function exact(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

function money(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return "$" + n.toFixed(2);
}

function duration(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "—";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return hours + " 时 " + (minutes % 60) + " 分";
  }
  if (minutes > 0) return minutes + " 分 " + seconds + " 秒";
  return (ms / 1000).toFixed(1) + " 秒";
}

function percent(value) {
  if (typeof value !== "number" || !isFinite(value)) return "—";
  return (value * 100).toFixed(1) + "%";
}

function percentRound(ratio) {
  if (typeof ratio !== "number" || !isFinite(ratio)) return "—";
  const value = ratio * 100;
  if (value > 0 && value < 1) return "<1%";
  return Math.round(value) + "%";
}

function rateColor(rate) {
  if (rate == null) return "inherit";
  if (rate >= 0.85) return GREEN;
  if (rate >= 0.7) return ORANGE;
  return RED;
}

function contextColor(ratio) {
  if (ratio == null) return "inherit";
  if (ratio >= 0.95) return RED;
  if (ratio >= 0.8) return ORANGE;
  return "inherit";
}

/* ---------- 指标 ---------- */

function hitRate(tokens) {
  if (!tokens) return null;
  const cache = tokens.cache || {};
  const read = cache.read || 0;
  const write = cache.write || 0;
  const input = tokens.input || 0;
  const denominator = input + read + write;
  if (denominator <= 0) return null;
  return read / denominator;
}

function outputTokens(tokens) {
  if (!tokens) return 0;
  return (tokens.output || 0) + (tokens.reasoning || 0);
}

/** 解码起点：首 token → 最早的文本/推理片段 → 消息创建时间。工具段不参与。 */
function streamStart(message) {
  const time = (message && message.time) || {};
  if (time.firstToken != null) return time.firstToken;
  let first = null;
  for (const part of (message && message.content) || []) {
    if (!part) continue;
    if (part.type !== "text" && part.type !== "reasoning") continue;
    const created = (part.time || {}).created;
    if (created == null) continue;
    if (first == null || created < first) first = created;
  }
  if (first != null) return first;
  return time.created;
}

/** 解码终点：最后一帧 → 完成时间。 */
function streamEnd(message) {
  const time = (message && message.time) || {};
  const start = streamStart(message);
  for (const end of [time.streamed, time.completed]) {
    if (end != null && start != null && end > start) return end;
  }
  return null;
}

/** 单条消息的纯解码窗口（毫秒）。 */
function decodeWindow(message) {
  const time = (message && message.time) || {};
  if (!time.completed) return null;
  const start = streamStart(message);
  if (start == null) return null;
  const end = streamEnd(message);
  if (end == null) return null;
  const ms = end - start;
  return ms > 0 ? ms : null;
}

function messageTps(message) {
  if (!message || !message.tokens) return null;
  const out = outputTokens(message.tokens);
  if (out <= 0) return null;
  const ms = decodeWindow(message);
  if (!ms) return null;
  return out / (ms / 1000);
}

/** 工具执行总时长：所有工具段的 completed - created。 */
function toolTime(messages) {
  let ms = 0;
  for (const message of messages) {
    for (const part of (message && message.content) || []) {
      if (!part || part.type !== "tool") continue;
      const time = part.time || {};
      if (time.created == null || time.completed == null) continue;
      const span = time.completed - time.created;
      if (span > 0) ms += span;
    }
  }
  return ms;
}

/** 模型时间：每条消息从创建到最后一帧，含首 token 等待（与工具用时互补）。 */
function modelTime(messages) {
  let ms = 0;
  for (const message of messages) {
    const time = (message && message.time) || {};
    const end = streamEnd(message);
    if (time.created == null || end == null) continue;
    const span = end - time.created;
    if (span > 0) ms += span;
  }
  return ms;
}

function averageTtft(messages) {
  let total = 0;
  let count = 0;
  for (const message of messages) {
    const time = (message && message.time) || {};
    const start = streamStart(message);
    if (time.created == null || start == null) continue;
    const ttft = start - time.created;
    if (ttft <= 0) continue;
    total += ttft;
    count += 1;
  }
  return count > 0 ? total / count : null;
}

function readSnapshot(ctx) {
  const session = ctx.sessions.current();
  if (!session) return null;
  const data = session.server && session.server.data;
  if (!data) return null;

  const info = data.session.get(session.id);
  if (!info) return null;

  let messages = [];
  let truncated = false;
  try {
    messages = data.session.message.list(session.id) || [];
    truncated = data.session.message.more ? !!data.session.message.more(session.id) : false;
  } catch (err) {
    messages = [];
  }

  const tokens = info.tokens || null;
  const cacheRead = tokens && tokens.cache ? tokens.cache.read || 0 : 0;
  const cacheWrite = tokens && tokens.cache ? tokens.cache.write || 0 : 0;
  const input = tokens ? tokens.input || 0 : 0;
  const output = tokens ? tokens.output || 0 : 0;
  const reasoning = tokens ? tokens.reasoning || 0 : 0;

  const rounds = messages.filter((message) => message && message.type === "user").length;
  const steps = messages.filter((message) => message && message.type === "assistant" && message.tokens).length;

  const step = lastAssistantWithUsage ? lastAssistantWithUsage(messages) : null;
  const stepTokens = (step && step.tokens) || null;
  const contextTokens = stepTokens ? (stepTokens.input || 0) + ((stepTokens.cache && stepTokens.cache.read) || 0) : null;

  let contextLimit = null;
  try {
    const models = (data.location.model.list && data.location.model.list(session.location)) || [];
    const modelID = info.model && info.model.id;
    const providerID = info.model && info.model.providerID;
    const found = models.find(
      (model) => model && model.modelID === modelID && (!providerID || model.providerID === providerID),
    );
    if (found && found.limit && typeof found.limit.context === "number") contextLimit = found.limit.context;
  } catch (err) {
    contextLimit = null;
  }

  const completed = messages.filter((message) => message && message.type === "assistant" && message.time && message.time.completed);
  const latest = completed.length ? completed[completed.length - 1] : null;

  const turn = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.type === "user") break;
    if (message.type === "assistant") turn.unshift(message);
  }

  let turnTokens = 0;
  let turnMs = 0;
  for (const message of turn) {
    if (!message.tokens) continue;
    const out = outputTokens(message.tokens);
    if (out <= 0) continue;
    const window = decodeWindow(message);
    if (!window) continue;
    turnTokens += out;
    turnMs += window;
  }

  return {
    /* 顶部三段 */
    rounds: rounds,
    steps: steps,
    truncated: truncated,
    speed: latest ? messageTps(latest) : null,
    turnSpeed: turnMs > 0 ? turnTokens / (turnMs / 1000) : null,
    totalTokens: input + cacheWrite + cacheRead + output + reasoning,
    hit: hitRate(tokens),
    contextRatio: contextTokens != null && contextLimit ? contextTokens / contextLimit : null,
    /* 明细 */
    cacheRead: cacheRead,
    cacheWrite: cacheWrite,
    input: input,
    output: output,
    reasoning: reasoning,
    modelMs: modelTime(messages),
    toolMs: toolTime(messages),
    ttft: averageTtft(messages),
    turnOut: turnTokens,
    turnSteps: turn.filter((message) => message.tokens).length,
    contextTokens: contextTokens,
    contextLimit: contextLimit,
    cost: typeof info.cost === "number" ? info.cost : null,
    model: info.model && info.model.id ? info.model.id : null,
    provider: info.model && info.model.providerID ? info.model.providerID : null,
    sessionID: session.id,
    loadedMessages: messages.length,
  };
}

/* ---------- 明细卡片 ---------- */

function theme(ctx) {
  let dark = true;
  try {
    dark = ctx.appearance.mode() !== "light";
  } catch (err) {
    dark = true;
  }
  return dark
    ? {
        background: "rgba(30,34,42,.98)",
        border: "1px solid rgba(255,255,255,.14)",
        color: "#e6e8ec",
        muted: "rgba(230,232,236,.62)",
        line: "rgba(255,255,255,.1)",
        lineStrong: "rgba(255,255,255,.18)",
        ringAccent: "#7aa2f7",
        shadow: "0 12px 32px rgba(0,0,0,.45)",
      }
    : {
        background: "rgba(255,255,255,.99)",
        border: "1px solid rgba(0,0,0,.12)",
        color: "#1d2430",
        muted: "rgba(29,36,48,.6)",
        line: "rgba(0,0,0,.09)",
        lineStrong: "rgba(0,0,0,.16)",
        ringAccent: "#3b6fd4",
        shadow: "0 12px 32px rgba(0,0,0,.18)",
      };
}

function element(tag, css) {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  return node;
}

function row(label, colors, css) {
  const line = element("div", "display:flex;align-items:baseline;justify-content:space-between;gap:26px;padding:3px 0;" + (css || ""));
  const name = element("span", "color:" + colors.muted + ";");
  name.textContent = label;
  const value = element("span", "font-variant-numeric:tabular-nums;text-align:right;");
  line.append(name, value);
  return { line: line, value: value };
}

function header(title, colors) {
  const line = element("div", "display:flex;align-items:baseline;justify-content:space-between;gap:26px;padding-bottom:7px;");
  const name = element("span", "font-weight:600;");
  name.textContent = title;
  const value = element("span", "font-variant-numeric:tabular-nums;font-weight:600;text-align:right;");
  line.append(name, value);
  return { line: line, value: value };
}

function rule(colors) {
  return element("div", "height:1px;margin:2px 0 8px;background:" + colors.line + ";");
}

function buildPanels(ctx) {
  const colors = theme(ctx);

  const panel = element(
    "div",
    [
      "position:fixed",
      "z-index:2147483000",
      "display:none",
      "min-width:268px",
      "max-width:340px",
      "box-sizing:border-box",
      "padding:12px 14px",
      "border-radius:10px",
      "font-size:12px",
      "line-height:18px",
      "font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)",
      "color:" + colors.color,
      "background:" + colors.background,
      "border:" + colors.border,
      "box-shadow:" + colors.shadow,
      "backdrop-filter:blur(8px)",
    ].join(";"),
  );

  /* 会话统计 */
  const stats = element("div", "");
  const statsHead = header("⟳ 会话统计", colors);
  const modelMs = row("模型用时", colors);
  const toolMs = row("工具调用用时", colors);
  const ttft = row("首 token 平均（TTFT）", colors);
  const turnTps = row("本轮均速", colors);
  const speed = row("输出速度（TPS）", colors);
  stats.append(statsHead.line, rule(colors), modelMs.line, toolMs.line, ttft.line, turnTps.line, speed.line);

  /* Token 用量 */
  const usage = element("div", "");
  const usageHead = header("⛁ Token 用量", colors);
  const hit = row("缓存命中率", colors);
  const cached = row("缓存读取", colors);
  const fresh = row("未缓存输入", colors);
  const out = row("输出", colors);
  const total = row("合计", colors);
  const cost = row("会话费用", colors);
  usage.append(usageHead.line, rule(colors), hit.line, cached.line, fresh.line, out.line, total.line, cost.line);

  /* 上下文 */
  const context = element("div", "");
  const contextHead = header("◯ 上下文", colors);
  const used = row("已用", colors);
  const limit = row("上限", colors);
  const free = row("剩余", colors);
  const modelRow = row("模型", colors);
  const sessionRow = row("会话", colors);
  context.append(contextHead.line, rule(colors), used.line, limit.line, free.line, modelRow.line, sessionRow.line);

  panel.append(stats, usage, context);

  return { panel: panel, sections: { stats: stats, usage: usage, context: context }, cells: {
    stats: { head: statsHead.value, modelMs: modelMs.value, toolMs: toolMs.value, ttft: ttft.value, turnTps: turnTps.value, speed: speed.value },
    usage: { head: usageHead.value, hit: hit.value, cached: cached.value, fresh: fresh.value, out: out.value, total: total.value, cost: cost.value },
    context: { head: contextHead.value, used: used.value, limit: limit.value, free: free.value, model: modelRow.value, session: sessionRow.value },
  } };
}

/* ---------- 状态栏 ---------- */

function buildStrip(ctx, state) {
  const colors = theme(ctx);

  const root = element(
    "div",
    [
      "display:flex",
      "align-items:center",
      "gap:4px",
      "min-height:24px",
      "padding:0 6px",
      "box-sizing:border-box",
      "font-size:11px",
      "line-height:16px",
      "font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)",
      "font-variant-numeric:tabular-nums",
      "border-top:1px solid " + colors.line,
      "color:inherit",
      "white-space:nowrap",
      "overflow:hidden",
      "user-select:none",
    ].join(";"),
  );

  const snapshot = createRoot(function () {
    return createMemo(function () {
      try {
        return readSnapshot(ctx);
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    });
  });

  const empty = element("span", "opacity:.55;padding:0 6px;");
  empty.textContent = "缓存命中率 · 速度 · 上下文";

  function group(kind) {
    const node = element(
      "div",
      [
        "display:flex",
        "align-items:center",
        "gap:6px",
        "padding:2px 8px",
        "border-radius:6px",
        "cursor:pointer",
        "transition:background .12s ease",
      ].join(";"),
    );
    node.addEventListener("mouseenter", function () {
      node.style.background = colors.line;
    });
    node.addEventListener("mouseleave", function () {
      if (state.open !== kind) node.style.background = "transparent";
    });
    node.addEventListener("click", function (event) {
      event.stopPropagation();
      togglePanel(kind, node);
    });
    return node;
  }

  const groupRounds = group("stats");
  const roundsText = element("span", "");
  const speedText = element("span", "opacity:.75;");
  insert(roundsText, function () {
    const s = snapshot();
    if (!s || s.error) return "⟳ —";
    return "⟳ " + s.rounds + " 轮 " + s.steps + " 步";
  });
  insert(speedText, function () {
    const s = snapshot();
    if (!s || s.error || s.speed == null) return "· — tok/s";
    return "· " + s.speed.toFixed(0) + " tok/s";
  });
  groupRounds.append(roundsText, speedText);

  const groupUsage = group("usage");
  const totalText = element("span", "");
  const hitText = element("span", "opacity:.75;");
  insert(totalText, function () {
    const s = snapshot();
    if (!s || s.error) return "⛁ —";
    return "⛁ " + compact(s.totalTokens) + " tok";
  });
  insert(hitText, function () {
    const s = snapshot();
    if (!s || s.error || s.hit == null) {
      hitText.style.color = "inherit";
      return "· 缓存命中率 —";
    }
    hitText.style.color = rateColor(s.hit);
    return "· 缓存命中率 " + percent(s.hit);
  });
  groupUsage.append(totalText, hitText);

  const groupContext = group("context");

  /* 上下文比例环：SVG 双圆，dashoffset 跟随占用比例 */
  const ringSize = 15;
  const ringStroke = 2.4;
  const ringRadius = (ringSize - ringStroke) / 2;
  const ringLength = 2 * Math.PI * ringRadius;
  const svgNS = "http://www.w3.org/2000/svg";
  const ringSvg = document.createElementNS(svgNS, "svg");
  ringSvg.setAttribute("width", String(ringSize));
  ringSvg.setAttribute("height", String(ringSize));
  ringSvg.setAttribute("viewBox", "0 0 " + ringSize + " " + ringSize);
  ringSvg.style.cssText = "display:block;flex:0 0 auto";
  function ringCircle() {
    const node = document.createElementNS(svgNS, "circle");
    node.setAttribute("cx", String(ringSize / 2));
    node.setAttribute("cy", String(ringSize / 2));
    node.setAttribute("r", String(ringRadius));
    node.setAttribute("fill", "none");
    node.setAttribute("stroke-width", String(ringStroke));
    return node;
  }
  const ringTrack = ringCircle();
  ringTrack.setAttribute("stroke", colors.lineStrong);
  const ringBar = ringCircle();
  ringBar.setAttribute("stroke", colors.ringAccent);
  ringBar.setAttribute("stroke-linecap", "round");
  ringBar.setAttribute("stroke-dasharray", String(ringLength));
  ringBar.setAttribute("stroke-dashoffset", String(ringLength));
  ringBar.setAttribute("transform", "rotate(-90 " + ringSize / 2 + " " + ringSize / 2 + ")");
  ringSvg.append(ringTrack, ringBar);

  const contextText = element("span", "");
  insert(contextText, function () {
    const s = snapshot();
    if (!s || s.error || s.contextRatio == null) return "—";
    return percentRound(s.contextRatio);
  });
  groupContext.append(ringSvg, contextText);

  const dividerOne = element("span", "width:1px;height:12px;background:" + colors.line + ";margin:0 2px;");
  const dividerTwo = element("span", "width:1px;height:12px;background:" + colors.line + ";margin:0 2px;");

  root.append(empty, groupRounds, dividerOne, groupUsage, dividerTwo, groupContext);

  /* 弹层 */
  const panels = buildPanels(ctx);
  const cells = panels.cells;
  document.body.append(panels.panel);

  insert(cells.stats.head, function () {
    const s = snapshot();
    return s && !s.error ? s.rounds + " 轮 " + s.steps + " 步" : "—";
  });
  insert(cells.stats.modelMs, function () {
    const s = snapshot();
    return s && !s.error ? duration(s.modelMs) : "—";
  });
  insert(cells.stats.toolMs, function () {
    const s = snapshot();
    return s && !s.error ? duration(s.toolMs) : "—";
  });
  insert(cells.stats.ttft, function () {
    const s = snapshot();
    return s && !s.error ? duration(s.ttft) : "—";
  });
  insert(cells.stats.turnTps, function () {
    const s = snapshot();
    return s && !s.error && s.turnSpeed != null ? s.turnSpeed.toFixed(0) + " tok/s" : "—";
  });
  insert(cells.stats.speed, function () {
    const s = snapshot();
    return s && !s.error && s.speed != null ? s.speed.toFixed(0) + " tok/s" : "—";
  });

  insert(cells.usage.head, function () {
    const s = snapshot();
    return s && !s.error ? compact(s.totalTokens) + " tok" : "—";
  });
  insert(cells.usage.hit, function () {
    const s = snapshot();
    return s && !s.error ? percent(s.hit) : "—";
  });
  insert(cells.usage.cached, function () {
    const s = snapshot();
    return s && !s.error ? exact(s.cacheRead) + " tok" : "—";
  });
  insert(cells.usage.fresh, function () {
    const s = snapshot();
    return s && !s.error ? exact(s.input + s.cacheWrite) + " tok" : "—";
  });
  insert(cells.usage.out, function () {
    const s = snapshot();
    return s && !s.error ? exact(s.output + s.reasoning) + " tok" : "—";
  });
  insert(cells.usage.total, function () {
    const s = snapshot();
    return s && !s.error ? exact(s.totalTokens) + " tok" : "—";
  });
  insert(cells.usage.cost, function () {
    const s = snapshot();
    return s && !s.error ? money(s.cost) : "—";
  });

  insert(cells.context.head, function () {
    const s = snapshot();
    return s && !s.error ? percent(s.contextRatio) : "—";
  });
  insert(cells.context.used, function () {
    const s = snapshot();
    if (!s || s.error || s.contextTokens == null) return "—";
    return compact(s.contextTokens) + " tok";
  });
  insert(cells.context.limit, function () {
    const s = snapshot();
    return s && !s.error && s.contextLimit ? compact(s.contextLimit) + " tok" : "—";
  });
  insert(cells.context.free, function () {
    const s = snapshot();
    if (!s || s.error || s.contextTokens == null || !s.contextLimit) return "—";
    const free = s.contextLimit - s.contextTokens;
    return (free >= 0 ? compact(free) : "0") + " tok";
  });
  insert(cells.context.model, function () {
    const s = snapshot();
    if (!s || s.error) return "—";
    return (s.provider ? s.provider + "/" : "") + (s.model || "—");
  });
  insert(cells.context.session, function () {
    const s = snapshot();
    if (!s || s.error) return "—";
    return s.sessionID.slice(0, 12) + "… · " + s.loadedMessages + " 条";
  });

  function closePanel() {
    panels.panel.style.display = "none";
    state.open = null;
    for (const node of [groupRounds, groupUsage, groupContext]) node.style.background = "transparent";
  }

  function togglePanel(kind, node) {
    if (state.open === kind) {
      closePanel();
      return;
    }
    state.open = kind;
    for (const other of [groupRounds, groupUsage, groupContext]) other.style.background = "transparent";
    node.style.background = colors.line;
    for (const key of Object.keys(panels.sections)) {
      panels.sections[key].style.display = key === kind ? "block" : "none";
    }
    panels.panel.style.display = "block";
    panels.panel.style.visibility = "hidden";
    const rect = node.getBoundingClientRect();
    panels.panel.style.bottom = Math.round(window.innerHeight - rect.top + 8) + "px";
    const width = panels.panel.offsetWidth || 280;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    panels.panel.style.left = Math.round(left) + "px";
    panels.panel.style.visibility = "visible";
  }

  document.addEventListener("click", closePanel);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closePanel();
  });
  window.addEventListener("resize", closePanel);

  createRoot(function () {
    createEffect(function () {
      const s = snapshot();
      empty.style.display = s && !s.error ? "none" : "block";

      /* 比例环：0 → 满圈 */
      const ratio = s && !s.error && s.contextRatio != null ? Math.min(1, Math.max(0, s.contextRatio)) : 0;
      ringBar.setAttribute("stroke-dashoffset", String(ringLength * (1 - ratio)));
      const color = contextColor(ratio);
      ringBar.setAttribute("stroke", color === "inherit" ? colors.ringAccent : color);
      contextText.style.color = color === "inherit" ? "inherit" : color;
    });
  });

  state.root = root;
  return root;
}

/* ---------- 插件 ---------- */

module.exports = Plugin.define({
  setup(ctx) {
    const state = { root: null, visible: true, open: null };

    ctx.add(Slot, {
      at: "window.bottom",
      order: 0,
      render: function () {
        return buildStrip(ctx, state);
      },
    });

    ctx.add(Command, function () {
      return {
        id: "toggle",
        title: "隐藏/显示底部状态栏",
        description: "bottom-status：缓存命中率、速度、上下文",
        run: function () {
          state.visible = !state.visible;
          if (state.root) state.root.style.display = state.visible ? "flex" : "none";
        },
      };
    });

    ctx.add(Command, function () {
      return {
        id: "copy",
        title: "复制底部状态栏诊断信息",
        description: "bottom-status：把当前所有原始数字复制成 JSON",
        run: async function () {
          let payload;
          try {
            payload = JSON.stringify(readSnapshot(ctx), null, 2);
          } catch (err) {
            payload = "error: " + String((err && err.message) || err);
          }
          try {
            await ctx.system.copy(payload);
            ctx.toast.show({ title: "bottom-status 信息已复制", variant: "success" });
          } catch (err) {
            ctx.toast.show({
              title: "复制失败",
              description: String((err && err.message) || err),
              variant: "error",
            });
          }
        },
      };
    });
  },
});
