# plan.md — AI Video Factory 架构方案

> 基于 `spec.md` 生成。定义系统架构、模块划分、接口契约与风险评估。
>
> 关联：`../constitution.md` | `spec.md` | `tasks.md`

---

## 1. Architecture Decision

### 1.1 总体架构：五层管道 + 编排引擎

```
┌─────────────────────────────────────────────────┐
│                    n8n 编排引擎                    │
│  Webhook/Cron 触发 → 节点链执行 → 人工审阅暂停     │
├─────────────────────────────────────────────────┤
│  第1层: 创意与选题    │  LLM 分析 + 选题报告        │
│  第2层: 内容生产      │  脚本 + 分镜 + 素材匹配     │
│  第3层: 视频合成      │  Remotion/FFmpeg 渲染       │
│  第4层: 分发          │  YouTube API + 快手 API     │
│  第5层: 数据回收      │  播放数据采集 + 素材标记     │
├─────────────────────────────────────────────────┤
│  横切: 飞书 Bot       │  审阅通知 + 确认回调         │
│  横切: 文件系统       │  素材库 + 脚本 + 视频输出     │
└─────────────────────────────────────────────────┘
```

### 1.2 关键决策

| 决策 | 选型 | 理由 |
|------|------|------|
| 编排引擎 | n8n 自托管 | 原生 Wait Node 支持人工审批暂停，400+ 集成节点，可视化维护 |
| LLM | DeepSeek V3 | 中文脚本质量第一梯队，价格极低（¥1/百万 token），兼容 OpenAI 接口 |
| 视频模板 | Remotion | React 生态成熟，社区活跃，免费版够用；HyperFrames 作为备选 |
| TTS | Edge-TTS → 豆包语音 | 先免费跑通，效果不满意再切付费 |
| 审阅通知 | 飞书 Bot | n8n 原生节点支持，交互卡片回调，个人版免费 |
| 分发 | YouTube API + 快手 API | 仅这两个平台有可用发布 API |

---

## 2. Module Breakdown

### M0: n8n 编排引擎（基础设施）

- **职责**：工作流定义、节点执行、状态管理、错误重试、日志记录
- **部署**：Docker 容器，端口 5678，localhost 绑定
- **存储**：工作流 JSON 文件纳入 Git，凭证存储在 n8n 内部 Credential Store
- **关键节点**：Webhook、Cron、HTTP Request、Wait、Execute Command、飞书、Code

### M1: 创意输入与选题分析

- **输入**：用户通过飞书消息或 Webhook 提交创意文本
- **处理**：LLM 分析选题方向、热点匹配度、受众适配性
- **输出**：选题分析报告（文本）+ 可选追问
- **执行方式**：n8n HTTP 节点调用 DeepSeek API，prompt 模板从 `prompts/` 目录加载

### M2: 脚本生成与分镜匹配

- **输入**：选题分析报告 + 素材库元数据索引
- **处理**：
  - LLM 生成完整脚本（文案 + 每段画面建议）
  - 将脚本拆分为分镜列表
  - 根据标签/场景/质量三维度匹配素材
- **输出**：JSON 格式的分镜脚本，每个分镜包含：序号、文案、时长、候选素材列表（含文件路径）
- **审阅点 1**：脚本完成后暂停，飞书推送完整文案
- **审阅点 2**：分镜匹配完成后暂停，飞书推送分镜对照表

### M3: 配音生成

- **输入**：最终审核通过的脚本全文
- **处理**：edge-tts CLI（或豆包语音 API）生成 MP3 文件
- **输出**：`outputs/{timestamp}/voice.mp3` + 每个分镜段落的时间戳 JSON
- **执行方式**：n8n Execute Command 节点

### M4: 视频合成与渲染

- **输入**：分镜 JSON + 素材文件路径 + 配音 MP3 + 时间戳 JSON
- **处理**：
  - Remotion 模板接收 JSON props，生成视频组件
  - `npx remotion render` 渲染为 MP4
  - FFmpeg 后处理：烧录字幕、统一编码参数
- **输出**：`outputs/{timestamp}/final.mp4`
- **备选**：HyperFrames（HTML → Puppeteer 截图 → FFmpeg 拼帧）
- **执行方式**：n8n Execute Command 节点

### M5: 自动质检

- **输入**：`final.mp4`
- **处理**：ffprobe 提取流信息，与目标参数比对
- **检查项**：分辨率、帧率、时长偏差、编码格式（H.264）、音轨存在性
- **失败处理**：自动重试渲染（最多 2 次），仍失败则飞书通知
- **审阅点 3**：质检通过后暂停，飞书推送本地视频路径供预览

### M6: 发布元数据生成

- **输入**：分镜脚本 JSON + 最终视频信息
- **处理**：LLM 为 YouTube 和快手分别生成标题、描述、标签
- **输出**：JSON（含各平台元数据）
- **审阅点 4**：生成完成后暂停，飞书推送供审阅

### M7: 多平台分发

- **YouTube**：
  - n8n HTTP 节点 → YouTube Data API v3 `videos.insert`
  - OAuth 2.0，使用 n8n Credential 存储 Token
  - privacyStatus 设为 private
