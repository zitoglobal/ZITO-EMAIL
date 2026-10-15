"""ZITO 智能邮箱部署脚本。

用法（在项目根目录执行）：
    python deploy/deploy.py app      构建前端、打包上传、安装依赖并重启（默认）
    python deploy/deploy.py nginx    更新 Nginx 站点配置
    python deploy/deploy.py cert     签发 HTTPS 证书并开启 COOKIE_SECURE
    python deploy/deploy.py status   查看线上进程与日志
    python deploy/deploy.py all      nginx + app
"""
import os
import subprocess
import sys
import tarfile
import time

HOST = 'root@47.82.99.116'
KEY = r'c:\temp\mail.pem'
DOMAIN = 'mail.zitoglobal.com'
APP = '/opt/zito-mail'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.join(os.environ.get('TEMP', r'c:\temp'), 'zito-mail.tgz')
SSH = ['ssh', '-i', KEY, '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', HOST]


def run(cmd, **kw):
    print('>', ' '.join(cmd) if isinstance(cmd, list) else cmd)
    return subprocess.run(cmd, check=True, **kw)


def remote(script, capture=False):
    r = subprocess.run(SSH + [script], text=True, encoding='utf-8', errors='replace',
                       capture_output=capture)
    if r.returncode != 0 and not capture:
        sys.exit(f'远程命令失败（{r.returncode}）')
    return r.stdout if capture else None


def upload(local, dest):
    run(['scp', '-i', KEY, '-o', 'BatchMode=yes', local, f'{HOST}:{dest}'])


def build():
    run('npx vite build', shell=True, cwd=ROOT)
    with tarfile.open(PKG, 'w:gz') as t:
        for p in ['server', 'dist', 'package.json', 'package-lock.json', '.env.example']:
            t.add(os.path.join(ROOT, p), arcname=p)
    print(f'打包完成 {os.path.getsize(PKG) // 1024} KB')


def deploy_app():
    build()
    upload(PKG, '/tmp/zito-mail.tgz')
    upload(os.path.join(ROOT, 'deploy', 'remote-setup.sh'), '/tmp/zm-setup.sh')
    # 编译依赖可能耗时数分钟，SSH 会被断开，因此放到后台执行并轮询日志
    remote("sed -i 's/\\r$//' /tmp/zm-setup.sh && rm -f /tmp/zm-deploy.log && "
           "nohup bash /tmp/zm-setup.sh > /tmp/zm-deploy.log 2>&1 &")
    for _ in range(90):
        time.sleep(5)
        log = remote('cat /tmp/zm-deploy.log; pgrep -f "bash /tmp/zm-[s]etup" >/dev/null || echo SETUP_EXITED',
                     capture=True) or ''
        if 'DEPLOY_DONE' in log or 'SETUP_EXITED' in log:
            print(log[-1500:])
            if 'HEALTH 200' not in log:
                sys.exit('部署后健康检查失败，请执行 status 查看日志')
            print(f'部署完成：https://{DOMAIN}/')
            return
    sys.exit('等待超时，请执行 status 查看进度')


def deploy_nginx():
    upload(os.path.join(ROOT, 'deploy', 'nginx-zito-mail.conf'), '/etc/nginx/sites-available/zito-mail')
    remote("sed -i 's/\\r$//' /etc/nginx/sites-available/zito-mail && "
           "ln -sf /etc/nginx/sites-available/zito-mail /etc/nginx/sites-enabled/zito-mail && "
           "nginx -t && systemctl reload nginx")


def deploy_cert():
    remote(f"certbot --nginx -d {DOMAIN} --non-interactive --agree-tos --redirect "
           f"--register-unsafely-without-email && "
           f"sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=1/' {APP}/.env && "
           f"pm2 restart zito-mail --update-env && "
           f"curl -s -o /dev/null -w 'HTTPS %{{http_code}}\\n' https://{DOMAIN}/")


def status():
    remote("pm2 ls | grep zito-mail; pm2 logs zito-mail --lines 20 --nostream; "
           "tail -5 /tmp/zm-deploy.log 2>/dev/null")


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'app'
    actions = {'app': [deploy_app], 'nginx': [deploy_nginx], 'cert': [deploy_cert],
               'status': [status], 'all': [deploy_nginx, deploy_app]}
    if cmd not in actions:
        sys.exit(__doc__)
    for fn in actions[cmd]:
        fn()
