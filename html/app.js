/* 剪贴板网页端：手机 ↔ 电脑
 *
 * 界面：整页一个大框 —— 顶部毛玻璃标题栏（点标题=刷新）、中间历史记录流（聊天气泡，长按可选中）、
 *       底部三块独立玻璃（＋圆珠 / 输入框 / ↑发送）。
 *
 * 刷新（2026-09-20 按用户要求加的）：**打开 / 切回这个页面立刻多刷一次** ——
 *       打开它多半就是为了拿电脑刚复制的东西，不该再干等最多 5 秒的那次轮询。
 *       ⚠️ **轮询照旧开着**（默认 5 秒，设置里能改）：别把这条"多刷一次"读成"改成不轮询"，
 *          原作者就是这么误读用户的话、当天被否掉的（见下面常量区那段迁移的注释）。
 *
 * 原理：本页由 NAS 上的 nginx 提供，同一端口把 /SyncClipboard.json、/file/、/api/
 * 转发给 SyncClipboard 服务(127.0.0.1:5033)，所以网页和接口同源，不涉及跨域。
 *
 * 服务端约定（v3.2.0 实测）：
 *   读当前剪贴板  GET  /SyncClipboard.json
 *   写当前剪贴板  PUT  /SyncClipboard.json
 *   传文件字节    PUT  /file/{文件名}     ← Content-Type 必须是 octet-stream / text/plain
 *                                           用 multipart 或 form-urlencoded 会被服务端吞掉 body 存成 0 字节
 *   历史查询      POST /api/history/query (multipart 表单，每页 50 条，新的在前；可带 starred=true 只看收藏)
 *   历史数据      GET  /api/history/{类型}-{hash}/data
 *   收藏/取消收藏  PATCH /api/history/{类型}/{hash}  body {"starred":true}
 *                 服务端清理历史的条件是 !Stared && !Pinned，所以**收藏的条目不会被清理，不会过期**
 *   hash 规则：文字 → sha256(UTF-8 文字)；图片/文件 → sha256(文件名 + "|" + 内容 sha256)
 */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const K_USER = 'sc_user', K_PASS = 'sc_pass', K_INT = 'sc_interval', K_COMPRESS = 'sc_compress';
const K_SENT = 'sc_sent';         // 本机（手机网页）发出去过哪些 hash
const TYPE_CN = { Text: '文字', Image: '图片', File: '文件', Group: '多文件' };
const COMPRESS_OVER = 700 * 1024;
const MAX_DIM = 2200;
const PAGE_SIZE = 50;
const HOLD_MS = 450;              // 长按多久算"长按"
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"' +
  ' stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5' +
  ' 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/></svg>';
const STAR_FILLED = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2"' +
  ' stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>';
const STAR_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"' +
  ' stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>';

/* ---- 撤销"默认关轮询"那次迁移（2026-09-20 当天改回来的）----
   ⚠️ 踩过的坑，别再犯：我一度把用户那句"操作完你不要检测，我来检测"读成"网页不要再轮询"，
      于是把间隔的默认值从 5 秒改成 0（不轮询），还加了个 sc_mig1 迁移把老设备一起改成 0。
      **用户当场否掉了** —— 那句话是说"**你（Claude）改完不要自己去检测，我来测**"，轮询他一直是要的。
   所以这里把那次迁移**倒回去**：跑过 sc_mig1 的设备，间隔被改成 0 的恢复成 5 秒（旧默认）。
   只认"sc_mig1 存在 + 间隔正好是 0"这一个组合（那正是我那次改出来的），其它值一律不动。 */
(() => {
  try {
    if (!localStorage.getItem('sc_mig1')) return;
    if (localStorage.getItem(K_INT) === '0') localStorage.setItem(K_INT, '5');
    localStorage.removeItem('sc_mig1');
  } catch (e) { /* localStorage 被禁（比如无痕）就算了 —— 别让这一句把整个脚本带走 */ }
})();

/* ==================== 凭据 & 请求 ==================== */

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function authHeader() {
  const u = localStorage.getItem(K_USER);
  if (!u) return null;
  return 'Basic ' + b64utf8(u + ':' + (localStorage.getItem(K_PASS) || ''));
}

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const a = authHeader();
  if (a) headers.set('Authorization', a);
  const res = await fetch(path, Object.assign({}, opts, { headers, cache: 'no-store' }));
  if (res.status === 401) {
    const e = new Error('账号或密码不对（点右上角 ⚙︎ 修改）');
    e.status = 401;   // 标记：这是密码问题，不是连不上，别弹转圈
    throw e;
  }
  return res;
}

async function httpErr(res) {
  let t = '';
  try { t = (await res.text()).slice(0, 160); } catch (e) { /* ignore */ }
  const err = new Error('HTTP ' + res.status + (t ? '：' + t : ''));
  err.status = res.status;
  return err;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  if (!res.ok) throw await httpErr(res);
  return res.json();
}

/* ==================== SHA-256 ==================== */

const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);

/** 纯 JS 版 SHA-256（HTTP 非安全上下文下 crypto.subtle 不可用时兜底） */
function sha256Js(bytes) {
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
      h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const len = bytes.length;
  const withPad = len + 1;
  const total = withPad + (((56 - withPad % 64) + 64) % 64) + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 536870912));
  dv.setUint32(total - 4, (len << 3) >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i-15], b = w[i-2];
      const s0 = rotr(a,7) ^ rotr(a,18) ^ (a >>> 3);
      const s1 = rotr(b,17) ^ rotr(b,19) ^ (b >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d + t1) >>> 0; d=c; c=b; b=a; a=(t1 + t2) >>> 0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map(x => x.toString(16).padStart(8,'0')).join('').toUpperCase();
}

async function sha256(bytes) {
  if (window.crypto && crypto.subtle) {
    try {
      const d = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
    } catch (e) { /* 回退 */ }
  }
  return sha256Js(bytes);
}

const sha256Text = (str) => sha256(new TextEncoder().encode(str));
const profileHash = (fileName, contentHash) => sha256Text(fileName + '|' + contentHash.toUpperCase());

/* ==================== 工具 ==================== */

function sanitizeName(name, fallbackExt) {
  let n = (name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '');
  if (n.length > 100) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 ? n.slice(dot) : '';
    n = n.slice(0, 100 - ext.length) + ext;
  }
  if (!n) n = 'clip_' + Date.now() + (fallbackExt || '.bin');
  return n;
}

function timeTag() {
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + '_' +
         p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
}

const fmtSize = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(1) + ' MB';
};

/* 文件气泡右侧那个图标块用（微信参考图上是各家软件的彩色 logo）：
   我们拿不到那些 logo，就用"配色块 + 扩展名"代替 —— 位置、形状、大小跟参考图一致。
   ⚠️ 没扩展名/认不出来的显示 "?" 灰块（微信也是这样）。 */
