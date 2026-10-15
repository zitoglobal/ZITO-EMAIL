# ZITO-EMAIL · ZITO 智能邮箱

线上地址：<https://mail.zitoglobal.com/>

面向外贸团队的智能邮件平台：多邮箱统一收发、今日待回复分诊、跟进提醒、稍后处理、定时发送、AI 摘要与回复建议、命令面板（Ctrl/⌘ K）。

## 技术栈

- 服务端：Node.js 20（ESM）、Express、imapflow（IMAP IDLE 同步）、nodemailer（SMTP）、better-sqlite3（WAL）、SSE 实时推送
- 前端：React 18、Vite 6、lucide-react
- 部署：阿里云香港 Ubuntu 24.04 + pm2 + Nginx + Let's Encrypt

## 目录结构

```
server/        API 与邮件同步（index.js 入口，sync.js 同步，priority.js 分诊，ai.js 智能能力）
web/           前端源码（src/components 为各界面组件，public 为图标与 PWA 清单）
scripts/       本地演示数据、测试账号种子、端到端测试
deploy/        一键部署脚本、服务器初始化脚本、Nginx 站点配置
.env.example   环境变量模板（真实 .env 不入库）
AGENTS.md      AI 助手协作约定
```

## 本地开发

```bash
npm ci
cp .env.example .env      # 按需修改 MAIL_SECRET 等
npm run dev               # API :3310 + Vite 开发服务器
```

生产方式运行：`npm run build && npm start`，访问 <http://localhost:3310>。

## 部署

```bash
python deploy/deploy.py app      # 构建并发布到服务器
python deploy/deploy.py status   # 查看线上状态
```

需要本机持有服务器 SSH 密钥（不在仓库中）。

## 安全约定

- `.env`、`data/`、`*.pem` 等凭据与运行数据一律不入库
- 邮箱授权码在服务端用 `MAIL_SECRET` 加密存储，修改该密钥会导致已绑定邮箱需重新验证
