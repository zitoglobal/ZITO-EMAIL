# ZITO 智能邮箱

## 语言要求
- 除非用户明确要求，否则所有回复一律使用简体中文；代码注释、变量名遵循项目已有惯例。

## 本地开发
- 启动：`npm run dev`（API 3310 + Vite），或 `npx vite build` 后 `node server/index.js`，访问 `http://localhost:3310`
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
