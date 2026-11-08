// Build a portable one-click package: release/HomeDashboard/ (+ zip).
// Self-contained: bundles the server into server.mjs (esbuild), copies web/dist,
// config (INCLUDING your personal dashboard.json), data caches, and node.exe.
// Usage: npm run release
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release', 'HomeDashboard');
const zip = process.argv.includes('--nozip') ? false : true;

const log = (m) => console.log(`[release] ${m}`);

// 1. clean + skeleton
fs.rmSync(path.join(ROOT, 'release'), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 2. bundle server with esbuild (from local node_modules)
const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'server/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: path.join(OUT, 'server.mjs'),
  banner: { js: "import { createRequire as _cr } from 'node:module'; const require = _cr(import.meta.url);" },
  logLevel: 'warning',
});
log('bundled server.mjs');

// 3. copy payload
const copy = (rel, { required = false } = {}) => {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    if (required) throw new Error(`missing required: ${rel}`);
    return;
  }
  fs.cpSync(src, path.join(OUT, rel), { recursive: true });
  log(`copied ${rel}`);
};
copy('web/dist', { required: true });
copy('config/dashboard.example.json', { required: true });
copy('config/dashboard.json', { required: true });
copy('config/events.json');
// data caches: ship fed/weather/geo JSON only — NEVER the wallpaper cache
// (data/backgrounds is regenerable; it alone adds tens of MB to the zip).
if (fs.existsSync(path.join(ROOT, 'data'))) {
  for (const e of fs.readdirSync(path.join(ROOT, 'data'), { withFileTypes: true })) {
    if (e.name === 'backgrounds') continue;
    fs.cpSync(path.join(ROOT, 'data', e.name), path.join(OUT, 'data', e.name), { recursive: true });
  }
  log('copied data/ excluding backgrounds/');
}
copy('LICENSE');
copy('README.md');
copy('server/data', { required: true });

// 4. portable runtime (node.exe of this machine; target must be Windows x64)
const nodeExe = execSync('where node', { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
fs.mkdirSync(path.join(OUT, 'runtime'), { recursive: true });
fs.copyFileSync(nodeExe, path.join(OUT, 'runtime', 'node.exe'));
log(`copied runtime/node.exe from ${nodeExe}`);

// 5. launcher batch files (ASCII names; UTF-8 + chcp 65001).
//    CRLF line endings and goto-style flow are REQUIRED: cmd.exe misparses
//    multi-line ( ) blocks in LF-only files, splitting commands mid-line.
const runLine = `if exist "%~dp0runtime\\node.exe" (set "NODE=%~dp0runtime\\node.exe") else (set "NODE=node")
set "HD_ROOT=%~dp0"`;
const writeBat = (name, body) => fs.writeFileSync(path.join(OUT, name), body.replaceAll('\n', '\r\n'), 'utf8');

writeBat('start.bat', `@echo off
chcp 65001 >nul
cd /d "%~dp0"
${runLine}
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8787"
"%NODE%" server.mjs
`);

writeBat('start-server.bat', `@echo off
chcp 65001 >nul
cd /d "%~dp0"
${runLine}
"%NODE%" server.mjs
`);

writeBat('start-kiosk.bat', `@echo off
chcp 65001 >nul
cd /d "%~dp0"
${runLine}
start "HomeDashboard Server" /min "%NODE%" server.mjs
timeout /t 3 /nobreak >nul
set "BROWSER="
if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"
if defined BROWSER goto :kiosk
start "" http://localhost:8787
exit /b 0
:kiosk
start "" "%BROWSER%" --kiosk --new-window --no-first-run http://localhost:8787
`);

writeBat('allow-firewall.bat', `@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 goto :needadmin
netsh advfirewall firewall add rule name="HomeDashboard TCP 8787" dir=in action=allow protocol=TCP localport=8787
echo Firewall rule added. LAN devices can now open http://THIS-PC:8787
echo 防火墙规则已添加:局域网内其他设备现在可以访问 http://本机IP:8787
pause
exit /b 0
:needadmin
echo Need admin rights. Right-click this file and choose "Run as administrator".
echo 需要管理员权限:右键本文件,选择"以管理员身份运行"。
pause
exit /b 1
`);

fs.writeFileSync(
  path.join(OUT, 'README.txt'),
  `HomeDashboard 一键便携包(Windows x64,免安装 Node)

【本机使用】
  双击 start.bat         启动服务并自动打开浏览器(按 F11 全屏)
  双击 start-server.bat  只启动服务端,不自动打开浏览器(供局域网其他设备访问)
  双击 start-kiosk.bat   启动服务并用 Edge/Chrome 直接进入全屏 kiosk 模式
  关闭黑色命令行窗口即停止服务。

【局域网其他设备访问】
  1. 在本机右键"以管理员身份运行" allow-firewall.bat(只需一次)
  2. 启动后命令行窗口会打印本机局域网地址,例如 http://192.168.1.20:8787
     (也可在命令行输入 ipconfig 查看 IPv4 地址)
  3. 其他设备浏览器直接打开该地址即可。

【修改配置】
  编辑 config\\dashboard.json(城市、自选股、背景等),保存后刷新页面即生效。
  改完记得保持文件为 UTF-8 编码。

【开机自启(可选)】
  Win+R 输入 shell:startup 打开启动文件夹,把 start-kiosk.bat 的快捷方式放进去。

【注意】
  - 本包内含你的个人配置(config\\dashboard.json、data 缓存),仅在自己设备间拷贝,
    不要上传到 GitHub/网盘等公共位置。
  - 杀毒软件若拦截 runtime\\node.exe,选择允许即可(官方 node 单文件)。
  - 目标电脑需要 Windows 10/11 x64;若是 32 位或 ARM 设备,需在该机上安装 Node 后
    删除 runtime 文件夹(脚本会自动回退到系统 node)。
`,
  'utf8'
);
log('wrote start.bat / start-server.bat / start-kiosk.bat / allow-firewall.bat / README.txt');

// 6. size + zip via bsdtar (built into Windows 10+)
const du = (d) => {
  let s = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    s += e.isDirectory() ? du(f) : fs.statSync(f).size;
  }
  return s;
};
log(`package size: ${(du(OUT) / 1048576).toFixed(1)} MB`);

if (zip) {
  const zipPath = path.join(ROOT, 'release', 'HomeDashboard-portable.zip');
  execSync(`tar -a -c -f "${zipPath}" -C "${path.join(ROOT, 'release')}" HomeDashboard`, { stdio: 'inherit' });
  log(`zipped: ${zipPath} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);
}
log('done');
