# ZITO 智能邮箱

## 语言要求
- 除非用户明确要求，否则所有回复一律使用简体中文；代码注释、变量名遵循项目已有惯例。

## 本地开发
- 启动：`npm run dev`（API 3310 + Vite），或 `npx vite build` 后 `node server/index.js`，访问 `http://localhost:3310`
- 本地演示账号：`admin@zito.test` / `Passw0rd!`（仅本地数据库）
- 不要读取或打印 `.env` 等凭据文件

## 线上部署（阿里云香港）
- **服务器**：`root@47.82.99.116`，SSH 密钥 `c:\temp\mail.pem`
- **正式域名**：`https://mail.zitoglobal.com/`（DNS 在 DNSPod，需 A 记录指向 `47.82.99.116`）
- **部署路径**：`/opt/zito-mail`，pm2 进程名 `zito-mail`，端口 3310；数据在 `/opt/zito-mail/data`，配置在 `/opt/zito-mail/.env`
- **Nginx**：站点源文件 `deploy/nginx-zito-mail.conf` → `/etc/nginx/sites-available/zito-mail`；`/api/events` 必须保持 `proxy_buffering off`
- 该服务器同时运行 `core.zitoglobal.com`（默认站点，占用 IP 访问及 8080/8765/8766 端口），不要改动其配置
- **发布**：`python deploy/deploy.py app`；更新 Nginx 用 `nginx`；DNS 生效后签证书用 `cert`；查看状态用 `status`
