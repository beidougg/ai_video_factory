# plan.md — AI Video Factory 素材缺口 AI 生成补位架构方案

> 基于 `spec.md` 生成。定义系统架构、模块划分、接口契约与风险评估。
>
> 关联：`../constitution.md` | `spec.md` | `tasks.md` | 基础架构：`../video-factory-arch/plan.md`

---

## 1. Architecture Decision

### 1.1 总体架构：素材检索链末端插入"AI 补位层"

```
分镜脚本
   │
   ▼
┌─────────────────────────────────────────────┐
│ 素材检索链（降级顺序，任一命中即停止）          │
│                                              │
│  ① 本地素材库  asset_search.js（现有）        │
│        ↓ miss（no_match: true）              │
│  ② 外部免费素材源（optimize O6.1，未实现可跳过）│
│        ↓ miss / 未启用                        │
│  ③ AI 文生图补位  【本次新增 M9-M12】          │
│        ↓ 失败                                │
│  ④ 渐变背景兜底（现有 Remotion 行为，不变）     │
└─────────────────────────────────────────────┘
   │
   ▼
candidates 数组注入（source 标记来源）→ 审阅点 2/3（现有）
```

**核心设计原则：AI 生成结果与本地素材走同一条 `candidates` 通道**，不新增数据通路、不新增审阅点、不改 Remotion 模板。新增能力收敛在 5 个新模块（M9-M13）+ 1 个 prompt 模板 + 1 个 API 端点扩展。

### 1.2 关键决策

| 决策 | 选型 | 理由 |
|------|------|------|
| 图像生成供应商 | **可配置多供应商客户端**，首发接入一家（见 §1.3 对比，推荐阿里万相 turbo 或硅基流动 FLUX） | 国内直连、单价 ≤¥0.15、符合月预算；抽象统一接口避免供应商锁定 |
| Prompt 构建 | 复用现有 DeepSeek 调用，新增 `prompts/image_prompt.txt` 模板 | 分镜文案是中文且口语化，需 LLM 转为结构化视觉描述；DeepSeek 成本可忽略（每张图 prompt 生成 < ¥0.001） |
| 风格一致性 | "风格 token"机制：管线入口的 `style` 字段原样拼入每张图的 prompt 后缀 | 低成本实现同片风格统一，无需训练或参考图 |
| 透明 PNG 实现 | prompt 指定纯色背景（绿幕）→ FFmpeg `colorkey` 滤镜去背 | 确定性图像处理，非本地 AI 模型，符合 constitution 第 2 条；零额外 API 成本 |
| 横竖双版本 | 按目标平台列表逐尺寸各生成一张，尺寸作为生成参数传入 | 文生图 API 原生支持任意尺寸指定，成本低于"生成后裁切"的返工 |
| 降级与熔断 | pipeline 级状态对象：计数器（≤8 张）、连续失败计数（≥3 熔断）、全局开关（环境变量） | 全部内存态，不引入外部存储；熔断后自动走渐变兜底 |
| 供应商密钥 | `.env` 新增条目，engine.js CONFIG 统一读取 | 沿用 constitution 第 7 条现有模式 |

### 1.3 图像生成 API 选型对比

> 价格为公开刊例价量级，**以接入时官网实时价为准**（tasks T0.2 含实测验证）。预算约束：月 ≤¥30，日均 3 条 × 3 张 ≈ 270 张/月 → 均价需 ≤¥0.11/张。

| 供应商 | 模型 | 单张量级 | 中文 prompt | 国内直连 | 尺寸自由度 | 结论 |
|--------|------|----------|------------|----------|-----------|------|
| 阿里云百炼 DashScope | 通义万相 wanx-t2i-turbo | ~¥0.04-0.08 | 原生 | ✅ | 任意宽高 | **推荐首发** |
| 硅基流动 SiliconFlow | FLUX.1-schnell / Kolors | 免费层-¥0.05 | 需英文（DeepSeek 翻译） | ✅ | 任意宽高 | 备选/免费层先行验证 |
| 火山引擎方舟 | 豆包 Seedream 4.0 | ~¥0.20-0.25 | 原生 | ✅ | 2K/4K 多档 | 质量最好但超均价，作封面等高价值场景的备选通道 |
| OpenAI | gpt-image-1 | ~¥0.3-1.4 | 原生 | ❌ 需代理 | 固定三档 | 排除（网络+成本） |

