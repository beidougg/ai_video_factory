# plan.md — AI Video Factory 抖音适配优化架构方案

> 基于 `spec.md` 生成。本文档定义"怎么做"，是代码实现的蓝图。
>
> 关联：`spec.md` | `tasks.md` | `../video-factory-arch/plan.md`

---

## 1. Architecture Decision

### AD-1: 模板系统多模板化

**现状：** `render.js` 中模板路径已支持 `renderData.template` 参数，但 Composition 注册为固定值，且只有一个竖屏适配的 `animation_knowledge` 模板。

**决策：** 将模板体系重构为"模板注册表"，每个模板声明自己的 `orientation`（landscape/portrait）、Composition ID、默认参数。渲染时按 `template` 参数 + 目标平台自动选择。

**理由：** 最小侵入式改动，不破坏现有 7 步管线；竖屏/横屏模板可并存，后续可扩展更多风格模板。

### AD-2: BGM 混音在 FFmpeg 阶段完成

**决策：** 在现有 FFmpeg 字幕烧录步骤之后追加一个混音步骤：`ffmpeg -i video.mp4 -i bgm.mp3 -filter_complex "[1:a]volume=0.3[bgm];[0:a][bgm]amix=inputs=2:duration=first"`。

**理由：** BGM 属于后期处理，与 Remotion 渲染解耦；FFmpeg 混音灵活支持淡入淡出、循环截断；不增加 Remotion 渲染负担。

### AD-3: word-level 时间戳依赖 TTS 引擎能力

**决策：** 先探测 edge-tts 是否能输出词级时间戳（`edge-tts` 的边界词边界信息）。若不可用，切换为豆包语音（支持精细时间戳）作为 T4.4 的落地场景。

**理由：** 逐字时间戳是声画同步的硬前提，TTS 引擎是唯一数据源；早探测可避免渲染期返工。

### AD-4: 热点数据源抽象为 Provider

**决策：** 定义 `HotTrendProvider` 接口（`getTrendingTopics()`），实现 `DouyinHotProvider`（免费源）。LLM 选题分析注入热点上下文；Provider 不可用时返回空列表降级。

**理由：** 热点源变化快、频控严，抽象接口便于替换与降级。

### AD-5: 脚本结构校验器

**决策：** 新增 `validateScriptStructure(script)` 校验器，检查四段式结构（钩子/反差/干货/CTA 存在性、顺序、时长占比），失败时带纠错提示重试一次。

**理由：** 结构合规是爆款基因的量化保障，校验器可测试、可回归。

### AD-6: 素材检索两级回退

**决策：** 素材检索顺序：本地库（现有逻辑）→ 外部免费源（Pexels API）→ 渐变背景兜底（现有行为）。外部源仅补充"缺失"分镜。

**理由：** 本地素材优先保证版权可控，外部源解决"无素材可用"问题，三级回退保证管线不断。

---

## 2. Module Breakdown

| 模块 | 文件 | 职责 | 依赖 |
|------|------|------|------|
| 模板注册表 | `templates/registry.json` | 声明模板元数据（orientation/compositionId/默认参数） | 无 |
| 竖屏模板 | `templates/knowledge_portrait/src/index.tsx` | 9:16 竖屏动画模板（复用横屏组件逻辑） | Remotion |
| BGM 混音器 | `workflow_engine/bgm.js` | BGM 选择、音量平衡、混音 | FFmpeg |
| 逐字字幕 | `workflow_engine/tts.js`（改造） | 采集 word-level 时间戳 → 生成对齐 VTT | edge-tts / 豆包 |
| 热点 Provider | `workflow_engine/hot_trends.js` | 热点获取 + 降级 | 免费 API |
| 结构校验器 | `workflow_engine/script_validator.js` | 四段式结构校验 | 无 |
| 外部素材源 | `workflow_engine/asset_search.js`（扩展） | Pexels/Pixabay 检索回退 | 免费 API key |

---

## 3. Interface Contracts

### 3.1 模板注册表

```json
{
  "templates": [
    {
      "id": "knowledge_landscape",
      "orientation": "landscape",
      "compositionId": "KnowledgeLandscape",
      "width": 1920,
      "height": 1080
    },
    {
      "id": "knowledge_portrait",
      "orientation": "portrait",
      "compositionId": "KnowledgePortrait",
      "width": 1080,
      "height": 1920
    }
  ]
}
```

### 3.2 render.js 扩展

```js
renderPipeline(propsDir, pipelineId, { template: 'knowledge_portrait', bgm: 'assets/bgm/upbeat.mp3' })
```

### 3.3 HotTrendProvider

```js
class HotTrendProvider {
  async getTrendingTopics() { /* 返回 [{ title, heat }] 或 [] */ }
}
```

### 3.4 脚本结构校验

```js
validateScriptStructure(script)
// 返回 { valid: boolean, missing: ['cta'], errors: ['干货段时长占比不足'] }
```

---

## 4. Risk Assessment

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| edge-tts 无词级时间戳 | 高 | 提前探测；不可用则切豆包语音（T4.4 顺势落地） |
| 外部素材源频控/断连 | 中 | 两级回退 + 超时降级，不阻断管线 |
| 竖屏模板布局返工 | 中 | 复用横屏组件，仅调整容器尺寸与字号缩放 |
| BGM 版权风险 | 中 | 仅用 Pixabay Music 等明确可商用素材，本地缓存 |
| 热点源接口变动 | 低 | Provider 抽象，单点替换 |

---

## 5. Implementation Order

1. 竖屏模板 + 模板注册表（AC-1，最高收益）
2. BGM 混音（AC-2）
3. 逐字时间戳探测与落地（AC-3，含 TTS 切换决策）
4. 脚本结构校验器（AC-5）
5. 热点 Provider（AC-4）
6. 外部素材源（AC-6）
