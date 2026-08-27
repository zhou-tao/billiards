/* ============================================================
 * config.js —— 联机对战匹配服务器地址
 *
 * 静态站点无法运行 WebSocket，联机服务器单独部署在 Render：
 *   https://billiards-r95i.onrender.com（免费档，空闲 15 分钟休眠，
 *   首次连接约需 1 分钟冷启动，客户端会自动重试并提示「唤醒中」）
 *
 * 本地开发想连本地服务器时，用 URL 参数临时覆盖：
 *   http://localhost:8250/?ws=ws://localhost:8250
 * ============================================================ */
window.BILLIARDS_WS_URL = 'wss://billiards-r95i.onrender.com';