const BADGE_COLOR = {
  pdf: 'c-pdf',
  doc: 'c-doc', docx: 'c-doc', rtf: 'c-doc', odt: 'c-doc', pages: 'c-doc',
  xls: 'c-xls', xlsx: 'c-xls', csv: 'c-xls', numbers: 'c-xls',
  ppt: 'c-ppt', pptx: 'c-ppt', key: 'c-ppt',
  zip: 'c-zip', rar: 'c-zip', '7z': 'c-zip', tar: 'c-zip', gz: 'c-zip',
  txt: 'c-txt', md: 'c-txt', log: 'c-txt',
  ics: 'c-cal'
};
function fileExt(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
function extBadgeClass(name) { return BADGE_COLOR[fileExt(name)] || ''; }
function extBadgeText(name) {
  const e = fileExt(name);
  return e ? e.slice(0, 4).toUpperCase() : '?';
}

function fmtStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (x) => String(x).padStart(2,'0');
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
                  && d.getDate() === now.getDate();
  return sameDay ? hm : (d.getMonth()+1) + '/' + d.getDate() + ' ' + hm;
}

function setMsg(el, text, cls) {
  el.textContent = text || '';
  el.style.color = cls === 'ok' ? 'var(--ok)' : (cls === 'err' ? 'var(--err)' : '');
}

/** 浮动提示。sticky=true 时不自动消失（上传进度用） */
let toastTimer = null;
function toast(text, cls, sticky) {
  clearTimeout(toastTimer);

  // 有弹窗打开时，提示必须放进弹窗内部 —— 弹窗在浏览器的 top layer，
  // 外面的元素 z-index 再高也盖不过它（这就是"已收藏/已复制看不见"的原因）
  const dlg = document.querySelector('dialog[open]');
  if (dlg) {
    let box = dlg.querySelector('.dtoast');
    if (!box) {
      box = document.createElement('div');
      box.className = 'dtoast';
      box.innerHTML = '<span></span>';
      dlg.appendChild(box);
    }
    box.querySelector('span').textContent = text || '';
    box.classList.toggle('err', cls === 'err');
    box.classList.add('show');
    if (!sticky) toastTimer = setTimeout(() => box.classList.remove('show'), 1800);
    return;
  }

  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text || '';
  el.className = cls || '';
  el.style.opacity = '1';
  el.style.transform = 'translate(-50%, 0)';
  if (!sticky) {
    toastTimer = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%, 12px)';
    }, 1900);
  }
}

let spinnerEl = null;
function showSpinner(on, text) {
  if (!on) {
    if (spinnerEl) spinnerEl.style.display = 'none';
    return;
  }
  if (!spinnerEl) {
    spinnerEl = document.createElement('div');
    spinnerEl.id = 'spinner';
    spinnerEl.innerHTML = '<div class="box"><div class="ring"></div><div class="txt"></div></div>';
    document.body.appendChild(spinnerEl);
  }
  spinnerEl.querySelector('.txt').textContent = text || '连不上服务器，正在重试…';
  spinnerEl.style.display = '';
}

function compressImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        let { width: w, height: h } = img;
        const scale = Math.min(1, MAX_DIM / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.toBlob((blob) => {
          URL.revokeObjectURL(url);
          resolve(blob && blob.size < file.size ? blob : null);
        }, 'image/jpeg', 0.85);
      } catch (e) {
        URL.revokeObjectURL(url);
        resolve(null);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

const compressOn = () => localStorage.getItem(K_COMPRESS) !== '0';

/* ==================== 版面尺寸 ==================== */

function bumpMetrics() {
  const app = $('app');
  app.style.setProperty('--headH', $('topbar').offsetHeight + 'px');
  app.style.setProperty('--compH', $('composer').offsetHeight + 'px');
}

/** iOS 键盘是浮层，不改变布局视口高度 —— 把 app 贴到"可视视口"上，输入栏才不会被键盘盖住 */
function setupViewport() {
  const app = $('app');
  if (!window.visualViewport) return;
  const vv = window.visualViewport;

  /* 键盘在不在，iOS 没接口直接问，只能看"可视高度缩了多少"。
     基准高度 restH 只在**没在输入框里打字**的时候更新 —— 键盘动画期间 activeElement 已经是
     输入框了，基准不会被自己带偏；而旋转屏幕这类真实的高度变化照样能跟上。
     键盘弹起时给 <html> 挂 .kb，把 --sab 清零：
     那 34px 是给 Home 指示条留的，键盘顶上来时指示条已经没了，
     不清零输入栏就会浮在键盘上方 34px 处 —— 也就是"输入框和键盘之间空一条"。
     （Safari 里没这条空隙，因为 Safari 的 --sab 本来就是 0，所以这个改动只影响独立窗口） */
  let restH = vv.height;
  const syncKbClass = () => {
    const ae = document.activeElement;
    const typing = !!ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT');
    // 没在打字时无条件接受当前高度（旋转屏幕就靠这条）；
    // 打字期间只往上取最大值 —— 否则"收起又立刻点回来"会把键盘动画中间的高度当成满屏高度，
    // 之后键盘真弹起来时反而比基准矮不了 80px，判定就失灵了
    if (!typing || vv.height > restH) restH = vv.height;
    const open = typing && vv.height < restH - 80;   // 80 是余量，避开地址栏收缩那种一二十像素的抖动
    const el = document.documentElement;
    if (el.classList.contains('kb') !== open) {
      el.classList.toggle('kb', open);
      bumpMetrics();            // 安全区变了 → 输入栏位置 + 消息流底部留白都要重算
    }
  };

  const sync = () => {
    app.style.top = vv.offsetTop + 'px';
    app.style.height = vv.height + 'px';
    app.style.bottom = 'auto';
    syncKbClass();
  };
  const onResize = () => {
    sync();
    // 键盘弹起/收起、可视区变化 → 只要本来就该贴着底部，就再贴一次。
    // ⚠️ 原来是"只有焦点还在输入框里才贴"。但用键盘右下角那个**收起箭头**关键盘时输入框会失焦，
    //    那条路就不贴了 —— 而键盘收起会让 --sab 从 0 变回 34px（Home 指示条那条又占位），
    //    消息流底部留白随之多出 34px → 页面就停在那 34px 之外，
    //    看着就是"没滑到最底、最后一条气泡和输入栏有点重合，还能再往下滑一点点"。
    const ae = document.activeElement;
    if (stickBottom || (ae && ae.id === 'sendText')) setTimeout(pinBottom, 60);
  };
  window.visualViewport.addEventListener('resize', onResize);
  window.visualViewport.addEventListener('scroll', sync);   // 只跟着走，不重新定位
  // 兜底：个别情况下收起键盘不一定伴随 resize（比如外接键盘），失焦时自己看一眼
  document.addEventListener('focusout', () => setTimeout(() => {
    sync();
    if (stickBottom) pinBottom();     // 收键盘（输入框失焦）也要贴底，原因同上
  }, 60));
  sync();
}

/* ==================== "这条是我在手机上发的" ====================
   服务端 history 记录只有 hash/text/type/时间/starred/pinned/size 这些字段，
   **没有"来源设备"** —— 所以从数据里分不出哪条是手机发的、哪条是电脑发的。
   能确定知道来源的只有一处：这个网页自己发出去的时候（doSend 成功那一下）。
   于是发成功就把 hash 记进 localStorage，渲染时对得上就当"我发的"（绿色、靠右）。
   ⚠️ 代价：只对**这个网页发出去的**有效，历史里更早的消息认不出来（当时没记）；
      清掉网站数据（设置→Safari→高级→网站数据）记录也会没，那些气泡会退回灰色。 */

const SENT_MAX = 800;             // 只留最近 800 条，别让 localStorage 无限长
let sentSet = new Set();
try {
  const raw = JSON.parse(localStorage.getItem(K_SENT) || '[]');
  if (Array.isArray(raw)) sentSet = new Set(raw.filter(h => typeof h === 'string'));
} catch (e) { /* 存的东西坏了就当空的，不影响用 */ }

const isMine = (hash) => sentSet.has(hash);

function markSent(hash) {
  if (!hash || sentSet.has(hash)) return;
  sentSet.add(hash);
  let arr = Array.from(sentSet);
  if (arr.length > SENT_MAX) {                 // Set 保持插入顺序，砍掉最老的
    sentSet = new Set(arr.slice(arr.length - SENT_MAX));
    arr = Array.from(sentSet);
  }
  try { localStorage.setItem(K_SENT, JSON.stringify(arr)); } catch (e) { /* 存不下就算了 */ }
}

/* ==================== 消息流 ==================== */

let streamItems = [];     // 服务端顺序：新 → 旧
let streamPage = 0;
let currentHash = '';
let loadingOlder = false;
let firstLoadDone = false;

function dataUrl(type, hash) {
  return '/api/history/' + encodeURIComponent(type + '-' + hash) + '/data';
}

async function fetchBlob(type, hash) {
  const res = await api(dataUrl(type, hash));
  if (!res.ok) throw await httpErr(res);
  return res.blob();
}

/* ---- 图片缓存（2026-09-20 为了治"卡顿/快闪"加的） ----
   轮询和发消息都会走 renderStream() 整屏重建，图片元素是**全新**的：
   没有缓存就得重新下载一遍（一张就近 1MB），看着就是"图一块块跳出来 + 页面卡"。
   这里把 blob URL 和尺寸缓存住，重建时直接复用，不再重新下载；
   尺寸用来在重建时先用 aspect-ratio 把位置占住，图没解码完高度也不会塌成 0（不跳）。
   ⚠️ 只影响**显示**；"保存图片"走 downloadItem()，取的是服务端上的原图。

   ⚠️ 试过"顺手把 3000+ 像素的大图用 canvas 缩一遍再显示"，**撤掉了**：
   canvas.toBlob 是异步的，实测在某些环境下会一直不返回（图片就永远不显示了），
   而且每张图多一次解码+编码、首屏反而更慢。图片本来在上传时就已经压到 2200px 了，
   收益不值这个风险 —— 别再往这条路上走。 */
const IMG_CACHE_MAX = 40;
const imgCache = new Map();             // hash → { url, w, h }

function cacheImage(hash, url, w, h) {
  imgCache.set(hash, { url: url, w: w, h: h });
  // 超了从最老的开始挤；只有页面上没有任何 img 还在用它的时候才真回收，否则那张图会变空白
  while (imgCache.size > IMG_CACHE_MAX) {
    const oldest = imgCache.entries().next().value;
    imgCache.delete(oldest[0]);
    if (!document.querySelector('img[src="' + oldest[1].url + '"]')) URL.revokeObjectURL(oldest[1].url);
  }
}

/** 图片懒加载：滚进视口才去拉（已经缓存过的直接出，不用等） */
function lazyImage(container, hash, onDone) {
  const img = document.createElement('img');
  img.alt = '';
  // ⚠️ 别加 img.decoding='async'：那等于允许浏览器"先把框画出来、解码完再补图"，
  // 实测会看到图片位置先空着一块（灰底），手机上就是一闪。默认的同步解码没这个问题。
  if (container) container.appendChild(img);

  const cached = imgCache.get(hash);
  if (cached) {
    if (cached.w && cached.h) img.style.aspectRatio = cached.w + ' / ' + cached.h;
    img.src = cached.url;
    if (onDone) requestAnimationFrame(onDone);
    return img;
  }

  const load = async () => {
    try {
      const blob = await fetchBlob('Image', hash);
      const url = URL.createObjectURL(blob);
      img.src = url;
      // ⚠️ onDone 必须等图**真的撑开高度**再调：它负责把视图贴回底部，
      // 图还没解码就贴等于白贴 —— 这就是"发完消息有时候没回到底部"的一个元凶
      const done = () => {
        cacheImage(hash, url, img.naturalWidth, img.naturalHeight);
        if (onDone) onDone();
      };
      if (img.complete && img.naturalWidth) done();
      else img.addEventListener('load', done, { once: true });
    } catch (e) { /* 失败留空 */ }
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((ents) => {
      if (ents.some(e => e.isIntersecting)) { io.disconnect(); load(); }
    }, { rootMargin: '200px' });
    io.observe(img);
  } else load();
  return img;
}

async function loadStream(reset, keepPos, forceBottom) {
  const box = $('stream');
  const prevH = box.scrollHeight, prevTop = box.scrollTop;
  const wasNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 120;
  try {
    const fd = new FormData();
    fd.append('page', String(reset ? 1 : streamPage + 1));
    // 按"最近发到电脑"排序：服务端只在某条变成电脑剪贴板时才更新 LastAccessed
    // （收藏、浏览都不动它），所以重发一段已有内容时，那条会自己跑到最下面，看起来就是新消息
    fd.append('sortByLastAccessed', 'true');
    const list = await apiJson('/api/history/query', { method: 'POST', body: fd });
    showSpinner(false);
    if (reset) {
      // ① 新剪贴板进来了（列表只在前面多了几条）→ 只把新的几条追加上去，不重建整屏：
      //    重建＝整屏节点换掉＋图片重新解码，看着就是"闪一下 + 卡一下"
      const add = addedCount(list);
      if (add > 0) {
        const lastRec = streamItems[0] || null;
        streamItems = list; streamPage = 1;
        appendBubbles(lastRec, list.slice(0, add));
        if (forceBottom || !firstLoadDone || wasNearBottom) pinBottom();
        firstLoadDone = true;
        return;
      }
      // ② 内容一模一样 → 什么都不用做（轮询很勤，别白折腾）：重建＝整屏节点换掉＋图片重新解码
      const same = list.length === streamItems.length &&
                   list.every((r, i) => r.hash === streamItems[i].hash);
      streamItems = list; streamPage = 1;
      if (same && !forceBottom && firstLoadDone) return;
      renderStream();
      // 首次进入 / 手动刷新 / 发完消息 → 强制到底；只有自动轮询时才照顾"用户正在往上翻"
      if (forceBottom || !firstLoadDone || wasNearBottom) pinBottom();
      firstLoadDone = true;
    } else {
      if (list.length) { streamItems = streamItems.concat(list); streamPage += 1; }
      renderStream();
      if (keepPos) box.scrollTop = box.scrollHeight - prevH + prevTop;
    }
  } catch (e) {
    showSpinner(e.status !== 401);
    if (!streamItems.length) {
      box.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '读不到：' + e.message;
      box.appendChild(d);
    }
  }
  bumpMetrics();
}

/** 只在末尾补几条（新剪贴板进来了）：不重建整屏 —— 图片元素不用重做，不闪、不跳。
    传进来是"新 → 旧"；因为列表只在**前面**多了 N 条（前缀和旧列表一模一样）才能这么干，
    所以 appendBubbles 拿"旧列表里最新的那条"只是用来决定要不要插时间分隔。 */
function appendBubbles(afterRec, recs) {
  const box = $('stream');
  if (!recs.length) return;
  let lastTs = afterRec ? (Date.parse(afterRec.createTime) || 0) : 0;
  const items = recs.slice().reverse();        // DOM 里是"旧 → 新"
  for (const rec of items) {
    const t = Date.parse(rec.createTime) || 0;
    if (!lastTs || t - lastTs > 10 * 60 * 1000) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      sep.textContent = fmtStamp(rec.createTime);
      box.appendChild(sep);
    }
    lastTs = t;
    box.appendChild(bubbleEl(rec));
  }
}

