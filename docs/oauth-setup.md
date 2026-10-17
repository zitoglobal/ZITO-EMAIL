# Gmail / Microsoft 365 OAuth 配置

未配置时，绑定页仍可用「授权码 / 应用专用密码」。配置后出现「一键授权」。

## 通用

1. 生产设置 `PUBLIC_BASE_URL=https://mail.zitoglobal.com`（无尾斜杠）
2. 回调地址必须与控制台登记一致：
   - Gmail：`{PUBLIC_BASE_URL}/api/oauth/gmail/callback`
   - Microsoft：`{PUBLIC_BASE_URL}/api/oauth/microsoft/callback`
3. 改完 `.env` 后重启 `zito-mail`（pm2）
4. 管理员可在「销售洞察 → 系统状态」确认 OAuth 开关

本地开发可另设：

```
PUBLIC_BASE_URL=http://localhost:3310
GOOGLE_OAUTH_REDIRECT=http://localhost:3310/api/oauth/gmail/callback
MS_OAUTH_REDIRECT=http://localhost:3310/api/oauth/microsoft/callback
```

## Google Cloud（Gmail）

1. [Google Cloud Console](https://console.cloud.google.com/) 创建项目
2. 「API 和服务 → 启用 API」启用 **Gmail API**
3. 「OAuth 同意屏幕」：外部或内部；测试用户可加自家账号
4. 「凭据 → 创建 OAuth 客户端 ID」类型选 **Web 应用**
5. 已授权的重定向 URI 填上面对应 callback
6. 写入环境变量：

```
GOOGLE_OAUTH_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=....
```

范围：`https://mail.google.com/`（IMAP/SMTP XOAUTH2）+ openid email profile。首次授权需拿到 refresh_token（代码已 `access_type=offline` + `prompt=consent`）。

## Azure（Microsoft 365 / Outlook）

1. [Azure Portal → 应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps)
2. 新建应用，平台选 **Web**，重定向 URI 填 Microsoft callback
3. 「证书和密码」新建客户端密码
4. 「API 权限」添加：
   - Microsoft Graph：`User.Read`、`openid`、`email`、`profile`、`offline_access`
   - 或 Office 365 Exchange Online：`IMAP.AccessAsUser.All`、`SMTP.Send`（委托权限）
5. 管理员同意（企业租户通常需要）
6. 写入：

```
MS_OAUTH_CLIENT_ID=应用(客户端) ID
MS_OAUTH_CLIENT_SECRET=客户端密码
MS_OAUTH_TENANT=common
```

单租户可把 `MS_OAUTH_TENANT` 设为目录租户 ID。

## 重新授权

设置 → 邮箱账号 → OAuth 邮箱点「重新授权」。令牌失效（改密、撤销应用）后同步会报错，重新授权即可，无需解绑。
