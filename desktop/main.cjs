/**
 * ZITO Email — Windows 托盘壳
 * 拉起本机 Express（ZITO_DESKTOP=1），内嵌窗口打开 http://127.0.0.1:<port>
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PREFERRED_PORT = Number(process.env.PORT || 3310);
const HEALTH_TIMEOUT_MS = 60_000;

let mainWindow = null;
let tray = null;
let serverProc = null;
let serverPort = PREFERRED_PORT;
let quitting = false;

function appRoot() {
  if (app.isPackaged) {
    // asar 内：app.getAppPath()；原生模块在 app.asar.unpacked
    return app.getAppPath();
  }
  return path.join(__dirname, '..');
}

function iconPath() {
  const candidates = [
    path.join(__dirname, 'icon.png'),
    path.join(appRoot(), 'web', 'public', 'zito-icon.svg'),
    path.join(appRoot(), 'dist', 'zito-icon.svg'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function loadTrayIcon() {
  const p = iconPath();
  if (!p) return nativeImage.createEmpty();
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  } catch (_) {}
  return nativeImage.createEmpty();
}

function waitForHealth(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(port);
        if (Date.now() - started > timeoutMs) return reject(new Error('健康检查超时'));
        setTimeout(tryOnce, 400);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return reject(new Error('服务启动超时'));
        setTimeout(tryOnce, 400);
      });
      req.on('timeout', () => {
        req.destroy();
      });
    };
    tryOnce();
  });
}

function resolveServerEntry() {
  const root = appRoot();
  const entry = path.join(root, 'server', 'index.js');
  if (!fs.existsSync(entry)) throw new Error('找不到 server/index.js: ' + entry);
  return { entry, cwd: root };
}

function startServer() {
  if (serverProc) return Promise.resolve(serverPort);

  const { entry, cwd } = resolveServerEntry();
  const env = {
    ...process.env,
    ZITO_DESKTOP: '1',
    NODE_ENV: 'production',
    PORT: String(PREFERRED_PORT),
    BIND_HOST: '127.0.0.1',
    COOKIE_SECURE: '0',
  };

  let bin = process.env.npm_node_execpath || 'node';
  const args = [entry];
  if (app.isPackaged) {
    const bundled = path.join(
      process.resourcesPath,
      'node',
      process.platform === 'win32' ? 'node.exe' : 'node'
    );
    if (!fs.existsSync(bundled)) {
      throw new Error('安装包缺少运行时 node：' + bundled);
    }
    bin = bundled;
  }

  serverProc = spawn(bin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProc.stdout.on('data', (buf) => {
    const line = String(buf);
    process.stdout.write(`[server] ${line}`);
    const m = line.match(/服务已启动 https?:\/\/[^:]+:(\d+)/);
    if (m) serverPort = Number(m[1]) || serverPort;
  });
  serverProc.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));
  serverProc.on('exit', (code) => {
    serverProc = null;
    if (!quitting) {
      console.error('[desktop] 服务进程退出', code);
    }
  });

  return waitForHealth(PREFERRED_PORT, 8000).catch(async () => {
    // 端口可能被递增；读 port.txt
    const home = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'ZITO-EMAIL', 'data', 'port.txt')
      : null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (home && fs.existsSync(home)) {
        const p = Number(String(fs.readFileSync(home, 'utf8')).trim());
        if (p) {
          try {
            await waitForHealth(p, 3000);
            serverPort = p;
            return p;
          } catch (_) {}
        }
      }
      for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 20; p++) {
        try {
          await waitForHealth(p, 800);
          serverPort = p;
          return p;
        } catch (_) {}
      }
    }
    throw new Error('本机服务未能在时限内就绪');
  });
}

function stopServer() {
  if (!serverProc) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(serverProc.pid), '/t', '/f'], { windowsHide: true });
    } else {
      serverProc.kill('SIGTERM');
    }
  } catch (_) {}
  serverProc = null;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'ZITO 智能邮箱',
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function openExternalUpdate() {
  shell.openExternal('https://github.com/zitoglobal/ZITO-EMAIL/releases');
}

function dataHomePath() {
  return process.env.ZITO_HOME
    || path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'ZITO-EMAIL');
}

function isOpenAtLogin() {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setOpenAtLogin(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
  } catch (e) {
    console.warn('[desktop] setLoginItemSettings', e.message);
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const openLogin = isOpenAtLogin();
  const menu = Menu.buildFromTemplate([
    { label: '打开 ZITO 邮箱', click: () => createWindow() },
    {
      label: '在浏览器中打开',
      click: () => shell.openExternal(`http://127.0.0.1:${serverPort}/`),
    },
    { type: 'separator' },
    {
      label: '打开数据文件夹',
      click: () => {
        const home = dataHomePath();
        fs.mkdirSync(home, { recursive: true });
        shell.openPath(home);
      },
    },
    {
      label: '立即备份',
      click: async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${serverPort}/api/desktop/backup`, { method: 'POST' });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          const dir = j.dir || path.join(dataHomePath(), 'data', 'backups');
          fs.mkdirSync(dir, { recursive: true });
          await dialog.showMessageBox({
            type: 'info',
            title: '备份完成',
            message: j.file ? `已写入 ${j.file}` : '备份完成',
            detail: dir,
          });
          shell.openPath(dir);
        } catch (e) {
          dialog.showErrorBox('备份失败', e.message || String(e));
        }
      },
    },
    {
      label: openLogin ? '开机自启 ✓' : '开机自启',
      type: 'checkbox',
      checked: openLogin,
      click: (item) => {
        setOpenAtLogin(item.checked);
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '重启服务',
      click: async () => {
        stopServer();
        try {
          await startServer();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
          }
        } catch (e) {
          dialog.showErrorBox('重启失败', e.message);
        }
      },
    },
    { label: '检查更新…', click: () => openExternalUpdate() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function buildTray() {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('ZITO 智能邮箱');
  // 首次安装默认开启开机自启（可在托盘关掉）
  try {
    const settings = app.getLoginItemSettings();
    if (!settings.openAtLogin && !settings.wasOpenedAtLogin) {
      // 仅当用户从未配置过时：用本地标记
      const flag = path.join(dataHomePath(), 'autostart-asked.json');
      if (!fs.existsSync(flag)) {
        setOpenAtLogin(true);
        fs.mkdirSync(path.dirname(flag), { recursive: true });
        fs.writeFileSync(flag, JSON.stringify({ at: Date.now(), enabled: true }));
      }
    }
  } catch (_) {}
  rebuildTrayMenu();
  tray.on('double-click', () => createWindow());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createWindow());

  app.whenReady().then(async () => {
    try {
      await startServer();
      buildTray();
      createWindow();
    } catch (e) {
      dialog.showErrorBox('ZITO Email 启动失败', e.message || String(e));
      quitting = true;
      app.quit();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServer();
  });

  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });
}