/** 新列表是不是"旧列表前面多了 N 条"？是就返回 N（可以只追加，不用整屏重建），否则 0。
    ⚠️ 重发已有内容时服务端会把它挪到最前面（旧位置那条没了），这时前缀对不上 → 返回 0 → 老老实实重建 */
function addedCount(list) {
  if (!streamItems.length || list.length <= streamItems.length) return 0;
  const k = list.length - streamItems.length;
  for (let i = 0; i < streamItems.length; i++) {
    if (list[k + i].hash !== streamItems[i].hash) return 0;
  }
  return k;
}

function renderStream() {
  const box = $('stream');
  const hadSel = String(window.getSelection() || '');
  box.innerHTML = '';
  if (!streamItems.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '电脑上还没有内容';
    box.appendChild(d);
    return;
  }
  const items = streamItems.slice().reverse();   // 旧 → 新
  let lastTs = 0;
  for (const rec of items) {
    const t = Date.parse(rec.createTime) || 0;
    if (!lastTs || t - lastTs > 10 * 60 * 1000) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      sep.textContent = fmtStamp(rec.createTime);
      box.appendChild(sep);
    }
    lastTs = t;
    box.appendChild(bubbleEl(rec));
  }
  if (hadSel && window.getSelection) window.getSelection().removeAllRanges();
}

/* ---- 长按气泡弹出的小菜单 ---- */

let ctxMenu = null;

function closeCtxMenu() {
  if (!ctxMenu) return;
  ctxMenu.remove();
  ctxMenu = null;
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('scroll', closeCtxMenu, true);
}
function onDocClick(e) {
  if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu();
}

function openCtxMenu(rec, anchor) {
  closeCtxMenu();
  const m = document.createElement('div');
  m.className = 'ctxmenu glass';
  const add = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); closeCtxMenu(); fn(); });
    m.appendChild(b);
  };

  if (rec.type === 'Text') {
    add('复制全文', async () => {
      const ok = await copyText(rec.text || '');
      toast(ok ? '已复制到手机剪贴板' : '复制失败，请重试', ok ? '' : 'err');
    });
  } else if (rec.type === 'Image') {
    add('保存图片', () => downloadItem(rec));
  } else {
    add('下载文件', () => downloadItem(rec));
  }
  add(rec.starred ? '取消收藏' : '收藏', async () => {
    try {
      await setStar(rec, !rec.starred);
      toast(rec.starred ? '已收藏' : '已取消收藏');
    } catch (e) { toast('操作失败：' + e.message, 'err'); }
  });

  $('app').appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  // 默认弹在气泡上方；放不下就改到下方，最后再夹进可视区，保证永远不会跑到屏幕外
  let top = r.top - mh - 8;
  if (top < 8) top = r.bottom + 8;
  top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
  const left = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - mw - 12));
  m.style.top = Math.round(top) + 'px';
  m.style.left = Math.round(left) + 'px';
  ctxMenu = m;
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

/** 长按 450ms 弹菜单；手指滑动了就当滚动，不算长按 */
function bindLongPress(el, rec) {
  let timer = null, sx = 0, sy = 0, fired = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchstart', (e) => {
    const p = e.touches[0];
    sx = p.clientX; sy = p.clientY; fired = false;
    cancel();
    timer = setTimeout(() => { timer = null; fired = true; openCtxMenu(rec, el); }, HOLD_MS);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const p = e.touches[0];
    if (Math.abs(p.clientX - sx) > 8 || Math.abs(p.clientY - sy) > 8) cancel();
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    cancel();
    if (fired) { fired = false; e.preventDefault(); }   // 长按已经弹了菜单，别再触发 click
  }, { passive: false });
  el.addEventListener('touchcancel', cancel, { passive: true });
  el.addEventListener('contextmenu', (e) => {          // 桌面右键 / 触控板长按
    e.preventDefault();
    openCtxMenu(rec, el);
  });
}

function bubbleEl(rec) {
  const el = document.createElement('div');
  const isText = rec.type === 'Text';
  el.className = 'bubble ' + (isText ? 'text' : (rec.type === 'Image' ? 'media' : 'attach'));
  if (isMine(rec.hash)) el.classList.add('out');   // 手机上发的 → 绿色靠右

  if (isText) {
    el.textContent = rec.text || '';
  } else if (rec.type === 'Image') {
    lazyImage(el, rec.hash, () => { bumpMetrics(); keepBottom(); });
  } else {
    // 文件气泡：左边文件名 + 左下角大小，右边彩色扩展名块（照用户给的微信参考图，见 index.html 的 .bubble.attach）
    const nm = document.createElement('div');
    nm.className = 'fname';
    nm.textContent = rec.text || '文件';
    const sz = document.createElement('div');
    sz.className = 'fsize';
    sz.textContent = rec.size ? fmtSize(rec.size) : '';
    const bd = document.createElement('div');
    bd.className = 'fbadge ' + extBadgeClass(rec.text);
    bd.textContent = extBadgeText(rec.text);
    el.appendChild(nm); el.appendChild(sz); el.appendChild(bd);
  }
  // 图片走 iOS 原生长按（存储到照片）；文字/文件走自己的菜单
  if (rec.type !== 'Image') bindLongPress(el, rec);
  return el;
}

async function downloadItem(rec) {
  try {
    const blob = await fetchBlob(rec.type, rec.hash);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = rec.text || ('clip_' + Date.now());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast('下载失败：' + e.message, 'err');
  }
}

