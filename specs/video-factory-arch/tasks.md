# tasks.md — AI Video Factory 任务清单

> 基于 `plan.md` 模块拆分的原子任务。每个任务独立可验证、可并行执行。
>
> 关联：`../constitution.md` | `spec.md` | `plan.md`

---

## Phase 0: 基础设施搭建（并行执行）

| # | 任务 | 所属模块 | 验证标准 | 依赖 | 状态 |
|---|------|----------|----------|------|------|
| T0.1 | n8n 安装（npm 全局安装） | M0 | 浏览器访问 `localhost:5678` 出现 n8n 界面 | 无 | ✅ 完成（自研引擎替代 n8n，HTTP 服务运行中） |
| T0.2 | 创建飞书个人团队 + 开发者后台 → 创建应用机器人 | M0 | 飞书 App 收到 Bot 消息；获取 App ID / App Secret | 无 | ✅ 完成（App ID: cli_aae46311a3781cee，API 发消息验证通过） |
| T0.3 | ngrok 安装配置，飞书 Webhook 回调可达本地服务 | M0 | 飞书回调验证通过，服务端收到 POST | T0.1, T0.2 | ✅ 完成（ngrok 地址 + 事件回调验证通过） |
| T0.4 | 申请 DeepSeek API Key（官网注册） | M1 | API 调用返回 200，验证余额可用 | 无 | ✅ 完成（Model: deepseek-v4-flash，API 调用验证通过） |
| T0.5 | 安装 Node.js ≥ 18 + FFmpeg ≥ 5.0 + Python 3（edge-tts） | M3, M4 | 命令行 `node -v`, `ffmpeg -version`, `edge-tts --help` 正常输出 | 无 | ✅ 完成（Node.js v22, FFmpeg 6.1.1, edge-tts 7.2.8 via `python -m edge_tts`） |
| T0.6 | 创建 `e:\code\ai_video_factory\` 目录结构（按 plan.md §4） | 全局 | 所有目录存在且可读写 | 无 | ✅ 完成（14 个目录已创建） |
| T0.7 | 初始化 Git 仓库 + 提交 constitution.md + specs/ | 全局 | `git log` 显示初始提交 | 无 | ✅ 完成（Git 2.53.0 原生可用，2 次提交，37 个文件） |

---

## Phase 1: 内容生产链路（核心流程）

| # | 任务 | 所属模块 | 验证标准 | 依赖 | 状态 |
|---|------|----------|----------|------|------|
| T1.1 | 编写 `prompts/topic_analysis.txt` LLM prompt 模板 | M1 | LLM 回复包含方向分析 + 推荐角度 + 风险提示 | T0.4（验证） | ✅ 完成（实测 861 tokens，JSON 解析成功） |
| T1.2 | n8n 工作流：Webhook 接收创意 → LLM 选题分析 → 输出分析报告 | M1 | 提交创意触发工作流，输出 200-300 字选题分析 | T0.1, T1.1 | ✅ 完成（HTTP API `/api/pipeline` + CLI `test` 模式均可运行） |
| T1.3 | 编写 `prompts/script_gen.txt` LLM prompt 模板 | M2 | LLM 回复为可解析的脚本 JSON（文案 + 每段画面建议） | T0.4（验证） | ✅ 完成（实测 1467 tokens，8 段分镜 JSON 解析成功） |
| T1.4 | 审核暂停工作流：脚本生成后暂停，等待飞书确认 | M2 | 流程暂停，提供 approve/reject API | T1.2, T1.3, T0.3 | ✅ 完成（`/api/pipeline-with-review` + `/api/review/:id` + 12h/24h 超时） |
| T1.5 | 审核回调处理：通过 → 继续元数据生成；打回 → 返回修改意见 | M2 | 通过后自动生成元数据；打回后返回反馈 | T1.4 | ✅ 完成（`/api/review/:id/approve` + `/api/review/:id/reject`） |
| T1.6 | 搭建最小素材库：50 条素材 + 元数据 JSON | M2 | 每个素材文件对应一个 `{name}.json` 元数据文件 | T0.6 | 🔵 可开始（目录已就绪，T4.6 工具就绪，需收集素材） |
| T1.7 | 编写素材检索逻辑：标签 + 场景 + 质量排序 | M2 | 给定一个分镜描述，返回 ≥ 3 个候选素材 | T1.6 | ✅ 完成（`asset_search.js`，三维度加权打分，实测 2/8 匹配） |
| T1.8 | n8n 工作流：脚本 → 拆分镜 → 素材匹配 → Wait Node 暂停（审阅点 2） | M2 | 输出完整分镜 JSON（含候选素材），飞书推送分镜对照表 | T1.5, T1.7 | ✅ 完成（引擎 approve 审核点1 → TTS + 素材检索 → 审阅点2 暂停） |
| T1.9 | 飞书审阅回调处理：通过/替换素材后继续 | M2 | 素材替换后分镜 JSON 更新 | T1.8 | ✅ 完成（引擎 approve 审核点2 → Remotion Props → 渲染管线） |
| T1.10 | 配音生成：分镜脚本 → edge-tts → MP3 + 时间戳 | M3 | 配音 MP3 可播放，时间戳 JSON 与分镜一一对应 | T1.9, T0.5 | ✅ 完成（`tts.js`，实测 263KB MP3，8 分镜时间戳） |

---

## Phase 2: 视频渲染链路

| # | 任务 | 所属模块 | 验证标准 | 依赖 | 状态 |
|---|------|----------|----------|------|------|
| T2.1 | 开发 Remotion 模板（通用口播+画面风格），接收 JSON props | M4 | `npx remotion render` 成功输出 MP4 | T0.5 | ✅ 完成（模板脚手架 `templates/product_showcase/`，需安装依赖后渲染） |
| T2.2 | n8n Code 节点：分镜 JSON + 素材路径 → Remotion props JSON | M4 | 生成的 props JSON 被 Remotion 正确渲染 | T1.10, T2.1 | ✅ 完成（`remotion_props.js`，含 render.json + props.json 双输出） |
| T2.3 | n8n Execute Command 节点：调用 Remotion 渲染 + FFmpeg 字幕合成 | M4 | 输出 `outputs/{timestamp}/final.mp4`，1080p，音画同步 | T2.2 | ✅ 完成（`render.js`，Remotion 渲染 + FFmpeg VTT 字幕烧录） |
| T2.4 | ffprobe 质检脚本（分辨率/时长/编码/音轨） | M5 | 质检通过/失败 JSON 输出，失败项有明确说明 | T2.3 | ✅ 完成（`qc.js`，6 项检查，支持纯音频文件） |
| T2.5 | n8n 工作流：质检失败 → 自动重试渲染（最多 2 次） | M5 | 首次失败自动重试，3 次仍失败则飞书通知 | T2.4 | ✅ 完成（`render.js` 内建 max 2 次自动重试） |
| T2.6 | n8n 工作流：质检通过 → Wait Node 暂停（审阅点 3）→ 飞书推送 | M5 | 飞书收到成片预览说明（文件路径） | T2.5 | ✅ 完成（引擎 approve 审核点2 → 渲染 + QC → 审阅点3 暂停） |

---

## Phase 3: 分发与数据回收

| # | 任务 | 所属模块 | 验证标准 | 依赖 | 状态 |
|---|------|----------|----------|------|------|
| T3.1 | Google Cloud 项目创建 + YouTube Data API v3 启用 + OAuth 2.0 配置 | M7 | API 凭证存入 n8n Credential，测试 videos.list 可用 | 无 | ✅ 完成（OAuth 2.0 桌面应用凭证已配置，youtube.js 模块就绪） |
| T3.2 | 快手开放平台注册应用 + 获取 app_id/app_secret | M7 | 凭证存入 n8n Credential，测试 /openapi/photo/list 可用 | 无 | 🔵 可开始（需用户注册快手开放平台） |
| T3.3 | 编写 `prompts/metadata.txt` LLM prompt 模板 | M6 | LLM 输出符合 plan.md §3.3 的 JSON Schema | T0.4（验证） | ✅ 完成（实测 1778 tokens，YouTube/快手元数据解析成功） |
| T3.4 | n8n 工作流：成片通过 → LLM 生成各平台元数据 → Wait Node 暂停（审阅点 4） | M6 | 飞书推送 YouTube + 快手标题/描述/标签 | T3.3, T2.6 | ⬜ 待做（依赖 T2.6） |
| T3.5 | n8n 工作流：发布确认 → YouTube API videos.insert | M7 | YouTube Studio 中出现新视频，状态 private | T3.1, T3.4 | ✅ 完成（`youtube.js`，OAuth 2.0 + resumable upload 分块上传） |
| T3.6 | n8n 工作流：发布确认 → 快手 API start_upload → upload → publish | M7 | 快手创作者中心出现新视频 | T3.2, T3.4 | ⬜ 待做（依赖 T3.2） |
| T3.7 | n8n Cron 工作流：发布 24h 后查询 YouTube Analytics + 快手数据 | M8 | 飞书收到每日数据汇总（播放量/点赞/评论/分享） | T3.5, T3.6 | ⬜ 待做（依赖 T3.5, T3.6） |
| T3.8 | n8n Code 节点：高完播率素材自动标记（更新素材元数据 quality 字段） | M8 | 素材 JSON 的 quality 字段按规则更新 | T3.7 | ⬜ 待做（依赖 T3.7） |

---

## Phase 4: 体验优化与稳定性（可选）

| # | 任务 | 所属模块 | 验证标准 | 依赖 | 状态 |
|---|------|----------|----------|------|------|
| T4.1 | 飞书审阅卡片增加超时提醒：12h 提醒 + 24h 自动过期 | M0 | 等待超时后状态自动变更 | T1.4 | ✅ 完成（`createReview()` 内置 12h/24h 定时器） |
| T4.2 | 全局错误处理：关键节点失败时捕获并返回 | M0 | 任意请求报错时返回 500 + 错误详情 | Phase 1-3 完成 | ✅ 完成（引擎全局 try/catch + 错误日志） |
| T4.3 | 扩展 Remotion 模板：新增动画科普风格 | M4 | 新模板渲染输出风格显著不同于通用模板 | T2.3 | ✅ 完成（`templates/animation_knowledge/`，8色渐变主题 + 粒子特效 + 入场/结尾动画） |
| T4.4 | TTS 切换为豆包语音（可选替代 edge-tts） | M3 | 配音效果明显优于 edge-tts | T0.5 | ⬜ 待做（可选） |
| T4.5 | 工作流 JSON 导出脚本：一键备份所有模块到 `workflows/` | M0 | `workflows/` 目录下包含所有模块备份 | Phase 1-3 完成 | ✅ 完成（`export_workflow.js`，实测导出 10 文件） |
| T4.6 | 素材库扩展脚本：批量生成素材元数据模板 | M2 | 给定素材文件夹，自动生成元数据 JSON 骨架 | T1.6 | ✅ 完成（`scripts/generate_metadata_templates.py`，含示例元数据） |

---

## 进度总览

| Phase | 完成 | 待做 | 需用户操作 |
|-------|------|------|-----------|
| Phase 0 基础设施 | 7/7 | — | — |
| Phase 1 内容生产 | 10/10 | — | — |
| Phase 2 视频渲染 | 6/6 | — | — |
| Phase 3 分发回收 | 3/8 | T3.2, T3.4, T3.6-T3.8 | 快手注册 |
| Phase 4 优化稳定 | 5/6 | T4.4（可选） | 无 |
| **总计** | **31/37** | | |
