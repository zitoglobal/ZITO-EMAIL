# ZITO 智能邮箱

## 语言要求
- 除非用户明确要求，否则所有回复一律使用简体中文；代码注释、变量名遵循项目已有惯例。

## 品牌 LOGO（锁定）
- **禁止**改动 `web/src/components/Brand.jsx`（BrandIcon / BrandWordmark / BrandSymbol）的路径、配色、比例与布局，除非用户明确要求改 LOGO。
- UI 精修只动按钮/列表/读信等控件；侧栏 `.brand-name` 字标排版保持品牌规范原样，勿对 LOGO 做滤镜、改色、拉伸或重排。

## 本地开发
- 启动：`npm run dev`（API 3310 + Vite），或 `npx vite build` 后 `node server/index.js`，访问 `http://localhost:3310`
- 纯逻辑单测：`npm test`（classify / SLA / mail rules / deals 认领键，不依赖真实邮箱）
- 团队认领与业务阶段：邮箱内 `deals` 表（勿对接已下线的 crm.zitoglobal.com）
- 安全基线：生产默认 `BIND_HOST=127.0.0.1`、Cookie Secure、绑定/连接前 SSRF 复检（`net_guard.js`）；读信 HTML 消毒；会话空闲 14 / 绝对 30 天；登录默认踢掉其它会话；可选 TOTP（管理员强制开启方可调用 `/api/admin/*`，紧急排障可设 `ADMIN_TOTP_REQUIRED=0`）；管理面另有应用层限流
- 隐私：用户可关「云端 AI」（`aiCloudOk`，设置→偏好）；公海同事箱不回传 snippet；presence 仅同信观众；备份默认 `.db.enc`（`BACKUP_SECRET`/`MAIL_SECRET`）
- Nginx：`deploy/nginx-zm-limit.conf` 登录/API 边缘限流；部署用 `python deploy/deploy.py nginx`
- 业务阶段变更会同步外贸标签；今日待办 / 等待默认「跟进中」（未认领+我跟），可筛全部/未认领/我跟/同事跟；两边均支持单封/批量认领
- 公海认领同事箱：不打开原信（隐私），自动引导「写首封跟进」草稿；FTS 删信同步清理，启动差量 backfill
- 可靠发信：outbox 条件删除 + claim sending 互斥；撤销窗口不预认领；调度 1.5s
- IMAP 旗标：瞬时失败入 `flag_retry` 队列，认证失败才标邮箱 error；Drafts 45s 轮询；无 Sent 映射时提示
- 发信默认自动认领客户（设置可关）；发信后可软提示推进阶段；侧栏「我的客户」按阶段扫管线
- 认领粒度：企业域默认公司键，可读信区「仅此人 / 拆到个人」；lookup/列表优先个人认领，避免一人锁整司
- AI 失败可见：自动摘要/翻译失败行内「失败 · 重试」；关闭云端与未配置文案区分（读信 / Composer）
- 认领/接管/改阶段/释放/拆分写入 `deal_events`；DealBar 可改备注、下次跟进日、看记录；催单模板按阶段区分
- 读信后按正文重算意图 signals；搜索走 FTS5（正文）；侧栏「销售洞察」轻报表；PWA + Web Push（设置 → 偏好）
- 今日待办/等待附「为何」验真；`GET /api/focus/explain?id=`；管理员可免绑邮箱进主界面（空态可开通成员）
- Sent IDLE + 45s 轮询 + 发信后强制拉 Sent，缩短「已回仍待办」窗口
- Gmail / M365 OAuth：`docs/oauth-setup.md`；设置→团队成员可见就绪态；启动日志提示缺口；IMAP/SMTP XOAUTH2
- 团队公海：VIP/超时排序；指派；管理员超时催办（SSE `remind-queue` + Push，2h 冷却）；认领自己箱邮件自动打开今日待办并抬分
- 读信「同事正在看」：`/api/presence/*` + SSE `presence`；管理员「销售洞察」含 `/api/admin/ops`
- AI 深度：`server/ai_context.js` 向 `/api/ai/reply` 注入阶段/认领/SLA/信号；`/api/ai/triage` 返回可一键执行的 actions（认领/阶段/稍后/回复/催单/已处理），今日待办点按钮即执行
- AI 自动路由：按任务+复杂度选模（默认快 `qwen3.6-flash` / 中 `deepseek-v4.1-flash` / 强 `qwen3.8-max`）；复杂回复才开深度思考；`AI_AUTO_ROUTE`/`AI_THINKING_STRONG`；分诊吃缓存正文；可选 `autoTriageFocus`
- Token Plan 还可用 deepseek-v4-pro、glm-5.2 等；音视频/图片模不接入邮件链路；`glm-5.3` 强制 thinking 勿作快档
- 读信：`MessageCard` 须传入 `viewers`；`MailFrame` 折叠引用只改 body 片段；BodyGuard + 顶层 AppErrorBoundary；cid 图两侧 clean Content-ID，大图走附件 URL，旧缓存含 `cid:` 会自动重拉
- 会话：References 链解析 + 入库回填；会话视图跨本账号多邮箱；Focus 去重用 `conversationKey`
- 路由拆分：`routes_collab.js` / `routes_deals.js` / `routes_focus.js`；前端 boot：`hooks/useAppBoot.js`
- 勿对接已下线的 crm.zitoglobal.com
- CI：`.github/workflows/test.yml` 跑 `npm test` + `npm run build`
- 本地演示账号：`admin@zito.test` / `Passw0rd!`（仅本地数据库）
- 不要读取或打印 `.env` 等凭据文件

## 部署（概要）
- 正式产品域名见 README（`mail.zitoglobal.com`）
- 本机部署目标（SSH 主机、密钥路径等）**不要写进仓库**：复制 `deploy/deploy.local.env.example` 为 `deploy/deploy.local.env`（已 gitignore）后填写，再执行 `python deploy/deploy.py …`
- Nginx 配置源文件：`deploy/nginx-zito-mail.conf`；`/api/events` 必须保持 `proxy_buffering off`
- 常用命令：`python deploy/deploy.py app` / `nginx` / `cert` / `status`
- 不要改动同机其它站点的 Nginx/进程配置

## 与 ZITO.AI 工作区的链接
- 真实仓库目录：`D:\ZITO-AI-EMAIL`
- 在 `D:\ZITO.AI项目` 中通过 junction `ZITO-EMAIL/` 可见；也可打开 `D:\ZITO.AI项目\ZITO.AI.code-workspace`
- GitHub：`https://github.com/zitoglobal/ZITO-EMAIL`
- 正式域名：`https://mail.zitoglobal.com/`
- 本机每小时自动同步：计划任务 `ZITO-EMAIL-AutoSync` → `D:\ZITO-AI-EMAIL-sync\sync.ps1`（pull/push `main`；密钥类文件会本地 HOLD）
- 旧路径 `D:\ZITO智能邮箱` 已废弃，勿再使用
