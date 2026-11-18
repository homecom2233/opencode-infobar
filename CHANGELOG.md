# Changelog

## 0.1.0 — 2026-11-18

首个公开发布。

- OpenCode 桌面版底部状态栏，三段式：`⟳ 轮次·步数·速度` │ `⛁ 总 token·缓存命中率` │ `◔ 上下文比例环`
- 三段点按弹出明细卡片（会话统计 / Token 用量 / 上下文），点空白或 `Esc` 关闭
- 缓存命中率按 `cacheRead / (input + cacheRead + cacheWrite)` 计算，token 总量取会话级汇总
- 速度按「首 token → 最后一帧」的纯解码窗口计算，排除工具执行与收尾开销
- 深/浅色主题自适应；命中率与上下文按阈值变色
- 零构建：单个手写 CommonJS bundle，无依赖；自带离线冒烟测试 `test/smoke.cjs`
