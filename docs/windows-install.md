# ZITO Email · Windows 本机安装说明

面向销售员本机的 **托盘常驻版**。云端产品仍为 <https://mail.zitoglobal.com/>；本安装包为同仓第二发行通道（内网 / 客户自建 / 离线补充）。

## 功能基线

对应 Git 标签 `v1.0.0-desktop-candidate`：

- 包含：认领与阶段、多款单价/MOQ、样品、团队品牌、跟进序列、资料库、销售台布局、AI 业务上下文
- 不包含：完整 CRM/PLM、群发 ESP、漏斗 cohort 深挖

## 最终用户：安装与使用

1. 运行 `ZITO-Email-Setup-x.y.z.exe`（NSIS）
2. 安装完成后启动 **ZITO Email**，系统托盘出现图标
3. 首次打开：创建管理员账号 →（可选）填写 AI API Key → 进入
4. 在设置中绑定企业邮箱 / Gmail / Outlook 等，即可收发与成交跟进

### 数据位置

| 内容 | 路径 |
|------|------|
| 配置与密钥 | `%APPDATA%\ZITO-EMAIL\config.json` |
| 数据库与附件 | `%APPDATA%\ZITO-EMAIL\data\` |

卸载安装程序 **默认不删除** 上述数据（可保留客户邮件库）。若需彻底清除，请手动删除 `%APPDATA%\ZITO-EMAIL`。

### 托盘菜单

- **打开数据文件夹**：打开 `%APPDATA%\ZITO-EMAIL`（配置与数据库）
- **立即备份**：写入加密 `.db.enc` 到数据目录下 `backups/`，并打开该文件夹
- **开机自启**：首次安装默认开启，可在托盘取消勾选
- **检查更新…**：打开 GitHub Releases（证书就绪前不做静默自动更新）

设置 → 偏好里也可「立即导出加密备份」。重装系统前务必备份。

### 常见问题

- **SmartScreen 提示**：未代码签名时 Windows 可能拦截。选「更多信息」→「仍要运行」。取得证书后会补签名与自动更新。
- **端口占用**：默认尝试 `3310` 起连续端口；实际端口写入 `data\port.txt`。
- **杀毒误报**：托盘 + 常驻 Node 同步进程可能被启发式拦截，请加入信任。
- **备份**：托盘「立即备份」、设置「立即导出加密备份」，或直接复制 `%APPDATA%\ZITO-EMAIL`。

## 开发者：本机验证

```bash
npm ci
npm run build
npm run start:desktop
# 浏览器访问控制台打印的 http://127.0.0.1:<port>
```

托盘壳：

```bash
npm run build
npm run desktop
```

打安装包（需 Windows）：

```bash
npm run dist:win
# 产物：release/ZITO-Email-Setup-<version>.exe
# 安装包内嵌构建机同版本的 node.exe（与 better-sqlite3 匹配），无需用户预装 Node
```

环境变量：

| 变量 | 说明 |
|------|------|
| `ZITO_DESKTOP=1` | 启用本机模式（AppData、自动 MAIL_SECRET、本机绑定） |
| `ZITO_HOME` | 覆盖默认 `%APPDATA%\ZITO-EMAIL` |
| `PORT` | 首选端口（冲突时自动递增） |

## 代码签名与自动更新（后续）

当前发行：**不签名**；更新通道为打开 Releases 页面。  
取得 EV/OV 代码签名证书后：

1. 在 CI / 打包机配置 `CSC_LINK` / `CSC_KEY_PASSWORD`
2. 再接入 `electron-updater` 做静默或提示更新
