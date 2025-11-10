const { WebSocket } = require('ws');
const tls = require('tls');
const { Buffer } = require('buffer');
const config = require('./config.json');
process.env.UV_THREADPOOL_SIZE = '128';
require('events').EventEmitter.defaultMaxListeners = 0;
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));
process.on('unhandledRejection', (err) => console.error('[REJECTION]', err));
const DISCORD_HOST = 'discord.com';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=9&encoding=json';
const API_ENDPOINT = `/api/v9/guilds/${config.guildId}/vanity-url`;
const CRLF = '\r\n';
const HOST_HEADER = `Host: ${DISCORD_HOST}${CRLF}`;
const CONN_HEADER = 'Connection: keep-alive' + CRLF;
const CT_HEADER = 'Content-Type: application/json' + CRLF;
const AUTH_HEADER = `Authorization: ${config.token}${CRLF}`;
const MFA_HEADER = config.mfaToken ? `X-MFA-Authorization: ${config.mfaToken}${CRLF}` : '';
const PATCH_HEADER_PREFIX = Buffer.from(
  `PATCH ${API_ENDPOINT} HTTP/1.1${CRLF}` +
  HOST_HEADER +
  CONN_HEADER +
  AUTH_HEADER +
  MFA_HEADER +
  CT_HEADER
);
class TLSPool {
  constructor(size = 1) {
    this.size = size;
    this.pool = [];
    this.waiting = [];
    this.createInitial();
  }
  createInitial() {
    for (let i = 0; i < this.size; i++) {
      this.createSocket().then(s => this.pool.push(s));
    }
  }
  createSocket() {
    return new Promise((resolve) => {
      const socket = tls.connect({
        host: DISCORD_HOST,
        port: 443,
        ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        secureProtocol: 'TLSv1_3_method',
        servername: DISCORD_HOST,
        secure: true,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      }, () => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 1000);
        resolve(socket);
      });
      socket.on('error', () => this.replaceSocket(socket));
      socket.on('close', () => this.replaceSocket(socket));
    });
  }
  replaceSocket(old) {
    const idx = this.pool.indexOf(old);
    if (idx !== -1) this.pool.splice(idx, 1);
    this.createSocket().then(newS => {
      this.pool.push(newS);
      this.drain();
    });
  }
  acquire() {
    return new Promise(r => this.pool.length > 0 ? r(this.pool.shift()) : this.waiting.push(r));
  }
  release(socket) {
    this.waiting.length > 0 ? this.waiting.shift()(socket) : this.pool.push(socket);
  }
  drain() {
    while (this.waiting.length > 0 && this.pool.length > 0) {
      this.waiting.shift()(this.pool.shift());
    }
  }
}
class VanitySniper {
  constructor() {
    this.sequence = null;
    this.sessionId = null;
    this.ws = null;
    this.tlsPool = new TLSPool(1);
    this.heartbeatInterval = null;
    this.reconnecting = false;
  }
  async connect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.ws = new WebSocket(GATEWAY_URL, {
        headers: { Authorization: config.token },
        perMessageDeflate: false,
        handshakeTimeout: 10000,
      });

      this.ws.on('open', () => this.onOpen());
      this.ws.on('message', data => this.onMessage(data));
      this.ws.on('close', () => {
        this.cleanup();
        setTimeout(() => this.connect(), 2000 + Math.random() * 3000);
      });
      this.ws.on('error', () => {});
    } catch {
      setTimeout(() => this.connect(), 5000);
    }
  }
  cleanup() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    this.sequence = null;
    this.reconnecting = false;
  }
  send(op, d = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ op, d })); } catch {}
    }
  }
  onOpen() {
    this.send(2, {
      token: config.token,
      properties: { os: 'linux', browser: 'mcquen', device: 'woet' },
      compress: false,
      presence: { status: 'online', since: 0, afk: false, activities: [] }
    });
  }
  async claimVanity(code) {
    const socket = await this.tlsPool.acquire();
    const payload = Buffer.from(JSON.stringify({ code }));
    const contentLength = `Content-Length: ${payload.length}${CRLF}${CRLF}`;
    const request = Buffer.concat([
      PATCH_HEADER_PREFIX,
      Buffer.from(contentLength),
      payload
    ]);
    return new Promise((resolve) => {
      let responded = false;
      const onData = (data) => {
        if (responded) return;
        const str = data.toString();
        if (!str.includes('HTTP/1.1')) return;
        responded = true;
        socket.removeListener('data', onData);
        const status = str.match(/HTTP\/1\.1 (\d+)/)?.[1];
        if (status === '200') {
          console.log(`\x1b[32mClaimed discord.gg/${code}\x1b[0m`);
        } else {
          console.log(`\x1b[31mFail dog ${status} → ${code}\x1b[0m`);
        }
        this.tlsPool.release(socket);
        resolve();
      };
      socket.on('data', onData);
      socket.on('error', () => {
        if (!responded) { responded = true; this.tlsPool.replaceSocket(socket); resolve(); }
      });
      try {
        socket.write(request);
      } catch {
        if (!responded) { responded = true; this.tlsPool.replaceSocket(socket); resolve(); }
      }
      setTimeout(() => {
        if (!responded) {
          responded = true;
          socket.removeListener('data', onData);
          this.tlsPool.release(socket);
          resolve();
        }
      }, 5000);
    });
  }
  async onMessage(rawData) {
    let data;
    try { data = JSON.parse(rawData); } catch { return; }
    const { t, s, op, d } = data;
    if (s != null) this.sequence = s;
    switch (op) {
      case 10: 
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => this.send(1, this.sequence), d.heartbeat_interval);
        break;
      case 0: 
        if (t === 'READY') {
          this.sessionId = d.session_id;
          console.log(`\x1b[32m[READY] ${this.sessionId}\x1b[0m`);
          if (config.mfaToken) console.log('\x1b[33m[MFA] 2FA aktif, X-MFA-Authorization kullanılıyor.\x1b[0m');
        } else if (t === 'GUILD_UPDATE' && d.guild_id === config.guildId) {
          if (d.vanity_url_code && d.vanity_url_code !== config.currentVanity) {
            this.claimVanity(d.vanity_url_code);
          }
        }
        break;
    }
  }
  start() {
    console.log('\x1b[36m[SNIPER] Starting... (MFA: ' + (config.mfaToken ? 'Active' : 'passive') + ')\x1b[0m');
    this.connect();
  }
}
const sniper = new VanitySniper();
sniper.start();
process.on('SIGINT', () => {
  sniper.ws?.close();
  process.exit(0);
});
