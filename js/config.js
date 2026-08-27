/* ============================================================
 * config.js —— 联机对战匹配服务器地址
 *
 * 静态站点（如 Netlify）本身无法运行 WebSocket 服务器，需要把
 * server.js 部署到一台常驻 Node 主机（推荐 Render 免费档）。
 *
 * 部署好 Render 服务后，把下面这行的注释去掉，填上你的 wss 地址，
 * 例如：window.BILLIARDS_WS_URL = 'wss://billiards-ws-xxxx.onrender.com';
 *
 * 留空时：
 *   - 本地（localhost / 127.0.0.1）→ 自动用页面同源地址，连本地 server.js
 *   - 线上域名但未配置 → 联机按钮会提示需要配置服务器（不会无限重试）
 *
 * 也可临时用 URL 参数覆盖：https://你的站点/?ws=wss://...
 * ============================================================ */
window.BILLIARDS_WS_URL = ''; // ← 部署 Render 后在这里填 wss:// 地址