/** 只查当前剪贴板 hash，变了才重拉历史 —— 省流量，也不会把图片反复重新下载 */
async function pollCurrent(force) {
  try {
    const p = await apiJson('/SyncClipboard.json');
    showSpinner(false);
    const h = p && p.hash ? p.hash : '';
    if (force || h !== currentHash) {
      currentHash = h;
      await loadStream(true);
    }
  } catch (e) {
    showSpinner(e.status !== 401);
  }
}

/* ==================== 底部输入栏 ==================== */

const comp = { kind: null, file: null, objUrl: null };

function clearComposer() {
  if (comp.objUrl) { URL.revokeObjectURL(comp.objUrl); comp.objUrl = null; }
  comp.kind = null; comp.file = null;
  $('sendText').value = '';
  $('attach').innerHTML = '';
  $('attach').hidden = true;
  $('sendText').hidden = false;
  autoGrow();
  updateSendBtn();
  bumpMetrics();
}

function setComposer(kind, file) {
  if (comp.objUrl) { URL.revokeObjectURL(comp.objUrl); comp.objUrl = null; }
  comp.kind = kind; comp.file = file || null;
  const at = $('attach'), ta = $('sendText');

  if (kind === 'image' || kind === 'file') {
    ta.hidden = true;
    at.hidden = false;
    at.innerHTML = '';

    let thumb;
    if (kind === 'image') {
      thumb = document.createElement('img');
      comp.objUrl = URL.createObjectURL(file);
      thumb.src = comp.objUrl;
    } else {
      thumb = document.createElement('div');
      thumb.className = 'fico';
      thumb.innerHTML = FILE_ICON;
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = file.name || (kind === 'image' ? '照片' : '文件');
    const sp = document.createElement('span');
    sp.textContent = fmtSize(file.size) + (kind === 'image' ? ' · 图片' : ' · 文件');
    meta.appendChild(b); meta.appendChild(sp);

    const x = document.createElement('button');
    x.className = 'x';
    x.setAttribute('aria-label', '移除');
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"' +
                  ' stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.addEventListener('click', clearComposer);

    at.appendChild(thumb); at.appendChild(meta); at.appendChild(x);
  } else {
    ta.hidden = false;
    at.hidden = true;
    at.innerHTML = '';
  }
  updateSendBtn();
  bumpMetrics();
}

/** ↑ 有两种样子（用户定的）：
    - 空着 → `.ghost`：一块高透玻璃（不置灰，看着点得动），按下去是"粘贴并发送"；
    - 有内容/选了附件 → 绿色 `#07c160`，按下去是普通发送。
    ⚠️ 它**永远不能 disabled**（空着也得能点）。 */
function updateSendBtn() {
  const btn = $('btnSend');
  if (!btn) return;
  btn.disabled = false;
  const has = comp.kind ? !!comp.file : $('sendText').value.trim().length > 0;
  btn.classList.toggle('ghost', !has);
}

function autoGrow() {
  const ta = $('sendText');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
}

async function sendTextNow(text) {
  const hash = await sha256Text(text);
  const res = await api('/SyncClipboard.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'Text', hash: hash, text: text, hasData: false,
                           size: new TextEncoder().encode(text).length })
  });
  if (!res.ok) throw await httpErr(res);
  currentHash = hash;
  return hash;          // 给 doSend 记"这条是我发的"用
}

async function uploadOne(file, kind) {
  let blob = file, name = sanitizeName(file.name, kind === 'image' ? '.jpg' : '.bin');
  const isImg = kind === 'image';

  if (isImg && compressOn() && file.size > COMPRESS_OVER) {
    toast('正在压缩…', null, true);
    const small = await compressImage(file);
    if (small) { blob = small; name = 'Image_' + timeTag() + '.jpg'; }
  }

  const buf = new Uint8Array(await blob.arrayBuffer());
  toast('正在上传 ' + fmtSize(buf.length) + '…', null, true);
  const contentHash = await sha256(buf);
  const pHash = await profileHash(name, contentHash);

  const up = await api('/file/' + encodeURIComponent(name), {
    method: 'PUT',
    // 必须 octet-stream：multipart/form 会被服务端当表单读掉，存成 0 字节
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob
  });
  if (!up.ok) throw await httpErr(up);

  const res = await api('/SyncClipboard.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: isImg ? 'Image' : 'File', hash: pHash, text: name,
                           hasData: true, dataName: name, transferDataHash: contentHash,
                           size: buf.length })
  });
  if (!res.ok) throw await httpErr(res);
  currentHash = pHash;
  return pHash;         // 给 doSend 记"这条是我发的"用（原来返回的是文件名，没人用）
}

async function doSend() {
  const btn = $('btnSend');
  if (btn.disabled) return;
  // 输入框空着（也没选附件）→ 这个 ↑ 就是"粘贴手机剪贴板并发送"（用户 2026-09-20 定的）：
  // 好处是**没有歧义** —— ↑ 本来就是"我要发东西"的动作键，不像"点输入框"那样分不清想粘贴还是想打字
  if (!comp.kind && !$('sendText').value.trim()) {
    await pasteAndSend();
    return;
  }
  btn.disabled = true;
  try {
    // 两个分支都把 hash 返回回来 —— 不用 currentHash 那个全局，
    // 免得刚好有次自动轮询在中间把它改成"电脑当前剪贴板"的 hash
    let sentHash;
    if (comp.kind === 'image' || comp.kind === 'file') {
      sentHash = await uploadOne(comp.file, comp.kind);
    } else {
      const t = $('sendText').value;
      if (!t.trim()) return;
      sentHash = await sendTextNow(t);
    }
    markSent(sentHash);      // 记成"我发的" → 渲染成绿色靠右
    clearComposer();
    toast('已发送');
    await loadStream(true, false, true);
    revealCurrent();
  } catch (e) {
    toast('发送失败：' + e.message, 'err');
  } finally {
    updateSendBtn();
  }
}

/* ==================== 粘贴手机剪贴板并发送 ====================
   挂在那个 ↑ 上：**输入框空着时点 ↑＝粘贴并发送**，有文字/选了图时＝普通发送（见 doSend）。

   ⚠️ 浏览器（尤其 iOS）的硬规矩，决定了这件事**只能挂在一个"动作按钮"上**：
   1) 读剪贴板**必须由用户的一次点击触发** —— 网页不能在打开时偷偷读，
      所以**没法"提前检测剪贴板里有没有东西"**（读之前根本不知道）；
   2) iOS 还会再弹一次它自己的"允许粘贴?"，这一下网页管不了；
   3) 所以不能把"点输入框"当触发 —— 网页分不清你是想粘贴还是想打字（点框打字时弹一次很烦，
      而且万一系统把粘贴设成"永远允许"，打字那一下会把剪贴板内容悄悄发出去）。
   ↑ 是"我要发东西"的意思，挂在这儿没有歧义，也不用为它加/改任何样式。 */