**决策**：客户端按统一接口封装（§3.1），`IMAGE_PROVIDER` 环境变量切换；首发实现推荐通道，备选通道留接口不实现（避免过度工程）。

---

## 2. Module Breakdown

模块编号接续基础架构（M0-M8），optimize 规格未占用编号。

### M9: Prompt 构建器

- **职责**：分镜 JSON + 风格描述 → 结构化图像 prompt（主体描述 + 风格后缀 + 负向约束）
- **输入**：`{ scene_text, suggestion, style, type, orientation }`
- **输出**：`{ prompt, negative_prompt }`
- **实现**：DeepSeek 调用，prompt 模板 `prompts/image_prompt.txt`；默认负向约束内置在模板中（水印、文字、logo、二维码、人脸特写）
- **特殊逻辑**：分镜 `suggestion`/`required_tags` 命中"实拍/采访/街拍"关键词时返回 `skip: true`（spec AC-1 默认不触发场景）

### M10: 图像生成客户端

- **职责**：统一封装文生图 API 调用、重试、超时、成本与延迟日志
- **接口**：`generateImage({ prompt, negativePrompt, width, height, type }) → { imageBuffer, cost, provider, latencyMs }`
- **容错**：单次调用超时 60s；失败重试 1 次（spec AC-1 降级链第一步）；第二次失败时按"备用风格"重排 prompt 再试 1 次（spec AC-1 第二步）
- **日志**：每次调用追加写入 `logs/imagegen_calls.jsonl`（时间、pipeline_id、尺寸、成本、耗时、成败），成本月报与预算熔断的数据源
- **配置**：`IMAGEGEN_ENABLED` / `IMAGE_PROVIDER` / 对应 API Key，全部环境变量

### M11: 素材入库器