- **快手**：
  - n8n HTTP 节点 → 快手 openapi
  - 流程：start_upload → multipart upload → publish
  - OAuth 2.0，access_token 通过 n8n Credential 管理
- **结果**：成功/失败状态 + video_id/photo_id 记入日志

### M8: 数据回收

- **输入**：已发布的视频 ID 列表
- **触发**：发布后 24h 的 n8n Cron 节点
- **处理**：调用各平台数据 API 获取播放量/点赞/评论/分享
- **输出**：飞书消息（每日数据汇总）+ 素材元数据更新（高完播率素材标记）

---

## 3. Interface Contracts

### 3.1 分镜脚本 JSON Schema

```json
{
  "script_id": "20240802_001",
  "title": "视频标题",
  "total_duration": 60,
  "scenes": [
    {
      "index": 1,
      "text": "分镜文案",
      "duration": 5.0,
      "suggestion": "产品特写 3秒",
      "candidates": [
        {
          "file": "product_001_closeup.mp4",
          "start": 0.0,
          "end": 3.0,
          "score": 0.95,
          "tags": ["产品特写", "俯拍"]
        }
      ]
    }
  ]
}
```

### 3.2 素材元数据 JSON Schema

```json
{
  "file": "product_001_closeup.mp4",
  "duration": 5.2,
  "resolution": "1920x1080",
  "tags": ["产品展示", "特写", "俯拍", "旋转"],
  "scenario": "产品首镜头",
  "quality": "S",
  "source": "自拍",
  "usage_count": 12,
  "avg_retention": 0.85
}
```

### 3.3 平台发布元数据 JSON Schema

```json
{
  "youtube": {
    "title": "标题 ≤ 100 字符",
    "description": "描述 ≤ 5000 字符",
    "tags": ["tag1", "tag2"],
    "privacyStatus": "private"
  },
  "kuaishou": {
    "title": "标题 ≤ 20 字",
    "tags": ["标签1", "标签2"]
  }
}
```

### 3.4 飞书审阅卡片协议

- **消息类型**：飞书 Interactive Card（`interactive`）
- **卡片结构**：
  - Header：审阅点名称 + emoji 标识
  - Body：审阅内容（脚本文字 / 分镜表 / 视频预览说明）
  - Actions：`[通过]` `[打回修改]` 按钮
- **回调**：按钮点击 → 飞书服务端 POST → ngrok URL → n8n Webhook 节点
- **回调 payload**：`{ "action": "approve|reject", "feedback": "修改意见文本", "review_point": 1 }`

### 3.5 LLM Prompt 接口

- **调用方式**：n8n HTTP Request 节点，POST DeepSeek API（`/v1/chat/completions`）
- **系统 prompt**：固定角色设定 + 素材库目录结构 + 参考视频分析模板
- **用户 prompt**：当前步骤的输入数据（选题 / 脚本 / 元数据）
- **Temperature**：脚本生成 0.8，元数据生成 0.5，素材匹配 0.2

---

## 4. Directory Structure

```
e:\ai_video_factory\
├── constitution.md          # 项目宪法（根目录）
├── specs\                   # SDD 三文件
│   └── video-factory\
│       ├── spec.md
│       ├── plan.md
│       └── tasks.md
├── workflows\               # n8n 工作流 JSON 导出
│   └── video_factory.json
├── prompts\                 # LLM prompt 模板
│   ├── topic_analysis.txt
│   ├── script_gen.txt
│   ├── storyboard.txt
│   └── metadata.txt
├── templates\               # Remotion/HyperFrames 视频模板
│   ├── product_showcase\
│   ├── knowledge_explain\
│   └── animation_pack\
├── assets\                  # 素材库
│   ├── videos\
│   │   ├── products\
│   │   ├── scenarios\
│   │   └── broll\
│   ├── bgm\
│   ├── sfx\
│   └── metadata\            # 素材元数据 JSON
├── scripts\                 # 生成的脚本 JSON
├── outputs\                 # 渲染完成的视频
└── logs\                    # 质检报告
```

---

## 5. Risk Assessment

| 风险 | 等级 | 影响 | 缓解措施 |
|------|------|------|----------|
| 素材库初始搭建耗时 | 中 | 流水线无法启动 | Phase 1 先用 50 条最小素材集跑通，后续逐步扩充 |
| 飞书 Bot 回调不稳定 | 低 | 审阅流程卡住 | 超时 24h 自动提醒 + n8n 网页端可手动恢复 |
| Remotion 模板开发周期长 | 中 | 视频风格受限 | 先做 1 个通用模板（口播+画面），跑通后再扩展 |
| LLM 生成脚本质量波动 | 中 | 重新生成增加成本 | 结构化 prompt + 素材库约束降低随机性 |
| YouTube API 审核不通过 | 中 | 发布入口被堵 | 提前提交审核，同时准备 Playwright 备选方案 |
| 快手 API 限频 | 低 | 发布延迟 | 单账号日发布量在 API 限额内 |
| 本地 PC 资源瓶颈 | 低 | 渲染时间增长 | Remotion 渲染走 CPU，并发时注意排队 |
| n8n Docker 数据丢失 | 低 | 工作流需重建 | 工作流 JSON 纳入 Git，凭证配置文档化 |
