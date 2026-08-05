const { app, BrowserWindow, shell, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");
const bossBrowser = require("./boss-browser");
const bossActions = require("./boss-actions");

/**
 * Security model:
 * - Packaged Windows builds NEVER embed .env / MySQL / Gateway tokens.
 * - They only open a public server URL from public-config.json.
 * - Secrets stay on the server-side BFF.
 * - Boss 直聘 runs in a separate local BrowserWindow (type B): user's PC,
 *   user's IP, user's login session — not the shared server browser.
 * - Resume download / request / re-chat DOM actions run only in that local window.
 */

let mainWindow = null;
let bffProcess = null;
let startedBff = false;

function logFile() {
  try {
    return path.join(app.getPath("userData"), "assistant-startup.log");
  } catch {
    return path.join(process.cwd(), "assistant-startup.log");
  }
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(logFile(), msg);
  } catch {
    // ignore
  }
  console.error(line);
}

function readPublicConfig() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, "public-config.json"));
  } else {
    candidates.push(path.join(__dirname, "public-config.json"));
    candidates.push(path.join(__dirname, "packaging-resources", "public-config.json"));
  }
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const config = JSON.parse(fs.readFileSync(p, "utf8"));
    const url = String(config.serverUrl || "").trim();
    if (!url) {
      throw new Error("缺少 serverUrl；正式安装包必须在构建时配置公网 HTTPS 服务地址");
    }
    return { ...config, serverUrl: url };
  }
  throw new Error("找不到 public-config.json；请重新安装正式客户端");
}

