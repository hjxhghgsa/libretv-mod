#!/usr/bin/env node
// LibreTV 服务管理器 —— 避免 cmd 批处理里的引号/&& 转义地狱
// 用法：node libretv-server.js start|stop|status|open

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const http = require('http');

const APP_DIR = __dirname;
const PORT = 8080;
const LOG = path.join(APP_DIR, 'server.log');
const PIDFILE = path.join(APP_DIR, '.server.pid');

/**
 * 用真实 HTTP 请求判断服务是否就绪。
 *
 * 【踩过的坑】原先用 net.createServer().listen(port) 反推端口占用，
 * 但 Windows 上 0.0.0.0:8080 被占用时，绑定 127.0.0.1:8080 仍可能成功
 * （不抛 EADDRINUSE），导致检测永远返回「空闲」→ 启动器误报 timeout，
 * 而服务其实早就起来了。HTTP 探测没有这个歧义。
 */
function probeReady(timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/status', timeout: timeoutMs },
      res => { res.resume(); resolve(res.statusCode < 500); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await probeReady()) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('timeout'));
      setTimeout(tick, 600);
    };
    tick();
  });
}

async function start() {
  if (await probeReady()) {
    console.log(`[LibreTV] 服务已在运行，直接打开`);
    return true;
  }
  const out = fs.openSync(LOG, 'a');
  console.log(`[LibreTV] 启动中，日志: ${LOG}`);
  const child = spawn(process.execPath, [
    path.join(APP_DIR, 'node_modules', 'next', 'dist', 'bin', 'next'),
    'start', '-p', String(PORT),
  ], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid), 'utf8');
  try {
    await waitReady(90000);
  } catch {
    // 超时后最后确认一次：进程可能已起但首包很慢
    if (await probeReady()) {
      console.log(`[LibreTV] 已就绪 http://localhost:${PORT}  (pid ${child.pid})`);
      return true;
    }
    console.error(`[LibreTV] 启动超时（90s）。请查看日志: ${LOG}`);
    return false;
  }
  console.log(`[LibreTV] 已就绪 http://localhost:${PORT}  (pid ${child.pid})`);
  return true;
}

function stop() {
  let stopped = false;
  try {
    const pid = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    console.log(`[LibreTV] 已停止 pid ${pid}`);
    stopped = true;
  } catch (e) {
    console.log(`[LibreTV] 无 pid 文件或进程已退出`);
  }
  try { fs.unlinkSync(PIDFILE); } catch (e) {}
  return stopped;
}

async function status() {
  const up = await probeReady();
  console.log(up ? `[LibreTV] 运行中 → http://localhost:${PORT}` : `[LibreTV] 未运行`);
  return up;
}

function openBrowser() {
  const url = `http://localhost:${PORT}`;
  if (process.platform === 'win32') {
    // 用 explorer.exe 而不是 cmd /c start：后者在部分环境会被安全策略拦
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
  console.log(`[LibreTV] 浏览器已打开: ${url}`);
}

async function main() {
  const cmd = process.argv[2] || 'start';
  if (cmd === 'start') {
    const ok = await start();
    if (ok) openBrowser();
    else {
      console.error('[LibreTV] 没能启动服务。可尝试在浏览器打开 http://localhost:8080');
    }
    process.exit(ok ? 0 : 1);
  } else if (cmd === 'stop') stop();
  else if (cmd === 'status') process.exit((await status()) ? 0 : 1);
  else if (cmd === 'open') { const ok = await start(); if (ok) openBrowser(); process.exit(ok ? 0 : 1); }
  else {
    console.log('用法: node libretv-server.js start|stop|status|open');
    process.exit(2);
  }
}

main().catch(e => { console.error('[LibreTV]', e.message); process.exit(1); });