/** 读剪贴板：有图片就给图片，否则给文字。只能在"用户点击"的调用链里用 */
async function readClipboard() {
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const types = it.types || [];
        const img = types.find((t) => t.indexOf('image/') === 0);
        if (img) return { kind: 'image', blob: await it.getType(img), type: img };
        if (types.indexOf('text/plain') >= 0) {
          const b = await it.getType('text/plain');
          return { kind: 'text', text: await b.text() };
        }
      }
    } catch (e) { /* read() 不行（或不支持）就退回 readText() 再试一次 */ }
  }
  return { kind: 'text', text: await navigator.clipboard.readText() };
}

/** 点"📋"：把手机剪贴板的内容直接发到电脑（跟手动发送走同一条路）。
    ⚠️ 不动输入框里已经打的草稿 —— 剪贴板内容作为单独一条消息发出去。 */
async function pasteAndSend() {
  const btn = $('btnSend');        // 复用 ↑ 当"正在处理"的锁（它就是这个功能的按钮）
  if (!navigator.clipboard || (!navigator.clipboard.read && !navigator.clipboard.readText)) {
    toast('这个浏览器不支持读剪贴板', 'err');
    return;
  }
  if (btn && btn.disabled) return;      // 正在发，别重复触发
  if (btn) btn.disabled = true;
  try {
    let got;
    try {
      got = await readClipboard();
    } catch (e) {
      toast('没读到剪贴板（是不是点了"不允许粘贴"）', 'err');
      return;
    }
    if (!got) { toast('剪贴板里没有内容'); return; }

    let sentHash;
    if (got.kind === 'image') {
      const ext = /png/i.test(got.type || '') ? '.png' : '.jpg';
      const file = new File([got.blob], 'Image_' + timeTag() + ext, { type: got.type || 'image/jpeg' });
      sentHash = await uploadOne(file, 'image');
    } else {
      const text = got.text || '';
      if (!text.trim()) { toast('剪贴板里没有文字'); return; }
      sentHash = await sendTextNow(text);
    }
    markSent(sentHash);
    toast('已发送');
    await loadStream(true, false, true);
    revealCurrent();
  } catch (e) {
    toast('发送失败：' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* 要不要"贴着底部"：用户往上翻就自动放开，翻回底部又自动贴上。
   ⚠️ 原来只有"操作完连钉 8 帧（约 1 秒）"—— 而图片是懒加载的，一张大图可能 1 秒后才撑开高度，
   那时候钉子早拔了，看着就是"发完消息有时候没回到最底部"。
   现在跟着这个意愿走：只要还在贴底状态，图片加载完就再贴一次。 */
let stickBottom = true;

function nearBottom(tol) {
  const box = $('stream');
  return box.scrollHeight - box.scrollTop - box.clientHeight < (tol == null ? 120 : tol);
}

let pinTimer = null;

/** 点输入框要打字时用：**先掐断惯性滚动，再立刻跳到最底**。
    用户 2026-09-20 的原话："页面在滑动、滚动条还在动的时候点输入框，此刻页面停止滑动，
    然后就到最底端"。所以这里是"停下 + 到底"一步做完。

    ⚠️ 光写一次 scrollTop 不够：iOS 上惯性还在跑的时候，写一下会被惯性接着带走
    （表现就是"点了没回到底"，或者原地抖好几下）。先把 overflowY 关一下 ——
    滚动容器一旦不是"可滚动的"，正在跑的滚动动画会被强制中断；
    读 scrollHeight 那一下会强制刷新样式，紧接着定位就稳了。整段是同步的，用户察觉不到。
    ⚠️ 别再改回"连钉 8 帧 × 130ms"：那个配上 focus + 键盘动画会一秒戳十几次，就是之前的抖动来源。 */
function jumpToBottom() {
  const box = $('stream');
  stickBottom = true;
  box.style.overflowY = 'hidden';        // 掐断惯性（强制中断滚动动画）
  box.scrollTop = box.scrollHeight;      // 读 scrollHeight 会刷新样式，所以这一下是"停住之后"的定位
  box.style.overflowY = '';              // 立刻还回去
  requestAnimationFrame(() => {          // 下一帧再补一次：键盘弹起会让可视区变矮
    if (stickBottom) box.scrollTop = box.scrollHeight;
  });
}

/** 连续几帧把视图钉在底部：图片是懒加载的，会陆续把高度撑开（键盘动画也会顶一次） */
function pinBottom() {
  const box = $('stream');
  stickBottom = true;                 // 这次是"要求贴底"
  if (pinTimer) return;               // 同一时刻只跑一个循环，别叠第二个（focus + 键盘会各叫一次）
  let n = 0;
  const tick = () => {
    pinTimer = null;
    if (!stickBottom) return;         // 中途用户自己往上翻了，别跟他抢
    box.scrollTop = box.scrollHeight;
    if (++n < 4) pinTimer = setTimeout(tick, 260);
  };
  tick();
}

/** 图片加载完把高度撑开时：本来就在贴底状态，就再贴一次 */
function keepBottom() {
  if (!stickBottom) return;
  const box = $('stream');
  box.scrollTop = box.scrollHeight;
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;              // 强制重排，让动画能重放
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

/** 把"当前"这条露出来：它就是最后一条就滚到底，否则滚到它并闪一下（发重复内容时服务端是复用旧记录，不会新建） */
function revealCurrent() {
  const box = $('stream');
  const kids = [...box.querySelectorAll('.bubble')];
  const idx = streamItems.slice().reverse().findIndex(r => r.hash === currentHash);
  const el = idx >= 0 ? kids[idx] : null;
  if (!el) return;
  if (idx !== kids.length - 1) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash(el);                       // 闪一下，让人看见刚发出去的是哪条
}

function onPick(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const isImg = /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(f.name);
  setComposer(isImg ? 'image' : 'file', f);
}

/* ==================== 复制 / 下载 / 收藏 ==================== */

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 继续 */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    if (ta.setSelectionRange) ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/** 收藏 / 取消收藏。服务端做版本校验，冲突(409)时用服务端返回的版本重试一次 */
async function setStar(rec, on) {
  let body = { starred: on };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await api('/api/history/' + rec.type + '/' + rec.hash, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (res.ok) { rec.starred = on; return true; }
    if (res.status === 409) {
      const server = await res.json().catch(() => null);
      if (server && typeof server.version === 'number') {
        body = { starred: on, version: server.version + 1 };
        continue;
      }
    }
    throw await httpErr(res);
  }
  throw new Error('保存收藏失败（版本冲突）');
}

/* ==================== 列表（搜索 / 收藏共用） ==================== */

function itemEl(rec, listKind) {
  const wrap = document.createElement('div');
  wrap.className = 'hist-item';

  if (rec.type === 'Image' && rec.hasData) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    const load = () => fetchBlob('Image', rec.hash)
      .then(b => { img.src = URL.createObjectURL(b); }).catch(() => {});
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((ents) => {
        if (ents.some(e => e.isIntersecting)) { io.disconnect(); load(); }
      }, { rootMargin: '120px' });
      io.observe(img);
    } else load();
    img.addEventListener('click', () => downloadItem(rec));
    wrap.appendChild(img);
  }

  const main = document.createElement('div');
  main.className = 'hist-main';
  const tag = document.createElement('span');
  tag.className = 'tag t-' + String(rec.type || '').toLowerCase();
  tag.textContent = TYPE_CN[rec.type] || rec.type;
  main.appendChild(tag);
  const txt = document.createElement('div');
  txt.className = 'hist-text';
  const t = rec.text || '(空)';
  txt.textContent = t.length > 400 ? t.slice(0, 400) + ' …' : t;
  main.appendChild(txt);
  const meta = document.createElement('div');
  meta.className = 'hist-meta';
  meta.textContent = fmtStamp(rec.createTime) + (rec.size ? ' · ' + fmtSize(rec.size) : '');
  main.appendChild(meta);
  wrap.appendChild(main);

  const acts = document.createElement('div');
  acts.className = 'hist-acts';

  // 主操作：文字=复制，图片=存图，文件=下载（浏览器里没法把图片塞进手机剪贴板）
  const mainBtnText = rec.type === 'Text' ? '复制' : (rec.type === 'Image' ? '存图' : '下载');
  const mb = document.createElement('button');
  mb.className = 'btn sm';
  mb.textContent = mainBtnText;
  mb.addEventListener('click', async () => {
    if (rec.type === 'Text') {
      const ok = await copyText(rec.text || '');
      toast(ok ? '已复制到手机剪贴板' : '复制失败，请长按文字手动拷贝', ok ? '' : 'err');
    } else {
      downloadItem(rec);
    }
  });
  acts.appendChild(mb);

  // 收藏 / 取消收藏
  const sb = document.createElement('button');
  sb.className = 'btn sm' + (rec.starred ? ' starred' : '');
  sb.innerHTML = rec.starred ? STAR_FILLED : STAR_EMPTY;
  sb.style.display = 'grid';
  sb.style.placeItems = 'center';
  sb.title = rec.starred ? '取消收藏' : '收藏';
  sb.addEventListener('click', async () => {
    try {
      await setStar(rec, !rec.starred);
      // 就地更新按钮，别整表重刷 —— 一重刷就跳回顶部，刚点的那条就不在原位了
      sb.className = 'btn sm' + (rec.starred ? ' starred' : '');
      sb.innerHTML = rec.starred ? STAR_FILLED : STAR_EMPTY;
      sb.title = rec.starred ? '取消收藏' : '收藏';
      toast(rec.starred ? '已收藏' : '已取消收藏');
      if (listKind === 'star' && !rec.starred) {
        wrap.remove();                                  // 在收藏列表里取消收藏 = 从列表里去掉这一行
        const n = $('starList').querySelectorAll('.hist-item').length;
        $('starInfo').textContent = n ? n + ' 条' : '';
        if (!n) loadStars();
      }
    } catch (e) {
      toast('操作失败：' + e.message, 'err');
    }
  });
  acts.appendChild(sb);

  wrap.appendChild(acts);
  return wrap;
}

function openDlg(dlg) {
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  // showModal 会把焦点给第一个可聚焦元素（关闭按钮）挂一圈黑框，改聚焦弹窗本身
  try { dlg.setAttribute('tabindex', '-1'); dlg.focus(); } catch (e) { /* 忽略 */ }
}
function closeDlg(dlg) {
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

/* ---- 搜索 ---- */

let searchPage = 1, searchLast = 0;

function openSearch() {
  $('q').value = '';          // 每次打开都清空关键词
  searchPage = 1;
  openDlg($('dlgSearch'));
  loadSearch();
}

async function loadSearch() {
  const box = $('searchList');
  box.innerHTML = '<div style="color:var(--muted);font-size:14px">加载中…</div>';
  try {
    const fd = new FormData();
    fd.append('page', String(searchPage));
    const kw = $('q').value.trim();
    if (kw) fd.append('searchText', kw);
    const list = await apiJson('/api/history/query', { method: 'POST', body: fd });
    searchLast = list.length;
    $('pageInfo').textContent = list.length ? ('第 ' + searchPage + ' 页 · ' + list.length + ' 条') : '';
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div style="color:var(--muted);font-size:14px">没有找到</div>';
      return;
    }
    for (const rec of list) box.appendChild(itemEl(rec, 'search'));
  } catch (e) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.style.cssText = 'color:var(--err);font-size:14px';
    d.textContent = '加载失败：' + e.message;
    box.appendChild(d);
  }
}

/* ---- 收藏 ---- */

async function loadStars() {
  const box = $('starList');
  box.innerHTML = '<div style="color:var(--muted);font-size:14px">加载中…</div>';
  try {
    const fd = new FormData();
    fd.append('page', '1');
    fd.append('starred', 'true');
    const list = await apiJson('/api/history/query', { method: 'POST', body: fd });
    $('starInfo').textContent = list.length ? list.length + ' 条' : '';
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div style="color:var(--muted);font-size:14px">还没有收藏。在搜索里点 ☆ 收藏，收藏的条目不会被历史清理掉。</div>';
      return;
    }
    for (const rec of list) box.appendChild(itemEl(rec, 'star'));
  } catch (e) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.style.cssText = 'color:var(--err);font-size:14px';
    d.textContent = '加载失败：' + e.message;
    box.appendChild(d);
  }
}