function probeUrl(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const transport = u.protocol === "https:" ? https : http;
      const req = transport.get(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: `${u.pathname.replace(/\/$/, "")}/api/health`,
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function ensureDevBff() {
  // Only for local development. Packaged builds must not start a secret-bearing BFF.
  if (app.isPackaged) return;
  if (await probeUrl("http://127.0.0.1:8787/")) return;

  const backendEntry = path.join(__dirname, "..", "backend", "src", "server.js");
  if (!fs.existsSync(backendEntry)) {
    throw new Error("开发模式找不到本地后端");
  }
  const envPath = path.join(__dirname, "..", ".env");
  bffProcess = spawn("node", [backendEntry], {
    cwd: path.join(__dirname, "..", "backend"),
    env: {
      ...process.env,
      PRODUCT_ENV_PATH: envPath,
    },
    stdio: "inherit",
  });
  startedBff = true;

  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (await probeUrl("http://127.0.0.1:8787/")) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("本地开发后端启动超时");
}

function createWindow(serverUrl) {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: "聚元灵创",
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(serverUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

async function failAndQuit(err) {
  const message = err?.message || String(err);
  log(`FATAL: ${message}`);
  try {
    await dialog.showMessageBox({
      type: "error",
      title: "聚元灵创启动失败",
      message: "无法连接服务器",
      detail: `${message}\n\n正式包不会内置密钥；请确认服务器已启动，且 public-config.json 中的 serverUrl 可访问。\n日志：${logFile()}`,
    });
  } catch {
    // ignore
  }
  app.quit();
}

app.whenReady().then(async () => {
  try {
    fs.writeFileSync(logFile(), "");
    const config = readPublicConfig();
    const serverUrl = String(config.serverUrl || "").replace(/\/$/, "") + "/";
    log(`mode=${app.isPackaged ? "packaged" : "dev"} serverUrl=${serverUrl}`);

    if (!app.isPackaged) {
      await ensureDevBff();
    } else {
      const ok = await probeUrl(serverUrl);
      if (!ok) {
        throw new Error(`服务器不可达：${serverUrl}`);
      }
    }

    createWindow(serverUrl);
  } catch (err) {
    await failAndQuit(err);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const config = readPublicConfig();
      createWindow(config.serverUrl.replace(/\/$/, "") + "/");
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (startedBff && bffProcess && !bffProcess.killed) {
    bffProcess.kill();
  }
});

ipcMain.handle("desktop:restart", async () => {
  log("restart requested from renderer");
  try {
    restartDesktopApp();
    return { ok: true };
  } catch (err) {
    log(`restart failed: ${err?.message || err}`);
    throw err;
  }
});

ipcMain.handle("boss:open-login", async (_evt, opts = {}) => {
  log(`boss:open-login restart=${Boolean(opts?.restart)}`);
  return bossBrowser.openBossLogin({ restart: Boolean(opts?.restart) });
});

ipcMain.handle("boss:check-login", async () => {
  log("boss:check-login");
  return bossBrowser.checkBossLogin({ navigateChat: true });
});

ipcMain.handle("boss:refresh-preview", async () => {
  return bossBrowser.refreshBossPreview();
});

ipcMain.handle("boss:show-window", async () => {
  return bossBrowser.showBossWindow();
});

ipcMain.handle("boss:request-resumes", async (_evt, opts = {}) => {
  log(`boss:request-resumes limit=${opts?.limit || 5} names=${(opts?.names || []).length}`);
  return bossActions.autoRequestResumes({
    limit: Number(opts?.limit) || 5,
    names: Array.isArray(opts?.names) ? opts.names : [],
  });
});

ipcMain.handle("boss:download-resumes", async (_evt, opts = {}) => {
  log(`boss:download-resumes limit=${opts?.limit || 5} names=${(opts?.names || []).length}`);
  try {
    return await bossActions.autoDownloadResumes({
      limit: Number(opts?.limit) || 5,
      names: Array.isArray(opts?.names) ? opts.names : [],
    });
  } catch (err) {
    log(`boss:download-resumes FAILED ${err?.message || err}`);
    return {
      ok: false,
      error: String(err?.message || err),
      stack: String(err?.stack || "").slice(0, 1000),
    };
  }
});

ipcMain.handle("boss:request-and-download-resumes", async (_evt, opts = {}) => {
  log(
    `boss:request-and-download-resumes limit=${opts?.limit || 5} names=${(opts?.names || []).length}`,
  );
  return bossActions.requestAndDownloadResumes({
    limit: Number(opts?.limit) || 5,
    names: Array.isArray(opts?.names) ? opts.names : [],
  });
});

ipcMain.handle("boss:enrich-profiles", async (_evt, opts = {}) => {
  log(`boss:enrich-profiles limit=${opts?.limit || 8} names=${(opts?.names || []).length}`);
  return bossActions.enrichCandidateProfiles({
    limit: Number(opts?.limit) || 8,
    names: Array.isArray(opts?.names) ? opts.names : [],
  });
});

ipcMain.handle("boss:auto-rechat", async (_evt, opts = {}) => {
  log(`boss:auto-rechat limit=${opts?.limit || 5}`);
  return bossActions.autoRechat({
    message: opts?.message || "",
    limit: Number(opts?.limit) || 5,
    names: Array.isArray(opts?.names) ? opts.names : [],
  });
});

ipcMain.handle("boss:interview-invite", async (_evt, opts = {}) => {
  log(
    `boss:interview-invite names=${(opts?.names || []).length} mode=${opts?.mode || "online"} time=${opts?.time || ""}`,
  );
  return bossActions.sendBossInterviewInvite({
    names: Array.isArray(opts?.names) ? opts.names : [],
    mode: opts?.mode === "offline" ? "offline" : "online",
    time: String(opts?.time || ""),
    place: String(opts?.place || ""),
    draft: String(opts?.draft || opts?.message || ""),
    limit: Number(opts?.limit) || 5,
  });
});

ipcMain.handle("boss:check-inbox-replies", async (_evt, opts = {}) => {
  log(`boss:check-inbox-replies limit=${opts?.limit || 8}`);
  return bossActions.checkInboxReplies({
    limit: Number(opts?.limit) || 8,
    names: Array.isArray(opts?.names) ? opts.names : [],
  });
});

ipcMain.handle("boss:scrape-inbox", async (_evt, opts = {}) => {
  log(
    `boss:scrape-inbox limit=${opts?.limit || 15} todayOnly=${Boolean(opts?.todayOnly)} headcount=${opts?.headcount || 5}`,
  );
  return bossActions.scrapeInboxCandidates({
    limit: Number(opts?.limit) || 15,
    todayOnly: opts?.todayOnly !== false,
    jobTitle: String(opts?.jobTitle || ""),
    headcount: Number(opts?.headcount) || 5,
  });
});

/**
 * Restart must target the user-facing executable.
 * electron-builder Windows portable extracts to a temp dir; process.execPath
 * points there and vanishes on exit, so bare app.relaunch() only quits.
 * Prefer PORTABLE_EXECUTABLE_FILE and spawn a detached process, then exit.
 */
function restartDesktopApp() {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  const execPath = portableExe || process.execPath;
  const args = portableExe
    ? []
    : process.argv.slice(1).filter((a) => a !== "--relaunch");
  const cwd = process.env.PORTABLE_EXECUTABLE_DIR || process.cwd();

  log(`restart spawn execPath=${execPath} args=${JSON.stringify(args)} cwd=${cwd}`);

  const child = spawn(execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd,
    env: process.env,
  });
  child.on("error", (err) => {
    log(`restart spawn error: ${err?.message || err}`);
  });
  child.unref();

  // Let the IPC response flush, then exit the current instance.
  setTimeout(() => app.exit(0), 150);
}