- **职责**：图像 Buffer → 落盘素材库 + 生成元数据 JSON + （透明 PNG 时）FFmpeg colorkey 去背
- **落盘规则**：`e:\ai_video_factory\assets\images\ai\{类别}\`，命名 `ai_{类别}_{序号}_{横竖}.{png|jpg}`——命名前缀 `ai_` 使 AI 素材可从文件名直接识别（constitution 第 5 条的扩展，向后兼容）
- **元数据**：沿用现有素材 Schema + spec AC-5 扩展字段（见 §3.3）
- **去背**：`ffmpeg -i in.png -vf "colorkey=0x00FF00:0.3:0.2" -f image2 out.png`，输入图由 prompt 约束为纯绿幕背景

### M12: 管线集成器（降级链编排）

- **职责**：编排"本地 → 外部 → AI → 渐变"降级链；配额、熔断、全局开关；AI 候选注入
- **集成点**：engine.js `stepAssetSearch` 之后新增 `stepImageGenFill`——读取检索结果中 miss 的分镜，逐分镜走 M9→M10→M11，产物作为候选注入该分镜 `candidates` 数组
- **有效 miss 判定**（实现期细化）：现有匹配器对任意素材有基线噪声分（质量+时长加权 ≈0.26），导致 `no_match` 极少为真。触发条件细化为"无候选 **或** 最高分 < `IMAGEGEN_MISS_SCORE`（默认 0.4，可配置）"，语义不变——低分噪声匹配视为未命中
- **配额**：pipeline 级计数器，默认 `maxPerPipeline = 8`，超出后剩余分镜直接走渐变兜底
- **熔断**：pipeline 内连续失败 ≥3 次 → 停止本管线后续 AI 调用 + 飞书通知（复用现有通知通道）；月累计成本超过预算阈值时行为同熔断
- **开关**：`IMAGEGEN_ENABLED=false` 时本模块为空操作，管线行为与现状完全一致（spec AC-7）
- **外部源兼容**：检测外部素材源模块是否启用（optimize O6.1 当前未实现）；未启用时直接从本地检索结果进入 AI 补位，不报错

### M13: 审阅扩展（重新生成）

- **职责**：在现有审阅 API 上新增"重新生成"操作，不重跑整条管线
- **端点**：`POST /api/review/:id/regenerate-asset`，body：`{ scene_index, feedback? }`
- **流程**：从 `reviewStore` 取该 pipeline 的分镜与风格 → M9 重构建 prompt（feedback 拼入修正指令）→ M10 生成 → M11 入库 → **替换**该分镜 candidates 中的 AI 候选（旧文件保留落盘，仅从候选中移除）→ 审阅点保持"待审"状态
- **来源标记**：candidates 元素新增 `source` 字段（`local` / `external` / `ai_generated`），审阅数据原样透出给审阅界面（spec AC-6）

---

## 3. Interface Contracts

### 3.1 图像生成统一接口（M10）

```javascript
// workflow_engine/imagegen.js
const result = await generateImage({
  prompt: '扁平插画风格，一位年轻人坐在堆满书的桌前...',
  negativePrompt: 'watermark, text, logo, qr code, face closeup',
  width: 1920,            // 横屏 1920×1080 / 竖屏 1080×1920 / 透明 1024×1024
  height: 1080,
  type: 'scene',          // scene | cover | background | transparent_png
});
// → { imageBuffer: <Buffer>, cost: 0.06, provider: 'dashscope', latencyMs: 8200 }
// 失败时 throw，由 M12 统一处理降级
```

### 3.2 扩展后的分镜候选 Schema（M12 注入）

在基础架构 §3.1 的 `candidates` 元素上扩展，**向后兼容**（旧字段不变）：

```json
{
  "file": "ai_concept_003_landscape.png",
  "file_path": "assets/images/ai/concept/ai_concept_003_landscape.png",
  "start": 0,
  "end": 5.0,
  "score": 0.6,
  "tags": ["AI生成", "概念插画"],
  "source": "ai_generated",
  "ai_meta": {
    "prompt": "...",
    "negative_prompt": "...",
    "generated_at": "2026-10-28T10:00:00Z",
    "cost": 0.06,
    "provider": "dashscope",
    "scene_index": 3
  }
}
```

`score` 固定为 0.6：低于本地实拍素材典型得分、高于 0（避免被过滤），保证审阅界面中 AI 候选排在真实素材之后——**实拍优先，AI 补位**。

### 3.3 AI 素材元数据 JSON Schema（M11 写入）

```json
{
  "file": "ai_concept_003_landscape.png",
  "file_path": "assets/images/ai/concept/ai_concept_003_landscape.png",
  "type": "image",
  "resolution": "1920x1080",
  "tags": ["AI生成", "概念插画", "分镜文案提取的关键词"],
  "scenario": "分镜配图",
  "quality": "B",
  "source": "ai_generated",
  "prompt": "完整生成提示词",
  "negative_prompt": "负向约束",
  "pipeline_id": "pipe_20261028_001",
  "scene_index": 3,
  "generated_at": "2026-10-28T10:00:00Z",
  "cost": 0.06,
  "usage_count": 0,
  "avg_retention": null
}
```

`quality` 默认 `B`：AI 素材未经人工分级前不参与"高质量"加权；入库后参与常规标签检索（spec AC-5 复用要求）。

### 3.4 重新生成 API（M13）

```
POST /api/review/:id/regenerate-asset
Content-Type: application/json