/** 一键清除收藏：反复拉第 1 页，逐条取消（取消后就不在筛选结果里了） */
async function clearAllStars() {
  if (!window.confirm('确认清除全部？')) return;
  let n = 0;
  try {
    for (let guard = 0; guard < 60; guard++) {
      const fd = new FormData();
      fd.append('page', '1');
      fd.append('starred', 'true');
      const list = await apiJson('/api/history/query', { method: 'POST', body: fd });
      if (!list.length) break;
      for (const rec of list) { await setStar(rec, false); n++; }
      if (list.length < PAGE_SIZE) break;
    }
    toast(n ? ('已清除 ' + n + ' 条收藏') : '没有收藏');
  } catch (e) {
    toast('清除失败：' + e.message, 'err');
  }
  loadStars();
}

/* ==================== 设置 ==================== */

function openSettings() {
  const sec = parseInt(localStorage.getItem(K_INT) || '5', 10);
  $('inUser').value = localStorage.getItem(K_USER) || '';
  $('inPass').value = localStorage.getItem(K_PASS) || '';
  $('inAuto').checked = sec > 0;
  $('inInt').value = String(sec > 0 ? sec : 5);
  $('inInt').disabled = !(sec > 0);
  $('inCompress').checked = compressOn();
  setMsg($('dlgMsg'), '');
  openDlg($('dlg'));
}

function saveSettings() {
  localStorage.setItem(K_USER, $('inUser').value.trim());
  localStorage.setItem(K_PASS, $('inPass').value);
  const on = $('inAuto').checked;
  let sec = parseInt($('inInt').value, 10);
  if (!(sec > 0)) sec = 5;
  sec = Math.min(600, Math.max(1, sec));
  localStorage.setItem(K_INT, String(on ? sec : 0));
  if (on) $('inInt').value = String(sec);
  localStorage.setItem(K_COMPRESS, $('inCompress').checked ? '1' : '0');
  setupTimer();
  setMsg($('dlgMsg'), '已保存', 'ok');
  pollCurrent();
}

