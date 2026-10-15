#!/usr/bin/env bash
# 在服务器上执行：解包新版本、按需安装依赖、重启 pm2。日志写入 /tmp/zm-deploy.log
set -e
APP=/opt/zito-mail
PKG=/tmp/zito-mail.tgz
mkdir -p "$APP"
cd "$APP"

OLD_LOCK=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)
rm -rf server dist
tar -xzf "$PKG" -C "$APP"
NEW_LOCK=$(md5sum package-lock.json | cut -d' ' -f1)

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^MAIL_SECRET=.*|MAIL_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^DATA_DIR=.*|DATA_DIR=$APP/data|" .env
fi

if [ ! -d node_modules ] || [ "$OLD_LOCK" != "$NEW_LOCK" ]; then
  echo "安装依赖..."
  npm ci --omit=dev --no-audit --no-fund
fi

if pm2 describe zito-mail > /dev/null 2>&1; then
  pm2 restart zito-mail --update-env
else
  pm2 start server/index.js --name zito-mail --cwd "$APP" --max-memory-restart 600M
  pm2 startup systemd -u root --hp /root || true
fi
pm2 save
sleep 3
curl -s -o /dev/null -w "HEALTH %{http_code}\n" http://127.0.0.1:3310/
echo "DEPLOY_DONE"
