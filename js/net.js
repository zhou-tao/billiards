/* ============================================================
 * net.js —— 联机客户端模块
 * 连接 ws 服务器，收发 JSON 消息；事件式回调
 * 用法：
 *   const net = new NetClient();
 *   net.on('welcome', d => ...); net.on('close', () => ...);
 *   net.connect();        // 默认连到当前页面来源
 *   net.send({t:'aim', angle});
 * ============================================================ */
(function () {
  'use strict';

  class NetClient {
    constructor() {
      this.ws = null;
      this.handlers = {};
      this.connected = false;
      this.url = '';
    }

    on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }

    emit(type, data) { (this.handlers[type] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[net] handler err', e); } }); }

    /** 连接：默认 ws(s)://当前页面host；file:// 打开时返回 false */
    connect(url) {
      if (this.ws && this.ws.readyState <= 1) return true;
      if (typeof WebSocket === 'undefined') { this.emit('error', '浏览器不支持 WebSocket'); return false; }
      let base;
      if (url) base = url;
      else if (location.protocol === 'file:') { this.emit('error', '联机需通过服务器访问页面（node server.js）'); return false; }
      else base = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
      this.url = base;
      try {
        this.ws = new WebSocket(base);
      } catch (e) {
        this.emit('error', '连接失败');
        return false;
      }
      this.ws.onopen = () => { this.connected = true; this.emit('open'); };
      this.ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.t) {
          window.__lastMsg = m.t;                    // 诊断探针
          window.__msgN = (window.__msgN || 0) + 1;
          this.emit(m.t, m);
        }
      };
      this.ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        this.ws = null;
        this.emit('close', { wasConnected: was });
      };
      this.ws.onerror = () => { /* onclose 会随后触发 */ };
      return true;
    }

    send(obj) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    }

    close() {
      if (this.ws) { try { this.ws.close(); } catch (e) {} }
      this.ws = null;
      this.connected = false;
    }
  }

  window.NetClient = NetClient;
})();

