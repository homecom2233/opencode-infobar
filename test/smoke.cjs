/*
 * 冒烟测试：用桩宿主模块 + 假 DOM 加载插件 bundle，不需要启动 OpenCode。
 *
 *   node test\smoke.cjs
 *
 * 校验：三段文本、上下文比例环、步数不带「+」、点按后弹层切到对应区块。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "gui-experimental.cjs");
const code = fs.readFileSync(SRC, "utf8");

/* ---- 假 DOM ---- */
function makeElement(tag) {
  const el = {
    tagName: tag,
    style: { cssText: "", display: "", color: "", background: "", visibility: "", left: "", bottom: "" },
    attributes: {},
    textContent: "",
    title: "",
    children: [],
    listeners: {},
    append(...nodes) {
      for (const node of nodes) this.children.push(node);
    },
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    dispatch(type, event) {
      for (const handler of this.listeners[type] || []) handler(event || { stopPropagation() {} });
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getBoundingClientRect() {
      return { left: 10, top: 900, right: 200, bottom: 920, width: 190, height: 20 };
    },
  };
  return el;
}

const body = makeElement("body");
global.document = {
  createElement: makeElement,
  createElementNS: (_namespace, tag) => makeElement(tag),
  createTextNode: (text) => ({ text }),
  body,
  addEventListener() {},
};
global.window = { innerWidth: 1600, innerHeight: 920, addEventListener() {} };

/* ---- 桩宿主模块 ---- */
const calls = { slots: [], commands: [] };

const Plugin = { define: (definition) => definition };
const solid = {
  createRoot: (fn) => fn(),
  createMemo: (fn) => fn,
  createEffect: (fn) => fn(),
};
const solidWeb = {
  insert(parent, accessor) {
    const value = typeof accessor === "function" ? accessor() : accessor;
    parent.__text = (parent.__text || "") + (value == null ? "" : String(value));
    return value;
  },
};
const clientSolid = {
  lastAssistantWithUsage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].type === "assistant" && messages[i].tokens) return messages[i];
    }
    return undefined;
  },
};
const modules = {
  "@opencode/plugin/gui": { Plugin, Slot: { kind: "slot" }, Command: { kind: "command" } },
  "solid-js/web": solidWeb,
  "solid-js": solid,
  "@opencode/client/solid": clientSolid,
};

/* ---- 假会话 ----
 * 轮 2 / 步 2，模型用时 1.4s，工具用时 3.0s，TTFT 平均 250ms
 * 最近一步 100 tok/s，命中率 2944/(3480+2944)=45.8%，上下文 6424/1e6
 */
const messages = [
  { type: "user", time: { created: 1 } },
  {
    type: "assistant",
    time: { created: 1000, streamed: 1800, completed: 2100 },
    content: [
      { type: "text", time: { created: 1300, completed: 1790 }, text: "x" },
      { type: "tool", name: "bash", time: { created: 2000, ran: 2100, completed: 5000 } },
    ],
    tokens: { input: 3480, output: 118, reasoning: 8, cache: { read: 2944, write: 0 } },
  },
  { type: "user", time: { created: 5500 } },
  {
    type: "assistant",
    time: { created: 6000, streamed: 6600, completed: 7000 },
    content: [{ type: "reasoning", time: { created: 6200, completed: 6590 } }],
    tokens: { input: 3500, output: 40, reasoning: 0, cache: { read: 3000, write: 0 } },
  },
];

const session = {
  id: "ses_test_0123456789",
  key: "sidecar\nses_test_0123456789",
  location: { directory: "D:/x" },
  server: {
    id: "sidecar",
    data: {
      session: {
        get: () => ({
          id: "ses_test_0123456789",
          cost: 0.42,
          model: { id: "deepseek-v4-flash", providerID: "deepseek" },
          tokens: { input: 3480, output: 124, reasoning: 8, cache: { read: 2944, write: 0 } },
        }),
        message: { list: () => messages, more: () => true },
        status: () => "idle",
      },
      location: {
        model: {
          list: () => [
            { modelID: "deepseek-v4-flash", providerID: "deepseek", limit: { context: 1000000, output: 65536 } },
          ],
        },
      },
    },
  },
};

const ctx = {
  id: "bottom-status",
  sessions: { current: () => session, list: () => [session] },
  system: { copy: async () => {} },
  toast: { show: () => {} },
  appearance: { mode: () => "dark" },
  t: (key) => key,
  add(registry, item) {
    const resolved = typeof item === "function" ? item() : item;
    if (registry.kind === "slot") calls.slots.push(resolved);
    if (registry.kind === "command") calls.commands.push(resolved);
    return () => {};
  },
};

/* ---- 运行 ---- */
const module_ = { exports: {} };
new Function("require", "module", "exports", code)(
  (specifier) => {
    const found = modules[specifier];
    if (!found) throw new Error(`unstubbed module: ${specifier}`);
    return found;
  },
  module_,
  module_.exports,
);

const definition = module_.exports.default || module_.exports;
definition.setup(ctx);

const strip = calls.slots[0].render({});
const collected = [];
(function walk(node) {
  if (!node || typeof node !== "object") return;
  if (node.__text) collected.push(node.__text.trim());
  for (const child of node.children || []) walk(child);
})(strip);

const text = collected.filter(Boolean).join("  │  ");
const ring = strip.children[5].children[0];
const ringBar = ring.children[1];

const checks = [
  ["三段齐全", /⟳ 2 轮 2 步/.test(text) && /缓存命中率 45\.8%/.test(text)],
  ["步数不带 +", !/步\+/.test(text)],
  ["上下文 <1%", /<1%/.test(text)],
  ["比例环有填充", Number(ringBar.attributes["stroke-dashoffset"]) < Number(ringBar.attributes["stroke-dasharray"])],
];

console.log("strip:", text);
for (const [name, ok] of checks) console.log((ok ? "PASS " : "FAIL ") + name);
const failed = checks.filter(([, ok]) => !ok).length;
process.exit(failed === 0 ? 0 : 1);
