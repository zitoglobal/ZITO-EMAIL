# ZITO 智能邮箱

## 语言要求
- 除非用户明确要求，否则所有回复一律使用简体中文；代码注释、变量名遵循项目已有惯例。

## 本地开发
- 启动：`npm run dev`（API 3310 + Vite），或 `npx vite build` 后 `node server/index.js`，访问 `http://localhost:3310`
- 纯逻辑单测：`npm test`（classify / SLA / mail rules / deals 认领键，不依赖真实邮箱）
- 团队认领与业务阶段：邮箱内 `deals` 表（勿对接已下线的 crm.zitoglobal.com）
- 安全基线：生产默认 `BIND_HOST=127.0.0.1`、Cookie Secure、绑定邮箱禁内网 SSRF（`server/net_guard.js`）；读信 HTML 服务端消毒（`sanitize_mail.js`）；会话空闲 14 天 / 绝对 30 天；可选 TOTP + 备用恢复码（设置 → 账号）
- 业务阶段变更会同步外贸标签；今日待办 / 等待 可按「未认领 / 我跟 / 同事跟」筛选，支持单封/批量认领
- 发信默认自动认领客户（设置可关）；发信后可软提示推进阶段；侧栏「我的客户」按阶段扫管线
- 认领/接管/改阶段/释放写入 `deal_events`；DealBar 可改备注、下次跟进日、看记录；催单模板按阶段区分
- 读信后按正文重算意图 signals；搜索走 FTS5（正文）；侧栏「销售洞察」轻报表；PWA + Web Push（设置 → 偏好）
- 今日待办/等待附「为何」验真；`GET /api/focus/explain?id=`；管理员可免绑邮箱进主界面（空态可开通成员）
- Sent IDLE + 45s 轮询 + 发信后强制拉 Sent，缩短「已回仍待办」窗口
- Gmail / M365 OAuth：`docs/oauth-setup.md`；设置→团队成员可见就绪态；启动日志提示缺口；IMAP/SMTP XOAUTH2
- 团队公海：VIP/超时排序；指派；管理员超时催办（SSE `remind-queue` + Push，2h 冷却）；认领自己箱邮件自动打开今日待办并抬分
- 读信「同事正在看」：`/api/presence/*` + SSE `presence`；管理员「销售洞察」含 `/api/admin/ops`
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
