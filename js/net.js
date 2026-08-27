/* ============================================================
 * net.js —— 联机客户端模块
 * 连接 ws 服务器，收发 JSON 消息；事件式回调
 * 用法：
 *   const net = new NetClient();
 *   net.on('welcome', d => ...); net.on('close', () => ...);
 *   net.connect();        // 默认连到当前页面来源（本地）或 js/config.js 配置的远程地址
 *   net.send({t:'aim', angle});
 *
 * 地址解析优先级：
 *   1. connect(url) 显式传入
 *   2. ?ws= URL 参数
 *   3. window.BILLIARDS_WS_URL（js/config.js）
 *   4. localhost 同源 ws(s)://host（本地开发）
 *   其它（线上域名未配置）→ 返回 null，发出 'error' 提示需要配置
 *
 * 首次连不上（如免费实例冷启动中）会自动指数退避重试，
 * 每次重试发出 'reconnect' 事件，供大厅显示"唤醒中"。
 * ============================================================ */
(function () {
  'use strict';

  class NetClient {
    constructor() {
      this.ws = null;
      this.handlers = {};
      this.connected = false;
      this.url = '';
      this._attempt = 0;
      this._stopped = true;
      this._timer = null;
    }

    on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }

    emit(type, data) { (this.handlers[type] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[net] handler err', e); } }); }

    /** 解析要连接的 WebSocket 地址；不可用返回 null */
    resolveUrl(explicit) {
      if (explicit) return explicit;
      try {
        const p = new URLSearchParams(location.search).get('ws');
        if (p) return p;
      } catch (e) {}
      if (window.BILLIARDS_WS_URL) return window.BILLIARDS_WS_URL;
      if (location.protocol === 'file:') return null;
      const host = location.hostname;
      // 本地开发：用页面同源地址连本地 server.js
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
      }
      // 线上域名但未配置远程 WS：静态托管跑不了 server.js，交给上层提示
      return null;
    }

    /** 连接：解析地址并打开 WebSocket；地址不可用时返回 false */
    connect(url) {
      if (this.ws && this.ws.readyState <= 1) return true;
      if (typeof WebSocket === 'undefined') { this.emit('error', '浏览器不支持 WebSocket'); return false; }
      const base = this.resolveUrl(url);
      if (!base) {
        this.emit('error', '联机对战需要匹配服务器。请把 server.js 部署到 Render 等常驻主机，并在 js/config.js 填写其 wss:// 地址（或用 ?ws= 参数传入）。');
        return false;
      }
      this.url = base;
      this._stopped = false;
      this._attempt = 0;
      this._openSocket();
      return true;
    }

    _openSocket() {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this._scheduleRetry();
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this._attempt = 0;
        this.emit('open');
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.t) {
          window.__lastMsg = m.t;                    // 诊断探针
          window.__msgN = (window.__msgN || 0) + 1;
          this.emit(m.t, m);
        }
      };
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        this.ws = null;
        if (was) {
          // 对局中断开：交给上层处理（回大厅/重置房间），不再自动重连
          this.emit('close', { wasConnected: true });
        } else if (!this._stopped) {
          // 从未成功连上：多半是免费实例冷启动中，指数退避重试
          this._scheduleRetry();
        }
      };
      ws.onerror = () => { /* onclose 会随后触发 */ };
    }

    _scheduleRetry() {
      if (this._stopped) return;
      this._attempt += 1;
      const delay = Math.min(1000 * Math.pow(1.7, this._attempt - 1), 12000);
      this.emit('reconnect', { attempt: this._attempt, delay });
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { if (!this._stopped) this._openSocket(); }, delay);
    }

    send(obj) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    }

    close() {
      this._stopped = true;
      clearTimeout(this._timer);
      if (this.ws) { try { this.ws.close(); } catch (e) {} }
      this.ws = null;
      // 先发 close 事件供上层复位 UI（大厅/对局退出），再清连接状态：
      // 不能在 ws.close() 前清 connected，否则 onclose 里 was=false 永远不派发事件
      this.emit('close', { wasConnected: this.connected });
      this.connected = false;
    }
  }

  window.NetClient = NetClient;
})();