async function testConn() {
  const u = $('inUser').value.trim(), p = $('inPass').value;
  const old = [localStorage.getItem(K_USER), localStorage.getItem(K_PASS)];
  localStorage.setItem(K_USER, u); localStorage.setItem(K_PASS, p);
  try {
    const res = await api('/api/version');
    if (!res.ok) throw await httpErr(res);
    setMsg($('dlgMsg'), '连接正常，服务端版本 ' + (await res.text()), 'ok');
  } catch (e) {
    setMsg($('dlgMsg'), '连接失败：' + e.message, 'err');
  } finally {
    if (old[0] === null) localStorage.removeItem(K_USER); else localStorage.setItem(K_USER, old[0]);
    if (old[1] === null) localStorage.removeItem(K_PASS); else localStorage.setItem(K_PASS, old[1]);
  }
}

/* ==================== 自动刷新 ====================
   默认 5 秒轮询一次（设置里能改/能关）—— 这条一直没变，别再动它。
   在这之上，2026-09-20 按用户要求多加了一条"打开/切回页面立刻刷一次"，见下面 refreshOnShow()。 */

let timer = null;
function setupTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  const sec = parseInt(localStorage.getItem(K_INT) || '5', 10);
  // ⚠️ 没存账号就别轮询：那种请求不带 Authorization，服务端必然回 401，
  // 除了白跑一趟，还可能把浏览器的原生账号框勾出来（所以 nginx 那边也抹掉了挑战头，双保险）
  if (sec > 0) {
    timer = setInterval(() => {
      if (!document.hidden && localStorage.getItem(K_USER)) pollCurrent();
    }, sec * 1000);
  }
}

/* ---- 打开 / 切回这个页面：立刻刷一次（用户要的"一打开就自动刷新"） ----
   ⚠️ **不能只靠 boot() 里那次 pollCurrent()**：手机上这个页面是"加到主屏幕"的独立窗口，
   点图标时如果进程还在（只是被压到后台），走的是**恢复**、根本不会重新加载 —— boot() 不再跑，
   页面就一直是离开时那一屏（这正是"打开界面没看到电脑刚复制的东西"的原因）。
   切回前台只会触发 visibilitychange，所以这一下必须挂在那儿。
   （pageshow 是 bfcache 那条路的兜底，只在 e.persisted 时算数 —— 否则首屏加载时会多刷一次。
     两个事件在恢复时可能一起来，用 800ms 去重，别白跑两个请求。） */
let lastShowRefresh = 0;
function refreshOnShow() {
  if (document.hidden || !localStorage.getItem(K_USER)) return;
  const now = Date.now();
  if (now - lastShowRefresh < 800) return;
  lastShowRefresh = now;
  pollCurrent(true);
}
function setupRefreshOnShow() {
  document.addEventListener('visibilitychange', refreshOnShow);
  window.addEventListener('pageshow', (e) => { if (e.persisted) refreshOnShow(); });
}

/* ==================== 自检 ==================== */

function selfCheck() {
  const expect = 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';
  if (sha256Js(new TextEncoder().encode('abc')) !== expect) {
    console.warn('内置 SHA-256 自检失败（纯 JS 兜底实现有问题）');
    return false;
  }
  console.log('SHA-256 自检通过；WebCrypto:', !!(window.crypto && crypto.subtle && window.isSecureContext));
  return true;
}

/* ==================== 启动 ==================== */

function boot() {
  // 标题就是刷新按钮（照旧：整页重载）
  $('brand').addEventListener('click', () => location.reload());

  // 用户自己滚了一下 → 重新判断"还要不要贴着底部"
  // （往上翻就不再抢滚动位置；翻回底部附近又自动贴上，图片加载完会跟着贴）
  $('stream').addEventListener('scroll', () => { stickBottom = nearBottom(); }, { passive: true });

  // 3) 一键清除收藏
  $('btnStarClear').addEventListener('click', clearAllStars);

  $('btnSearch').addEventListener('click', openSearch);
  $('btnStar').addEventListener('click', () => { openDlg($('dlgStar')); loadStars(); });
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSearchClose').addEventListener('click', () => closeDlg($('dlgSearch')));
  $('btnStarClose').addEventListener('click', () => closeDlg($('dlgStar')));
  $('btnClose').addEventListener('click', () => closeDlg($('dlg')));
  $('btnSave').addEventListener('click', saveSettings);
  $('btnTest').addEventListener('click', testConn);
  $('inAuto').addEventListener('change', () => { $('inInt').disabled = !$('inAuto').checked; });

  $('btnDoSearch').addEventListener('click', () => { searchPage = 1; loadSearch(); });
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { searchPage = 1; loadSearch(); } });
  $('btnPrev').addEventListener('click', () => { if (searchPage > 1) { searchPage--; loadSearch(); } });
  $('btnNext').addEventListener('click', () => { if (searchLast >= PAGE_SIZE) { searchPage++; loadSearch(); } });

  // 输入栏
  $('sendText').addEventListener('input', () => {
    if (comp.kind === 'image' || comp.kind === 'file') setComposer('text');
    autoGrow(); updateSendBtn(); bumpMetrics();
  });
  // 点输入框要打字时：不管当前翻到哪儿，都把视图带回最底部那条消息
  $('sendText').addEventListener('focus', () => {
    setTimeout(bumpMetrics, 300);
    jumpToBottom();                  // 点输入框 → 立刻掐断惯性 + 跳到最底（用户要的效果）
    setTimeout(pinBottom, 360);      // 等键盘动画/视口变化结束再钉一次
  });
  $('btnSend').addEventListener('click', doSend);

  // ＋ 直接唤起系统选择器（照片图库 / 拍照或录像 / 选取文件）
  $('btnPlus').addEventListener('click', () => $('pickAny').click());
  $('pickAny').addEventListener('change', onPick);

  // 滚到顶部就加载更早的记录
  $('stream').addEventListener('scroll', () => {
    const box = $('stream');
    if (box.scrollTop < 40 && !loadingOlder && streamPage > 0 && streamItems.length >= streamPage * PAGE_SIZE) {
      loadingOlder = true;
      loadStream(false, true).finally(() => { loadingOlder = false; });
    }
  }, { passive: true });

  let rt = null;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { bumpMetrics(); }, 150); };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  selfCheck();
  setupViewport();
  setupTimer();
  setupRefreshOnShow();     // 切回前台/从 bfcache 回来 → 立刻刷一次
  bumpMetrics();
  autoGrow();
  updateSendBtn();

  if (!localStorage.getItem(K_USER)) {
    openSettings();
  } else {
    pollCurrent();
  }
  setTimeout(bumpMetrics, 500);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