{ "scene_index": 3, "feedback": "背景太暗，换成明亮色调" }
```

响应：

```json
{
  "success": true,
  "pipelineId": "pipe_20261028_001",
  "scene_index": 3,
  "new_candidate": { "file": "ai_concept_004_landscape.png", "...": "..." },
  "regen_count": 1,
  "message": "已重新生成并替换候选，请继续审阅"
}
```

约束：仅审阅点 2/3 的待审状态可调用；每分镜重生成计数写入 reviewData，不限制次数但计入配额与成本日志。

### 3.5 环境变量约定

```bash
# .env 新增
IMAGEGEN_ENABLED=true            # 全局开关（spec AC-7）
IMAGE_PROVIDER=dashscope         # dashscope | siliconflow | volcengine
DASHSCOPE_API_KEY=sk-xxx         # 按 IMAGE_PROVIDER 对应
IMAGEGEN_MAX_PER_PIPELINE=8      # 单条配额
IMAGEGEN_MONTHLY_BUDGET=30       # 月预算（元），超限熔断
```

---

## 4. Directory Structure（增量）

```
e:\code\ai_video_factory\
├── prompts\
│   └── image_prompt.txt            # 【新增】分镜→图像 prompt 模板
├── workflow_engine\
│   ├── imagegen.js                 # 【新增】M9+M10：prompt 构建 + 生成客户端
│   ├── asset_ingest.js             # 【新增】M11：素材入库器（落盘+元数据+去背）
│   └── engine.js                   # 【修改】新增 stepImageGenFill + M13 端点
├── logs\
│   └── imagegen_calls.jsonl        # 【新增】生成调用日志（成本/延迟/成败）
└── assets\ → e:\ai_video_factory\assets\
    └── images\ai\{类别}\            # 【新增】AI 素材落盘区
```

---

## 5. Risk Assessment

| 风险 | 等级 | 影响 | 缓解措施 |
|------|------|------|----------|
| 供应商刊例价高于预估，月预算击穿 | 中 | 成本失控 | T0.2 实测单价后再开发；月预算硬熔断（§3.5）；低成本通道优先 |
| 生成质量不稳定（手部/构图崩坏） | 中 | 审阅通过率低，重生成推高成本 | 负向约束内置；备用风格降级；重生成不计入新配额但计成本；指标目标仅 70% 通过率 |
| 透明 PNG 绿幕去背边缘残留 | 中 | 叠加层观感差 | colorkey 相似度/混合参数可调；prompt 约束"主体居中、无细碎边缘"；人工审阅兜底 |
| 横竖双版本生成量翻倍，成本翻倍 | 低 | 成本上升 | 仅当管线入口声明双平台分发时才双生成；单平台默认单尺寸 |
| 外部素材源（optimize O6.1）长期未实现 | 低 | 降级链缺一环 | M12 显式兼容外部源缺失；O6.1 上线后自动接入，无需改 imagegen 代码 |
| 竖屏模板（optimize O1.2）未实现，竖版 AI 图无消费方 | 低 | 竖版图生成后无法渲染 | 生成能力先行（尺寸只是参数）；端到端验证任务依赖 O1.2，tasks 中显式标注 |
| AI 素材混入素材库拉低检索质量 | 低 | 后续视频误用低质 AI 图 | `quality` 默认 B + `source` 可过滤 + 一键清理（按 source 检索删除） |
| 内容安全风险（生成违规图像） | 低 | 合规问题 | 供应商自带安全过滤为第一道；人工审阅为第二道；默认负向约束排除人脸/IP |
| Prompt 构建 LLM 调用失败 | 低 | 补位失败 | 失败时跳过 LLM，用分镜文案原文拼接模板作为兜底 prompt，仍尝试生成 |

---

## 6. 与既有规格的关系

| 规格 | 关系 |
|------|------|
| `video-factory-arch` | 本方案在其 M2（素材检索）末端扩展，复用 M0 引擎、审阅状态机、飞书通知；不修改其四审阅点结构 |
| `video-factory-optimize` | O6.1（外部素材源）位于降级链第②环，先于 AI 触发——外部源上线后 AI 调用量自然下降，两个规格正交不冲突；O1.2（竖屏模板）是竖版 AI 素材的消费方，本规格端到端验收依赖它 |
| `constitution` | 第 2 条（云端 API）→ 全部生成走 HTTP；第 5 条（素材规范）→ 命名前缀 `ai_` 扩展已声明；第 7 条（密钥）→ 环境变量注入 |
