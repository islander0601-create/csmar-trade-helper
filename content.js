/* =========================================================
 * CSMAR 期货交易助手 · Chrome 扩展版
 * v1.6.0
 *
 * v1.5.x 风控分多空、动能/超买超卖、后台保活、TWAP均价
 * v1.6.0 【真 VWAP】用同源 iframe 加载 qchartDetail.html，
 *        读「总手/总额」→ VWAP = 总额 / (总手 × 乘数)
 *        读不到自动退回 TWAP。设置里可关。
 *
 * 必须 world:"MAIN" 注入；manifest 里 all_frames:false 防止 iframe 嵌套注入。
 * ========================================================= */

(function () {
  'use strict';

  /* ============================================================
   * 0. 防重复注入
   * ============================================================ */
  if (window.__CSMAR_QD__) {
    console.log('[QD] 助手已存在');
    return;
  }
  window.__CSMAR_QD__ = true;

  const HOST = location.origin;
  const LS_CFG = 'csmar_qd_cfg_v1';
  const LS_META = 'csmar_qd_meta_v1';

  /* ============================================================
   * 1. 配置
   * ============================================================ */
  const DEFAULT_CFG = {
    lots: 1,            // 手数
    offset: 1,          // 偏移量
    offsetUnit: 'tick', // tick | price
    base: 'counter',    // counter=对手价 | last=最新价
    orderType: 'limit', // limit | market
    closeType: 2,       // 2=平仓 3=平今
    fastMode: true,     // 极速模式（无需确认）
    maxLots: 20,        // 单笔上限（保护）
    dryRun: false,      // 试运行
    winSec: 180,        // 布林窗口秒数
    sample: 'tick',     // tick=价格变化才记 | sec=每秒
    sym: '',            // 空=跟随页面当前合约
    uid: '',            // 手动指定交易账号（一般不用填）
    // —— 风控 ——
    slTicks: 20,        // 止损跳数（相对开仓均价，0=不设）
    tpTicks: 40,        // 止盈跳数
    trailTicks: 8,      // 移动止损回撤跳数
    trailOn: false,
    riskCash: 2000,     // 按金额算手数：最多亏多少
    autoArm: true,      // 反手后自动挂保护
    keepAlive: true,    // 后台保活（防止浏览器节流定时器）
    vwap: true,         // 用同源 iframe 读分时图的「总手/总额」算真 VWAP
    vp: {},             // 按品种记忆参数 { SC:{...}, IC:{...} }
    tab: 'trade',
    py: 120,
    collapsed: false,
    showBoll: true
  };

  // 常见品种的推荐默认值（首次用到该品种时套用；之后按品种各记各的）
  const VARIETY_DEFAULT = {
    SC: { offset: 1, slTicks: 20, tpTicks: 40, trailTicks: 8, lots: 1 },   // 原油：每跳 100 元
    IC: { offset: 2, slTicks: 50, tpTicks: 100, trailTicks: 15, lots: 1 }, // 中证500：每跳 40 元
    IF: { offset: 2, slTicks: 50, tpTicks: 100, trailTicks: 15, lots: 1 },
    IH: { offset: 2, slTicks: 50, tpTicks: 100, trailTicks: 15, lots: 1 },
    IM: { offset: 2, slTicks: 50, tpTicks: 100, trailTicks: 15, lots: 1 }
  };
  const VARIETY_FALLBACK = { offset: 1, slTicks: 20, tpTicks: 40, trailTicks: 8, lots: 1 };

  let cfg = Object.assign({}, DEFAULT_CFG);
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(LS_CFG) || '{}')); } catch (e) {}
  const saveCfg = () => { try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) {} };

  /* ============================================================
   * 2. 基础工具
   * ============================================================ */
  const num = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isFinite(n) ? n : NaN;
  };
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const hms = (t) => { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isOk = (js) => !!js && (js.isOK === true || js.IsOK === true);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function decimalsOf(t) {
    const s = String(t);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }

  // 按最小变动价位取整（整数化运算，避免浮点把 724.55 算成 724.5）
  function roundTick(p, tick) {
    if (!tick || !isFinite(tick) || tick <= 0) return Math.round(p * 100) / 100;
    const d = decimalsOf(tick);
    const k = Math.pow(10, d);
    const pi = Math.round(p * k);
    const ti = Math.round(tick * k) || 1;
    const v = Math.round(pi / ti) * ti;
    return Number((v / k).toFixed(Math.max(d, 2)));
  }

  /* ============================================================
   * 3. 接口层
   *    - 全部走同源 fetch，自动带 sessionStorage.TOKEN
   *    - 接口路径来自站点自身前端代码，与页面行为一致
   * ============================================================ */
  async function req(method, path, data) {
    const url = HOST + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'timestamp=' + Date.now();
    const headers = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const tk = sessionStorage.getItem('TOKEN');
    if (tk) headers['Authorization'] = tk;

    const opt = { method: method, headers: headers, credentials: 'include', cache: 'no-store' };
    if (method !== 'GET' && data !== undefined) opt.body = JSON.stringify(data);

    const rs = await fetch(url, opt);
    if (rs.status === 401) throw new Error('登录状态已失效，请刷新页面重新登录');
    const txt = await rs.text();
    let js = null;
    try { js = JSON.parse(txt); } catch (e) {
      throw new Error('响应不是 JSON（' + txt.slice(0, 80) + '）');
    }
    return js;
  }

  const apiGet = function (path, q) {
    let p = path;
    if (q) {
      const s = Object.keys(q).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
      if (s) p += (p.indexOf('?') >= 0 ? '&' : '?') + s;
    }
    return req('GET', p);
  };
  const apiPost = (path, body) => req('POST', path, body);

  /* ============================================================
   * 4. 合约元数据（最小变动价位 / 涨跌停 / 合约乘数）
   * ============================================================ */
  let META = null, META_AT = 0;
  async function loadMeta(force) {
    if (!force && META && Date.now() - META_AT < 10 * 60e3) return META;
    try {
      const js = await apiGet('/VERace/FutQuery/GetFutureCurInfo');
      if (isOk(js) && Array.isArray(js.data)) {
        META = js.data; META_AT = Date.now();
        try { localStorage.setItem(LS_META, JSON.stringify({ at: META_AT, d: META })); } catch (e) {}
      }
    } catch (e) {
      if (!META) {
        try {
          const c = JSON.parse(localStorage.getItem(LS_META) || 'null');
          if (c && c.d) { META = c.d; META_AT = c.at || 0; }
        } catch (e2) {}
      }
    }
    return META || [];
  }
  function metaOf(sym) {
    if (!META) return null;
    for (let i = 0; i < META.length; i++) if (META[i].security === sym) return META[i];
    return null;
  }

  /* ============================================================
   * 5. Vue 实例定位（复用页面自身的账号信息，避免抓 DOM）
   * ============================================================ */
  function findOrderVm() {
    const app = document.getElementById('app');
    const root = app && app.__vue__;
    if (!root) return null;
    let hit = null;
    const seen = new Set();
    (function dfs(vm, d) {
      if (!vm || d > 60 || hit || seen.has(vm)) return;
      seen.add(vm);
      const data = vm._data || vm.$data || {};
      if (data.currentSecurityInfo && ('orderNum' in data)) {
        hit = vm; return;
      }
      const ch = vm.$children || [];
      for (let i = 0; i < ch.length; i++) dfs(ch[i], d + 1);
    })(root, 0);
    return hit;
  }

  const UID_C = { v: '', at: 0 };
  function getUserId() {
    if (cfg.uid) return cfg.uid;
    if (UID_C.v && Date.now() - UID_C.at < 15000) return UID_C.v;
    const done = (v) => { UID_C.v = v; UID_C.at = Date.now(); return v; };
    // 1) Vuex store（页面各处的统一来源）
    try {
      const app = document.getElementById('app');
      const root = app && app.__vue__;
      const g = root && root.$store && root.$store.getters;
      if (g && g.currentMsTraderID) return done(String(g.currentMsTraderID));
    } catch (e) {}
    // 2) 下单面板组件的计算属性
    try {
      const vm = findOrderVm();
      if (vm && vm.msTraderID) return done(String(vm.msTraderID));
    } catch (e) {}
    // 3) 本地存储里搜 msTraderID
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (!k || k.length > 40) continue;
          const v = store.getItem(k);
          if (!v || v.length > 20000) continue;
          const m = v.match(/"msTraderID"\s*:\s*"?([\w\-]+)"?/i);
          if (m && m[1] && m[1] !== '0') return done(m[1]);
        }
      } catch (e) {}
    }
    return '';
  }

  function currentSym() {
    if (cfg.sym && cfg.sym.indexOf('.') > 0) return cfg.sym;
    try {
      const vm = findOrderVm();
      if (vm) {
        const s = vm.currentSecurityInfo || {};
        if (s.securityID && s.market) {
          const v = s.securityID + '.' + s.market;
          if (cfg.lastSym !== v) { cfg.lastSym = v; saveCfg(); }
          return v;
        }
      }
    } catch (e) {}
    // 页面读不到时（比如在看分时图）沿用上次的合约
    return cfg.lastSym || '';
  }

  /* ============================================================
   * 6. 行情
   * ============================================================ */
  const QC = { sym: '', at: 0, data: null };
  async function getQuote(sym, force) {
    if (!sym) return null;
    if (!force && QC.sym === sym && Date.now() - QC.at < 850) return QC.data;
    const js = await apiGet('/VERace/FutQuery/QueryQuote', { Security: sym });
    if (isOk(js) && js.data) {
      QC.sym = sym; QC.at = Date.now(); QC.data = js.data;
      return js.data;
    }
    return null;
  }

  function bestOf(q, side) {
    // side 1=买(要对手卖一) 2=卖(要对手买一)
    try {
      if (side === 1) {
        if (q.sellLevels && q.sellLevels[0] && num(q.sellLevels[0].price) > 0) return num(q.sellLevels[0].price);
      } else {
        if (q.buyLevels && q.buyLevels[0] && num(q.buyLevels[0].price) > 0) return num(q.buyLevels[0].price);
      }
    } catch (e) {}
    const lp = num(q.lastPrice);
    return isFinite(lp) ? lp : num(q.lsp);
  }

  function makePrice(q, meta, side) {
    const tick = (meta && num(meta.minTickSize)) || 0.01;
    let base = cfg.base === 'last' ? num(q.lastPrice) : bestOf(q, side);
    if (!isFinite(base) || base <= 0) base = num(q.lsp);
    const off = cfg.offsetUnit === 'tick' ? cfg.offset * tick : cfg.offset;
    let p = side === 1 ? base + off : base - off;

    p = roundTick(p, tick);

    const lo = Math.max(num(q.lowerLimit) || 0, (meta && num(meta.limitDown)) || 0);
    const hi = Math.min(num(q.upperLimit) || 0, (meta && num(meta.limitUp)) || 0);
    if (lo > 0 && p < lo) p = lo;
    if (hi > 0 && p > hi) p = hi;
    return roundTick(p, tick);
  }

  /* ============================================================
   * 7. 下单
   * ============================================================ */
  const ERR_MAP = {
    60001: '合约非法', 60002: '数量非法', 60003: '价格非法', 60004: '可用资金不足',
    60005: '可用持仓不足', 60006: '合约停牌', 60007: '非交易时间', 60008: '清算时间不能委托',
    60009: '撤单失败', 60010: '业务禁止', 60011: '参数错误', 60012: '无查询记录',
    60013: '查询异常', 60014: '委托失败', 60015: '重复报单', 60016: '无效账户',
    60017: '无法成交', 60018: '规模超限', 60019: '资金账号被冻结', 60020: '行情未初始化',
    60021: '超过保护限价', 60101: '黑名单限制', 60102: '日下单总量超限', 60103: '下单瞬发量超限',
    60104: '撤单瞬发量超限', 60105: '未回报委托存量超限', 60106: '超账户资金使用上限',
    60110: '缺少TGWID', 60111: '缺少UserID', 60114: '超过持仓限额', 60125: '不支持', 60126: '发送失败'
  };

  function errText(js) {
    if (!js) return '无响应';
    const raw = js.msg != null ? js.msg : (js.Msg != null ? js.Msg : '');
    const n = Number(raw);
    if (ERR_MAP[n]) return ERR_MAP[n] + '(' + n + ')';
    return String(raw || '未知错误');
  }

  const MARKET_SUPPORT_MKT = { CZCE: 8, DCE: 13 }; // 真市价委托类型

  async function submitOrder(opt) {
    const sym = opt.sym;
    const side = opt.side;      // 1 买 2 卖
    const pe = opt.pe;          // 1 开 2 平 3 平今
    const qty = opt.qty;
    const price = opt.price;

    if (!sym || sym.indexOf('.') < 0) throw new Error('未识别合约代码');
    const parts = sym.split('.');
    const securityID = parts[0], market = parts[1];

    const uid = getUserId();
    if (!uid) throw new Error('未识别交易账号：请先打开「商品期货 → 交易下单」页面');

    let biz = 2;
    let px = String(price);
    if (cfg.orderType === 'market') {
      const mt = MARKET_SUPPORT_MKT[market];
      if (!mt) {
        // SHFE/INE 不支持市价，用对手价限价替代
        biz = 2;
        toast('该交易所不支持市价单，已用对手价限价发送', 'warn');
      } else {
        biz = mt;
        px = '0';
      }
    }
    let peUse = pe;
    if (peUse === 3 && market !== 'SHFE' && market !== 'INE') peUse = 2;

    const body = {
      UserID: uid,
      Security: sym,
      Market: market,
      Side: side,
      PositionEffect: peUse,
      BizAction: biz,
      Price: px,
      OrderQty: qty,
      Text: opt.text || ('QD' + (side === 1 ? '买' : '卖') + (peUse === 1 ? '开' : (peUse === 3 ? '平今' : '平')))
    };

    if (cfg.dryRun) {
      pushLog('试运行', describe(opt) + ' —— 未发送');
      toast('试运行：' + describe(opt), 'info');
      return { ok: true, dry: true };
    }

    const ordPath = market === 'CFFEX' ? '/VERace/FinFutTrade/PlaceFinFutOrder' : '/VERace/FutTrade/PlaceFutOrder';
    pushLog('发送', describe(opt));
    let js;
    try {
      js = await apiPost(ordPath, body);
    } catch (e) {
      pushLog('异常', describe(opt) + ' → ' + (e.message || e));
      throw e;
    }
    if (isOk(js)) {
      pushLog('成功', describe(opt));
      toast('委托已提交 · ' + describe(opt), 'ok');
      POS.at = 0;              // 让下一轮循环立刻刷新持仓
      refreshPageTables();
      return { ok: true, data: js.data };
    }
    const msg = errText(js);
    pushLog('失败', describe(opt) + ' → ' + msg);
    toast('下单失败：' + msg, 'err');
    return { ok: false, msg: msg };
  }

  function describe(o) {
    const dir = (o.side === 1 ? '买' : '卖') + (o.pe === 1 ? '开' : (o.pe === 3 ? '平今' : '平'));
    return dir + ' ' + o.sym.split('.')[0] + ' ' + o.qty + '手 @' + (cfg.orderType === 'market' && MARKET_SUPPORT_MKT[o.sym.split('.')[1]] ? '市价' : o.price);
  }

  // 让页面上的「当日委托 / 持仓」跟着刷新一下
  let refreshT = 0;
  function refreshPageTables() {
    const now = Date.now();
    if (now - refreshT < 800) return;
    refreshT = now;
    try {
      const vm = findOrderVm();
      if (vm && typeof vm.getMaxVolume === 'function') { try { vm.getMaxVolume(); } catch (e) {} }
    } catch (e) {}
  }

  /* ============================================================
   * 8. 持仓 / 撤单
   * ============================================================ */
  async function fetchPositions(sym) {
    const uid = getUserId();
    if (!uid) throw new Error('未识别交易账号');
    const js = await apiGet('/VERace/FutQuery/QueryFutAssetPosition', { UserID: uid, PageIndex: 1, PageSize: 500 });
    const list = (js && js.data) || [];
    return list.filter((r) => (r.securityID + '.' + r.market) === sym);
  }

  async function closeAll(sym) {
    const rows = (await fetchPositions(sym)).filter((r) => num(r.usablePosition) > 0);
    if (!rows.length) { toast('当前合约没有可平持仓', 'warn'); return; }
    const total = rows.reduce((a, b) => a + num(b.usablePosition), 0);
    const ok = await askConfirm('全平 ' + sym.split('.')[0] + ' 共 ' + total + ' 手？');
    if (!ok) return;
    const q = await getQuote(sym, true);
    if (!q) { toast('行情获取失败', 'err'); return; }
    const meta = metaOf(sym);
    for (const r of rows) {
      const side = num(r.side) === 1 ? 2 : 1; // 多头→卖出平仓
      const price = makePrice(q, meta, side);
      try {
        await submitOrder({ sym: sym, side: side, pe: cfg.closeType, qty: num(r.usablePosition), price: price, text: '一键全平' });
      } catch (e) {
        toast('全平出错：' + e.message, 'err');
      }
      await sleep(180);
    }
    if (PROT && PROT.sym === sym) {
      PROT = null;
      saveProt();
      renderRiskTab();
      pushLog('保护', '已全平，保护单解除');
    }
  }

  async function cancelAll(sym) {
    const uid = getUserId();
    if (!uid) { toast('未识别交易账号', 'err'); return; }
    const fin = isFinMkt(sym);
    const js = await apiGet(fin ? '/VERace/FinFutQuery/QueryFinFutCurOrdList' : '/VERace/FutQuery/QueryFutCurOrdList',
      { UserID: uid, PageIndex: 1, PageSize: 500 });
    const list = (js && js.data) || [];
    const rows = list.filter((r) => {
      if ((r.securityID + '.' + r.market) !== sym) return false;
      const rest = num(r.orderQty) - num(r.cumQty) - num(r.cancelQty);
      return rest > 0;
    });
    if (!rows.length) { toast('当前合约没有可撤委托', 'warn'); return; }
    let ok = 0, bad = 0;
    for (const r of rows) {
      try {
        const res = await apiPost(fin ? '/VERace/FinFutTrade/CancelFinFutOrder' : '/VERace/FutTrade/CancelFutOrder', {
          userID: uid,
          origClOrdId: r.clOrdID,
          market: r.market,
          security: r.securityID + '.' + r.market
        });
        if (isOk(res)) ok++; else bad++;
      } catch (e) { bad++; }
      await sleep(120);
    }
    toast('撤单完成：成功 ' + ok + (bad ? '，失败 ' + bad : ''), bad ? 'warn' : 'ok');
    pushLog('撤单', sym.split('.')[0] + ' 成功' + ok + ' 失败' + bad);
  }

  /* ============================================================
   * 9. 布林带（3 分钟窗口 · 每秒成交价）
   * ============================================================ */
  const SERIES = new Map(); // sym -> [{t,p}]

  function pushSample(sym, p) {
    if (!isFinite(p) || p <= 0) return;
    let arr = SERIES.get(sym);
    if (!arr) { arr = []; SERIES.set(sym, arr); }
    const now = Date.now();
    const last = arr[arr.length - 1];
    if (last && cfg.sample === 'tick' && last.p === p && now - last.t < 5000) return; // 价格未变则不重复记
    arr.push({ t: now, p: p });
    const cut = now - (cfg.winSec + 30) * 1000;
    while (arr.length && arr[0].t < cut) arr.shift();
  }

  function bollStats(arr) {
    const now = Date.now();
    const from = now - cfg.winSec * 1000;
    const w = arr.filter((x) => x.t >= from);
    const n = w.length;
    if (n < 3) return { n: n, mean: NaN, sd: NaN, up: NaN, dn: NaN, w: w };
    let s = 0;
    for (let i = 0; i < n; i++) s += w[i].p;
    const mean = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (w[i].p - mean) * (w[i].p - mean);
    const sd = Math.sqrt(v / n);
    return { n: n, mean: mean, sd: sd, up: mean + 2 * sd, dn: mean - 2 * sd, w: w };
  }

  /* ============================================================
   * 10. UI
   * ============================================================ */
  const CSS = `
  #qd-panel{position:fixed;right:14px;top:${cfg.py}px;width:326px;z-index:2147483000;
    background:#161c2b;border:1px solid #2b3550;border-radius:10px;
    box-shadow:0 10px 30px rgba(0,0,0,.45);color:#dfe6f5;font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif;
    user-select:none;}
  #qd-panel *{box-sizing:border-box;}
  #qd-head{display:flex;align-items:center;gap:6px;padding:7px 9px;cursor:move;
    background:linear-gradient(180deg,#1e2740,#1a2136);border-radius:10px 10px 0 0;border-bottom:1px solid #2b3550;}
  #qd-head b{font-size:12px;color:#8fa6d8;font-weight:600;letter-spacing:.5px;}
  #qd-head .qd-sp{flex:1}
  #qd-head button{background:none;border:none;color:#7f8db0;cursor:pointer;font-size:13px;padding:2px 5px;border-radius:4px;}
  #qd-head button:hover{background:#2b3550;color:#fff;}
  #qd-body{padding:8px 9px 10px;max-height:calc(100vh - 150px);overflow-y:auto;overflow-x:hidden;}
  #qd-body::-webkit-scrollbar{width:5px;}
  #qd-body::-webkit-scrollbar-thumb{background:#2b3550;border-radius:3px;}
  #qd-body::-webkit-scrollbar-track{background:transparent;}
  #qd-panel.qd-collapsed #qd-body{display:none;}
  .qd-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
  .qd-lab{color:#7f8db0;width:34px;flex:none;font-size:11px;}
  .qd-sym{flex:1;position:relative;}
  .qd-sym input{width:100%;background:#0f1421;border:1px solid #2b3550;color:#dfe6f5;
    border-radius:5px;padding:4px 6px;font:12px/1.4 inherit;outline:none;}
  .qd-sym input:focus{border-color:#3d7eff;}
  .qd-sug{position:absolute;left:0;right:0;top:100%;margin-top:2px;background:#0f1421;border:1px solid #2b3550;
    border-radius:6px;max-height:190px;overflow:auto;z-index:10;display:none;}
  .qd-sug .it{padding:4px 7px;cursor:pointer;display:flex;gap:6px;}
  .qd-sug .it:hover,.qd-sug .it.on{background:#25304a;}
  .qd-sug .it i{color:#7f8db0;font-style:normal;font-size:11px;}
  .qd-px{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;margin-left:auto;color:#e8453c;}
  .qd-px.dn{color:#22a06b;}
  .qd-step{display:flex;align-items:center;background:#0f1421;border:1px solid #2b3550;border-radius:5px;overflow:hidden;}
  .qd-step button{background:none;border:none;color:#8fa6d8;width:20px;height:23px;cursor:pointer;font-size:13px;line-height:1;}
  .qd-step button:hover{background:#25304a;}
  .qd-step input{width:44px;background:none;border:none;color:#dfe6f5;text-align:center;font:12px inherit;outline:none;
    -moz-appearance:textfield;}
  .qd-step input::-webkit-outer-spin-button,.qd-step input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
  .qd-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:7px 0 6px;}
  .qd-b{position:relative;border:none;border-radius:6px;padding:9px 4px 8px;cursor:pointer;color:#fff;
    font:600 13px/1.2 inherit;text-align:center;transition:filter .12s;}
  .qd-b small{display:block;font-size:10px;font-weight:400;opacity:.85;margin-top:1px;font-variant-numeric:tabular-nums;}
  .qd-b:hover{filter:brightness(1.15);}
  .qd-b:active{transform:translateY(1px);}
  .qd-b.buy{background:linear-gradient(180deg,#e8453c,#cf382f);}
  .qd-b.sell{background:linear-gradient(180deg,#22a06b,#1a8a59);}
  .qd-b.flat{background:#3a4560;font-size:12px;padding:6px 4px;}
  .qd-b:disabled{opacity:.45;cursor:not-allowed;}
  .qd-mini{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;}
  .qd-mini .qd-b{font-size:11px;padding:6px 2px;}
  .qd-b.o{background:#25304a;border:1px solid #33405e;}
  .qd-b.on{background:#2f4a7a;border:1px solid #4a6ea8;}
  #qd-set{border-top:1px dashed #2b3550;margin-top:7px;padding-top:7px;display:none;}
  #qd-set.show{display:block;}
  .qd-f{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px;color:#9fb0d0;}
  .qd-f select,.qd-f input[type=text]{background:#0f1421;border:1px solid #2b3550;color:#dfe6f5;border-radius:4px;
    padding:2px 4px;font:11px inherit;outline:none;}
  .qd-f label{display:flex;align-items:center;gap:3px;cursor:pointer;}
  #qd-boll{margin-top:8px;border-top:1px dashed #2b3550;padding-top:7px;}
  #qd-boll .hd{display:flex;align-items:center;gap:6px;color:#7f8db0;font-size:11px;margin-bottom:4px;}
  #qd-boll canvas{width:100%;height:132px;display:block;border-radius:6px;background:#0f1421;}
  #qd-boll .st{display:flex;justify-content:space-between;margin-top:4px;font-size:11px;color:#9fb0d0;
    font-variant-numeric:tabular-nums;}
  #qd-log{margin-top:6px;padding-bottom:3px;font-size:10px;color:#6b7a99;max-height:52px;overflow:hidden;line-height:1.5;}
  #qd-log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  /* ---- 页签 ---- */
  #qd-tabs{display:flex;gap:4px;margin:2px 0 8px;background:#0f1421;padding:3px;border-radius:6px;}
  #qd-tabs button{flex:1;border:none;background:none;color:#7f8db0;font:12px/1.5 inherit;padding:4px 0;
    border-radius:4px;cursor:pointer;position:relative;transition:.12s;}
  #qd-tabs button:hover{color:#c3cfe6;}
  #qd-tabs button.on{background:#25304a;color:#fff;font-weight:600;}
  #qd-tabs .dot{position:absolute;top:4px;right:12px;width:6px;height:6px;border-radius:50%;background:#22a06b;
    box-shadow:0 0 5px #22a06b;display:none;}
  #qd-tabs .dot.on{display:block;}
  .qd-tab{display:none;}
  .qd-tab.on{display:block;}

  /* ---- 通用小控件 ---- */
  .qd-inp{background:#0f1421;border:1px solid #2b3550;border-radius:5px;padding:3px 5px;color:#dfe6f5;
    font:11px inherit;outline:none;text-align:center;}
  .qd-inp:focus{border-color:#3d7eff;}
  .qd-u{color:#7f8db0;font-size:10px;flex:none;}
  .qd-hint{color:#8fa6d8;font-size:10px;margin-left:auto;font-variant-numeric:tabular-nums;}
  .qd-hint2{color:#7f8db0;font-size:10px;line-height:1.7;margin:3px 0 0;}
  .qd-sub{border-top:1px dashed #2b3550;margin:9px 0 6px;padding-top:7px;font-size:10px;color:#5d6b8a;
    letter-spacing:.5px;}
  .qd-btn-xs{background:#25304a;border:1px solid #33405e;color:#c3cfe6;border-radius:5px;padding:3px 9px;
    font:11px inherit;cursor:pointer;}
  .qd-btn-xs:hover{background:#2f4a7a;}
  .qd-b.arm{background:linear-gradient(180deg,#2f6fd0,#255bb0);font-size:12px;padding:7px 4px;}
  .qd-b.dis{background:#25304a;border:1px solid #33405e;font-size:12px;padding:6px 4px;}

  /* ---- 反手按钮 / 品种信息 ---- */
  .qd-b.rev{width:100%;margin:6px 0 0;background:linear-gradient(180deg,#6a4bd0,#5638b5);
    font-size:12px;padding:8px 4px;letter-spacing:.3px;}
  .qd-info{font-size:10px;color:#6b7a99;margin:5px 0 1px;text-align:center;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;}
  .qd-info b{color:#9fb0d0;font-weight:500;}

  /* ---- 风控：持仓方向 / 信号栏 ---- */
  .qd-riskpos{font-size:11px;padding:6px 8px;border-radius:5px;background:#0f1421;margin-bottom:8px;
    color:#9fb0d0;line-height:1.6;border-left:3px solid #2b3550;}
  .qd-riskpos.long{border-left-color:#e8453c;}
  .qd-riskpos.short{border-left-color:#22a06b;}
  .qd-riskpos.none{border-left-color:#3a4560;color:#6b7a99;}
  .qd-riskpos b{font-weight:600;}
  .qd-riskpos .u{color:#e8453c;}
  .qd-riskpos .d{color:#22a06b;}
  .qd-signal{margin-top:6px;display:flex;gap:4px;font-size:9px;font-variant-numeric:tabular-nums;}
  .qd-signal span{flex:1;text-align:center;padding:4px 1px;border-radius:4px;background:#0f1421;
    color:#7f8db0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .qd-signal span.up{color:#ff8a80;background:#2a1614;}
  .qd-signal span.dn{color:#5fd39b;background:#0f2a20;}
  .qd-signal span.warn{color:#e0b46f;background:#2a2110;}

  /* ---- 保护单状态条 ---- */
  .qd-armed{margin-top:6px;font-size:10px;line-height:1.7;padding:5px 7px;border-radius:5px;
    background:#12301f;color:#5fd39b;border-left:2px solid #22a06b;display:none;}
  .qd-armed.on{display:block;}
  .qd-armed.warn{background:#3a2a12;color:#e0b46f;border-left-color:#b8791a;}
  .qd-armed b{color:#fff;font-weight:600;}

  /* ---- 持仓表 ---- */
  #qd-pos-list{margin-bottom:6px;}
  #qd-pos-list .pr{display:flex;align-items:center;gap:5px;font-size:10px;padding:3px 4px;border-radius:4px;
    font-variant-numeric:tabular-nums;}
  #qd-pos-list .pr.cur{background:#1e2740;}
  #qd-pos-list .pr .s{flex:1;color:#c3cfe6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #qd-pos-list .pr .d{width:22px;flex:none;text-align:center;border-radius:3px;font-size:9px;line-height:15px;}
  #qd-pos-list .pr .d.l{background:#4a1e1c;color:#ff8a80;}
  #qd-pos-list .pr .d.s{background:#10352a;color:#5fd39b;}
  #qd-pos-list .pr .n{width:34px;text-align:right;color:#fff;}
  #qd-pos-list .pr .a{width:52px;text-align:right;color:#9fb0d0;}
  #qd-pos-list .pr .p{width:54px;text-align:right;}
  #qd-pos-list .pr .p.up{color:#e8453c;}
  #qd-pos-list .pr .p.dn{color:#22a06b;}
  #qd-pos-list .pr2{font-size:9px;line-height:1.7;padding:0 4px 3px 32px;color:#e0b46f;}
  #qd-pos-list .pr2 b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums;}
  #qd-pos-list .pr2 i{font-style:normal;color:#7f8db0;}
  #qd-confirm{position:absolute;left:0;right:0;bottom:0;background:#1e2740;border-top:1px solid #3d7eff;
    padding:8px 9px;border-radius:0 0 10px 10px;display:none;z-index:5;box-shadow:0 -6px 16px rgba(0,0,0,.5);}
  #qd-confirm.show{display:block;}
  #qd-confirm .t{font-size:12px;margin-bottom:6px;color:#fff;}
  #qd-confirm .a{display:flex;gap:6px;}
  #qd-confirm .a button{flex:1;border:none;border-radius:5px;padding:6px;cursor:pointer;font:600 12px inherit;}
  #qd-confirm .a .y{background:#3d7eff;color:#fff;}
  #qd-confirm .a .n{background:#2b3550;color:#c3cfe6;}
  #qd-toast{position:fixed;right:14px;top:calc(${cfg.py}px - 4px);transform:translateY(-100%);z-index:2147483100;
    display:flex;flex-direction:column;gap:5px;align-items:flex-end;pointer-events:none;}
  .qd-t{padding:6px 11px;border-radius:6px;font:12px/1.4 -apple-system,"Microsoft YaHei",sans-serif;color:#fff;
    box-shadow:0 4px 14px rgba(0,0,0,.4);max-width:340px;animation:qdin .16s ease-out;}
  .qd-t.ok{background:#1a8a59;}
  .qd-t.err{background:#cf382f;}
  .qd-t.warn{background:#b8791a;}
  .qd-t.info{background:#3d7eff;}
  @keyframes qdin{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  `;

  let $root = null, $qty, $off, $sym, $px, $boll, $stat, $log, $conf;
  let $sl, $tp, $tr, $risk, $armed, $posList, $sugg, $dot, $trailOn;
  let quoteNow = null, quoteSym = '';
  let confirmResolve = null;

  function h(tag, cls, html) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  }

  function buildUI() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    const p = h('div', '');
    p.id = 'qd-panel';
    if (cfg.collapsed) p.classList.add('qd-collapsed');
    p.innerHTML = `
      <div id="qd-head">
        <b>⚡ 一键下单</b>
        <span class="qd-sp"></span>
        <span id="qd-uid" style="font-size:10px;color:#5d6b8a"></span>
        <button id="qd-min" title="折叠">—</button>
      </div>
      <div id="qd-body">
        <div class="qd-row">
          <span class="qd-lab">合约</span>
          <div class="qd-sym">
            <input id="qd-sym" type="text" placeholder="跟随页面（可输入代码/中文名）" spellcheck="false" />
            <div class="qd-sug" id="qd-sug"></div>
          </div>
          <span class="qd-px" id="qd-px">--</span>
        </div>
        <div id="qd-tabs">
          <button data-tab="trade" class="on">下单</button>
          <button data-tab="risk">风控<span class="dot" id="qd-dot"></span></button>
          <button data-tab="pos">持仓</button>
        </div>

        <div id="qd-tab-trade" class="qd-tab on">
          <div class="qd-row">
            <span class="qd-lab">手数</span>
            <span class="qd-step"><button data-step="lots:-1">−</button><input id="qd-qty" type="text" /><button data-step="lots:1">+</button></span>
            <span class="qd-lab" style="width:auto;margin-left:6px" title="正数=追价(更容易成交) 负数=挂单等回调">偏移</span>
            <span class="qd-step"><button data-step="off:-1">−</button><input id="qd-off" type="text" /><button data-step="off:1">+</button></span>
            <span id="qd-unit" style="color:#7f8db0;font-size:11px">跳</span>
          </div>
          <div class="qd-btns">
            <button class="qd-b buy"  data-act="1:1">买开<small id="qd-p1">--</small></button>
            <button class="qd-b sell" data-act="2:1">卖开<small id="qd-p2">--</small></button>
            <button class="qd-b buy"  data-act="1:2" style="opacity:.92">买平<small id="qd-p3">--</small></button>
            <button class="qd-b sell" data-act="2:2" style="opacity:.92">卖平<small id="qd-p4">--</small></button>
          </div>
          <button class="qd-b rev" id="qd-reverse">⇄ 一键反手</button>
          <div class="qd-info" id="qd-info">--</div>
          <div class="qd-mini">
            <button class="qd-b flat" id="qd-closeall">全部平仓</button>
            <button class="qd-b flat" id="qd-cancelall">撤本合约单</button>
            <button class="qd-b flat" id="qd-gear">设置 ⚙</button>
          </div>
          <div id="qd-set">
            <div class="qd-f"><span>基准</span>
              <select id="qd-base"><option value="counter">对手价</option><option value="last">最新价</option></select>
              <span>委托</span>
              <select id="qd-otype"><option value="limit">限价</option><option value="market">市价(仅郑商/大商)</option></select>
            </div>
            <div class="qd-f"><span>平仓</span>
              <select id="qd-ctype"><option value="2">平仓</option><option value="3">平今(上期/能源)</option></select>
              <span>单位</span>
              <select id="qd-ounit"><option value="tick">跳</option><option value="price">价格</option></select>
            </div>
            <div class="qd-f">
              <label><input type="checkbox" id="qd-fast" /> 极速模式</label>
              <label><input type="checkbox" id="qd-dry" /> 试运行</label>
              <label title="切到后台后保持 1 秒行情刷新；关掉则会被浏览器降频"><input type="checkbox" id="qd-keep" /> 后台保活</label>
              <label title="用隐藏 iframe 加载分时图，读取总手/总额算真 VWAP。关掉后改用 TWAP"><input type="checkbox" id="qd-vwap" /> VWAP</label>
            </div>
            <div class="qd-f">
              <label><input type="checkbox" id="qd-autoarm" /> 反手后自动挂保护</label>
            </div>
            <div class="qd-f"><span>单笔上限</span>
              <span class="qd-step"><button data-step="max:-1">−</button><input id="qd-max" type="text" /><button data-step="max:1">+</button></span>
              <span>布林窗口</span>
              <span class="qd-step"><button data-step="win:-30">−</button><input id="qd-win" type="text" /><button data-step="win:30">+</button></span>
              <span style="color:#5d6b8a">秒</span>
            </div>
            <div style="font-size:10px;color:#5d6b8a;line-height:1.6;margin:2px 0 4px">
              偏移：正数=追价（买在卖一+N跳 / 卖在买一−N跳），负数=挂单等回调。
            </div>
            <div class="qd-f"><span>交易账号</span>
              <input id="qd-uid-in" type="text" placeholder="留空=自动识别" spellcheck="false" style="flex:1" />
            </div>
          </div>
        </div>

        <div id="qd-tab-risk" class="qd-tab">
          <div class="qd-riskpos" id="qd-risk-pos">无持仓</div>
          <div class="qd-f"><span>止损</span>
            <span class="qd-step"><button data-step="sl:-1">−</button><input id="qd-sl" class="qd-inp" style="width:34px" /><button data-step="sl:1">+</button></span>
            <span class="qd-u">跳</span>
            <span class="qd-hint" id="qd-slpx">--</span>
          </div>
          <div class="qd-f"><span>止盈</span>
            <span class="qd-step"><button data-step="tp:-1">−</button><input id="qd-tp" class="qd-inp" style="width:34px" /><button data-step="tp:1">+</button></span>
            <span class="qd-u">跳</span>
            <span class="qd-hint" id="qd-tppx">--</span>
          </div>
          <div class="qd-f"><span>移动</span>
            <span class="qd-step"><button data-step="tr:-1">−</button><input id="qd-tr" class="qd-inp" style="width:34px" /><button data-step="tr:1">+</button></span>
            <span class="qd-u">跳回撤</span>
            <label style="margin-left:auto"><input type="checkbox" id="qd-trailon" /> 启用</label>
          </div>
          <div class="qd-btns" style="margin:7px 0 4px">
            <button class="qd-b arm" id="qd-arm">挂上保护</button>
            <button class="qd-b dis" id="qd-disarm">撤销保护</button>
          </div>
          <div class="qd-armed" id="qd-armed"></div>
          <div class="qd-sub">按金额算手数</div>
          <div class="qd-f"><span>最多亏</span>
            <input id="qd-risk" class="qd-inp" style="width:56px" />
            <span class="qd-u">元</span>
            <button class="qd-btn-xs" id="qd-calc" style="margin-left:auto">换算手数</button>
          </div>
          <div class="qd-hint2" id="qd-sugg">跳数按<b>开仓均价</b>换算（无持仓时用现价）；<br>手数 = 最多亏损 ÷（每跳价值 × 止损跳数）。</div>
        </div>

        <div id="qd-tab-pos" class="qd-tab">
          <div id="qd-pos-list"></div>
          <div class="qd-f" style="margin-top:6px">
            <button class="qd-btn-xs" id="qd-pos-refresh">刷新</button>
            <span class="qd-hint2" id="qd-pos-time" style="margin-left:auto"></span>
          </div>
        </div>

        <div id="qd-boll">
          <div class="hd"><span id="qd-bollt">3分钟布林（每秒成交价）</span><span style="margin-left:auto" id="qd-n"></span></div>
          <canvas id="qd-canvas"></canvas>
          <div class="st"><span id="qd-up">上 --</span><span id="qd-mid">中 --</span><span id="qd-dn">下 --</span></div>
          <div class="qd-signal" id="qd-signal"><span>均价 --</span><span>动能 --</span><span>位置 --</span></div>
        </div>
        <div id="qd-log"></div>
      </div>
      <div id="qd-confirm"><div class="t"></div><div class="a"><button class="y">确认下单 (Enter)</button><button class="n">取消 (Esc)</button></div></div>
    `;
    document.body.appendChild(p);
    $root = p;

    const t = h('div', '');
    t.id = 'qd-toast';
    document.body.appendChild(t);

    $qty = p.querySelector('#qd-qty');
    $off = p.querySelector('#qd-off');
    $sym = p.querySelector('#qd-sym');
    $px = p.querySelector('#qd-px');
    $boll = p.querySelector('#qd-canvas');
    $stat = { up: p.querySelector('#qd-up'), mid: p.querySelector('#qd-mid'), dn: p.querySelector('#qd-dn'), n: p.querySelector('#qd-n') };
    $log = p.querySelector('#qd-log');
    $conf = p.querySelector('#qd-confirm');
    $sl = p.querySelector('#qd-sl');
    $tp = p.querySelector('#qd-tp');
    $tr = p.querySelector('#qd-tr');
    $risk = p.querySelector('#qd-risk');
    $armed = p.querySelector('#qd-armed');
    $posList = p.querySelector('#qd-pos-list');
    $sugg = p.querySelector('#qd-sugg');
    $dot = p.querySelector('#qd-dot');
    $trailOn = p.querySelector('#qd-trailon');

    bindUI();
  }

  function bindUI() {
    const p = $root;

    // 拖动
    const head = p.querySelector('#qd-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = { y: e.clientY, top: p.getBoundingClientRect().top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      let top = drag.top + (e.clientY - drag.y);
      top = Math.max(4, Math.min(window.innerHeight - 60, top));
      p.style.top = top + 'px';
      cfg.py = top;
    });
    document.addEventListener('mouseup', () => { if (drag) { drag = null; saveCfg(); } });

    p.querySelector('#qd-min').addEventListener('click', () => {
      p.classList.toggle('qd-collapsed');
      cfg.collapsed = p.classList.contains('qd-collapsed');
      saveCfg();
    });
    p.querySelector('#qd-gear').addEventListener('click', () => {
      p.querySelector('#qd-set').classList.toggle('show');
      loadMeta();
    });

    // 步进
    p.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [k, d] = btn.dataset.step.split(':');
        const del = Number(d);
        if (k === 'lots') {
          cfg.lots = Math.max(1, Math.min(cfg.maxLots, cfg.lots + del));
          $qty.value = cfg.lots;
        } else if (k === 'off') {
          cfg.offset = Number(Math.max(-999, Math.min(9999, cfg.offset + del * (cfg.offsetUnit === 'tick' ? 1 : 0.01))).toFixed(4));
          $off.value = cfg.offset;
        } else if (k === 'max') {
          cfg.maxLots = Math.max(1, Math.min(999, cfg.maxLots + del));
          p.querySelector('#qd-max').value = cfg.maxLots;
        } else if (k === 'win') {
          cfg.winSec = Math.max(30, Math.min(1800, cfg.winSec + del));
          p.querySelector('#qd-win').value = cfg.winSec;
        } else if (k === 'sl') {
          cfg.slTicks = Math.max(0, Math.min(9999, cfg.slTicks + del));
          $sl.value = cfg.slTicks;
        } else if (k === 'tp') {
          cfg.tpTicks = Math.max(0, Math.min(9999, cfg.tpTicks + del));
          $tp.value = cfg.tpTicks;
        } else if (k === 'tr') {
          cfg.trailTicks = Math.max(1, Math.min(9999, cfg.trailTicks + del));
          $tr.value = cfg.trailTicks;
        }
        saveCfg(); syncLabels(); renderPrices();
      });
    });

    $qty.addEventListener('change', () => {
      let v = Math.floor(num($qty.value));
      if (!isFinite(v) || v < 1) v = 1;
      if (v > cfg.maxLots) { v = cfg.maxLots; toast('超过单笔上限 ' + cfg.maxLots + ' 手', 'warn'); }
      cfg.lots = v; $qty.value = v; saveCfg(); syncLabels();
    });
    $off.addEventListener('change', () => {
      let v = num($off.value);
      if (!isFinite(v)) v = 0;
      cfg.offset = v; $off.value = v; saveCfg(); syncLabels(); renderPrices();
    });

    // 设置项
    const s = p.querySelector('#qd-set');
    s.querySelector('#qd-base').value = cfg.base;
    s.querySelector('#qd-otype').value = cfg.orderType;
    s.querySelector('#qd-ctype').value = String(cfg.closeType);
    s.querySelector('#qd-ounit').value = cfg.offsetUnit;
    s.querySelector('#qd-fast').checked = cfg.fastMode;
    s.querySelector('#qd-dry').checked = cfg.dryRun;

    s.querySelector('#qd-base').addEventListener('change', (e) => { cfg.base = e.target.value; saveCfg(); renderPrices(); });
    s.querySelector('#qd-otype').addEventListener('change', (e) => {
      cfg.orderType = e.target.value; saveCfg(); renderPrices();
      if (cfg.orderType === 'market') toast('市价单仅郑商所/大商所支持，其余交易所自动用对手价限价', 'info');
    });
    s.querySelector('#qd-ctype').addEventListener('change', (e) => { cfg.closeType = Number(e.target.value); saveCfg(); });
    s.querySelector('#qd-ounit').addEventListener('change', (e) => {
      cfg.offsetUnit = e.target.value;
      cfg.offset = cfg.offsetUnit === 'tick' ? 1 : 0;
      $off.value = cfg.offset; saveCfg(); syncLabels(); renderPrices();
    });
    s.querySelector('#qd-fast').addEventListener('change', (e) => { cfg.fastMode = e.target.checked; saveCfg(); });
    s.querySelector('#qd-dry').addEventListener('change', (e) => { cfg.dryRun = e.target.checked; saveCfg(); });
    s.querySelector('#qd-autoarm').checked = cfg.autoArm !== false;
    s.querySelector('#qd-vwap').checked = cfg.vwap !== false;
    s.querySelector('#qd-vwap').addEventListener('change', (e) => {
      cfg.vwap = e.target.checked;
      saveCfg();
      if (!cfg.vwap && VW.frame) {
        try { VW.frame.remove(); } catch (err) {}
        VW.frame = null; VW.sym = ''; VW.vwap = NaN;
      }
    });
    s.querySelector('#qd-keep').checked = cfg.keepAlive !== false;
    s.querySelector('#qd-keep').addEventListener('change', (e) => {
      cfg.keepAlive = e.target.checked;
      saveCfg();
      if (cfg.keepAlive) startKeepAlive(); else if (KA) { try { KA.src.stop(); KA.ctx.close(); } catch (err) {} KA = null; }
    });
    s.querySelector('#qd-autoarm').addEventListener('change', (e) => { cfg.autoArm = e.target.checked; saveCfg(); });

    const uidIn = s.querySelector('#qd-uid-in');
    uidIn.value = cfg.uid || '';
    uidIn.addEventListener('change', () => {
      cfg.uid = uidIn.value.trim();
      saveCfg();
      toast(cfg.uid ? '已固定账号：' + cfg.uid : '已恢复自动识别账号', 'info');
    });

    // 下单按钮
    p.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // 避免抢焦点
      btn.addEventListener('click', () => {
        const [side, pe] = btn.dataset.act.split(':').map(Number);
        doTrade(side, pe);
      });
    });
    p.querySelector('#qd-closeall').addEventListener('click', async () => {
      const sym = currentSym();
      if (!sym) return toast('未识别合约', 'err');
      try { await closeAll(sym); } catch (e) { toast(e.message, 'err'); }
    });
    p.querySelector('#qd-cancelall').addEventListener('click', async () => {
      const sym = currentSym();
      if (!sym) return toast('未识别合约', 'err');
      try { await cancelAll(sym); } catch (e) { toast(e.message, 'err'); }
    });

    // 确认条
    $conf.querySelector('.y').addEventListener('click', () => resolveConfirm(true));
    $conf.querySelector('.n').addEventListener('click', () => resolveConfirm(false));

    // 合约输入
    let sugT = null;
    $sym.addEventListener('input', () => {
      clearTimeout(sugT);
      sugT = setTimeout(() => showSuggest($sym.value.trim()), 120);
    });
    $sym.addEventListener('focus', () => { loadMeta(); });
    $sym.addEventListener('blur', () => setTimeout(() => { p.querySelector('#qd-sug').style.display = 'none'; }, 180));
    $sym.addEventListener('change', () => {
      const v = $sym.value.trim();
      const m = v.match(/^([A-Za-z0-9]+)\.([A-Z]{2,6})$/);
      if (m) { cfg.sym = m[1].toUpperCase() + '.' + m[2].toUpperCase(); saveCfg(); renderPrices(); return; }
      if (!v) { cfg.sym = ''; saveCfg(); renderPrices(); return; }
      const hit = pickFromMeta(v);
      if (hit) { cfg.sym = hit.security; $sym.value = hit.security; saveCfg(); renderPrices(); }
      else { toast('没找到合约「' + v + '」，已恢复跟随页面', 'warn'); cfg.sym = ''; $sym.value = ''; saveCfg(); }
    });

    // 页签
    p.querySelectorAll('#qd-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
    });

    // 风控输入
    $sl.addEventListener('change', function () {
      let v = Math.floor(num($sl.value)); if (!isFinite(v) || v < 0) v = 0;
      cfg.slTicks = v; $sl.value = v; saveCfg(); renderRiskHints();
    });
    $tp.addEventListener('change', function () {
      let v = Math.floor(num($tp.value)); if (!isFinite(v) || v < 0) v = 0;
      cfg.tpTicks = v; $tp.value = v; saveCfg(); renderRiskHints();
    });
    $tr.addEventListener('change', function () {
      let v = Math.floor(num($tr.value)); if (!isFinite(v) || v < 1) v = 1;
      cfg.trailTicks = v; $tr.value = v; saveCfg(); renderRiskHints();
    });
    $risk.addEventListener('change', function () {
      let v = Math.round(num($risk.value)); if (!isFinite(v) || v < 0) v = 0;
      cfg.riskCash = v; $risk.value = v; saveCfg();
    });
    $trailOn.addEventListener('change', function () {
      cfg.trailOn = $trailOn.checked; saveCfg(); renderRiskHints();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) wake = true;    // 切回前台立刻跑一次，不等定时器
      else startKeepAlive();
    });

    // 首次交互后启动后台保活（AudioContext 需要用户手势才能 resume）
    p.addEventListener('mousedown', function once() {
      p.removeEventListener('mousedown', once);
      startKeepAlive();
    });

    // 反手
    p.querySelector('#qd-reverse').addEventListener('mousedown', function (e) { e.preventDefault(); });
    p.querySelector('#qd-reverse').addEventListener('click', function () { doReverse(); });

    // 保护单 / 算手数 / 持仓刷新
    p.querySelector('#qd-arm').addEventListener('click', function () { armProtect(); });
    p.querySelector('#qd-disarm').addEventListener('click', function () { disarmProtect(); });
    p.querySelector('#qd-calc').addEventListener('click', function () { calcLotsByRisk(); });
    p.querySelector('#qd-pos-refresh').addEventListener('click', function () { refreshPos(true); });


    // 初始化控件值
    $qty.value = cfg.lots;
    $off.value = cfg.offset;
    $sym.value = cfg.sym || '';
    $sl.value = cfg.slTicks;
    $tp.value = cfg.tpTicks;
    $tr.value = cfg.trailTicks;
    $risk.value = cfg.riskCash;
    $trailOn.checked = !!cfg.trailOn;
    renderReverseBtn();
    p.querySelector('#qd-max').value = cfg.maxLots;
    p.querySelector('#qd-win').value = cfg.winSec;
    syncLabels();
  }

  function switchTab(name) {
    if (!$root || !name) return;
    cfg.tab = name;
    saveCfg();
    $root.querySelectorAll('#qd-tabs button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    $root.querySelectorAll('.qd-tab').forEach(function (t) {
      t.classList.toggle('on', t.id === 'qd-tab-' + name);
    });
    if (name === 'pos') refreshPos(true);
    if (name === 'risk') { renderRiskTab(); renderRiskHints(); }
    setTimeout(drawBoll, 30);
  }

  function syncLabels() {
    if (!$root) return;
    $root.querySelector('#qd-unit').textContent = cfg.offsetUnit === 'tick' ? '跳' : '元';
    $root.querySelector('#qd-bollt').textContent = (cfg.winSec / 60) + '分钟布林（每秒成交价）';
  }

  function pickFromMeta(q) {
    if (!META) return null;
    const s = String(q).toUpperCase();
    let exact = null, fuzzy = null;
    for (let i = 0; i < META.length; i++) {
      const m = META[i];
      if (m.securityID.toUpperCase() === s) { exact = m; break; }
      if (!fuzzy && (m.shortName.indexOf(q) >= 0 || m.securityID.toUpperCase().indexOf(s) >= 0)) fuzzy = m;
    }
    return exact || fuzzy;
  }

  function showSuggest(q) {
    const box = $root.querySelector('#qd-sug');
    if (!q || !META) { box.style.display = 'none'; return; }
    const s = q.toUpperCase();
    const out = [];
    for (let i = 0; i < META.length && out.length < 8; i++) {
      const m = META[i];
      if (m.securityID.toUpperCase().indexOf(s) >= 0 || m.shortName.indexOf(q) >= 0) out.push(m);
    }
    if (!out.length) { box.style.display = 'none'; return; }
    box.innerHTML = out.map((m) => '<div class="it" data-s="' + m.security + '"><span>' + esc(m.shortName) + '</span><i>' + esc(m.security) + '</i></div>').join('');
    box.style.display = 'block';
    box.querySelectorAll('.it').forEach((it) => {
      it.addEventListener('mousedown', (e) => {
        e.preventDefault();
        cfg.sym = it.dataset.s;
        $sym.value = cfg.sym;
        box.style.display = 'none';
        saveCfg(); renderPrices();
      });
    });
  }

  /* ---------------- toast / 日志 ---------------- */
  function toast(msg, type) {
    const box = document.getElementById('qd-toast');
    if (!box) return;
    const el = h('div', 'qd-t ' + (type || 'info'), esc(msg));
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 2600);
  }

  const LOGS = [];
  function pushLog(tag, msg) {
    LOGS.unshift(hms(Date.now()) + ' [' + tag + '] ' + msg);
    if (LOGS.length > 4) LOGS.pop();
    if ($log) $log.innerHTML = LOGS.map((x) => '<div>' + esc(x) + '</div>').join('');
  }

  /* ---------------- 确认 ---------------- */
  function askConfirm(text) {
    if (!$conf) return Promise.resolve(false);
    $conf.querySelector('.t').textContent = text;
    $conf.classList.add('show');
    return new Promise((res) => { confirmResolve = res; });
  }
  function resolveConfirm(v) {
    if (!$conf) return;
    $conf.classList.remove('show');
    const fn = confirmResolve; confirmResolve = null;
    if (fn) fn(v);
  }

  /* ---------------- 下单动作 ---------------- */
  let lastKey = '', lastAt = 0, sending = false;

  // 点击按钮前先把输入框里的值落实（防止 focus 未离开导致 change 未触发）
  function commitInputs() {
    if ($qty) {
      let v = Math.floor(num($qty.value));
      if (!isFinite(v) || v < 1) v = 1;
      if (v > cfg.maxLots) { v = cfg.maxLots; toast('超过单笔上限 ' + cfg.maxLots + ' 手', 'warn'); }
      cfg.lots = v;
      $qty.value = v;
    }
    if ($off) {
      let o = num($off.value);
      if (!isFinite(o)) o = 0;
      cfg.offset = o;
      $off.value = o;
    }
    if ($sym) {
      const v = $sym.value.trim();
      if (!v) { cfg.sym = ''; }
      else if (v !== cfg.sym) {
        const m = v.match(/^([A-Za-z0-9]+)\.([A-Z]{2,6})$/);
        if (m) cfg.sym = m[1].toUpperCase() + '.' + m[2].toUpperCase();
        else {
          const hit = pickFromMeta(v);
          if (hit) { cfg.sym = hit.security; $sym.value = hit.security; }
        }
      }
    }
    syncVariety();
    saveCfg();
  }

  async function doTrade(side, pe) {
    if (sending) return;
    commitInputs();
    const sym = currentSym();
    if (!sym) return toast('未识别合约：请先在页面上选择合约，或在面板里填写', 'err');
    if (cfg.lots < 1) return toast('手数不能为 0', 'err');
    if (cfg.lots > cfg.maxLots) return toast('超过单笔上限 ' + cfg.maxLots + ' 手', 'err');

    sending = true;
    setBtns(true);
    try {
      const q = await getQuote(sym, true);
      if (!q) throw new Error('行情获取失败');
      const meta = metaOf(sym);
      const price = cfg.orderType === 'market' ? 0 : makePrice(q, meta, side);

      // 价格离谱保护（偏移单位设错时救命）
      const last = num(q.lastPrice);
      if (price > 0 && last > 0 && Math.abs(price - last) / last > 0.04) {
        const ok = await askConfirm('价格偏离最新价 ' + ((Math.abs(price - last) / last) * 100).toFixed(1) + '%，确认？<br>' +
          (side === 1 ? '买' : '卖') + (pe === 1 ? '开' : '平') + ' ' + cfg.lots + ' 手 @' + price);
        if (!ok) return;
      }

      const o = { sym: sym, side: side, pe: pe, qty: cfg.lots, price: price, text: '' };
      const key = side + ':' + pe + ':' + cfg.lots + ':' + price;
      const needConfirm = !cfg.fastMode || (key === lastKey && Date.now() - lastAt < 2500);

      if (needConfirm) {
        const ok = await askConfirm(describe(o) + ' ？');
        if (!ok) return;
      }
      lastKey = key; lastAt = Date.now();

      await submitOrder(o);
      renderPrices();
    } catch (e) {
      toast(e.message || String(e), 'err');
    } finally {
      sending = false;
      setBtns(false);
    }
  }

  function setBtns(dis) {
    if (!$root) return;
    $root.querySelectorAll('[data-act]').forEach((b) => { b.disabled = dis; });
    const rev = $root.querySelector('#qd-reverse');
    if (rev) rev.disabled = dis;
  }

  
  /* ---------------- 行情刷新 + 渲染 ---------------- */
  function renderPrices() {
    if (!$root || !quoteNow) return;
    const sym = quoteSym;
    const meta = metaOf(sym);
    const q = quoteNow;
    const last = num(q.lastPrice);
    const chg = num(q.changeRatio);
    $px.textContent = isFinite(last) ? last.toFixed(decimalsOf((meta && meta.minTickSize) || 0.1) || 2) : '--';
    $px.classList.toggle('dn', isFinite(chg) && chg < 0);

    const stock = cfg.orderType === 'market';
    const p1 = stock ? 0 : makePrice(q, meta, 1);
    const p2 = stock ? 0 : makePrice(q, meta, 2);
    const f = (v) => (stock ? '市价' : v.toFixed(Math.max(decimalsOf((meta && meta.minTickSize) || 0.01), 1)));
    $root.querySelector('#qd-p1').textContent = f(p1);
    $root.querySelector('#qd-p2').textContent = f(p2);
    $root.querySelector('#qd-p3').textContent = f(p1);
    $root.querySelector('#qd-p4').textContent = f(p2);
    renderRiskHints();
    renderInfo();
  }

  function drawBoll() {
    if (!$boll) return;
    const dpr = window.devicePixelRatio || 1;
    const W = $boll.clientWidth || 300, H = 132;
    if ($boll.width !== Math.round(W * dpr)) {
      $boll.width = Math.round(W * dpr);
      $boll.height = Math.round(H * dpr);
    }
    const g = $boll.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const sym = quoteSym;
    const arr = SERIES.get(sym) || [];
    const st = bollStats(arr);

    // 网格
    g.strokeStyle = '#1d2740'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (H / 4) * i;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }

    if (!isFinite(st.mean) || st.n < 3) {
      g.fillStyle = '#4d5b7a';
      g.font = '11px -apple-system,"Microsoft YaHei",sans-serif';
      g.textAlign = 'center';
      g.fillText(arr.length ? '样本不足（' + st.n + '/3），继续采集中…' : '等待行情…', W / 2, H / 2);
      $stat.up.textContent = '上 --';
      $stat.mid.textContent = '中 --';
      $stat.dn.textContent = '下 --';
      $stat.n.textContent = 'n=' + st.n;
      return;
    }

    const now = Date.now();
    const winMs = cfg.winSec * 1000;
    const oldest = st.w.length ? st.w[0].t : now;
    const useMs = Math.min(winMs, Math.max(6000, now - oldest));
    const t0 = now - useMs;
    let lo = Math.min(st.dn, st.mean), hi = Math.max(st.up, st.mean);
    for (const x of st.w) { if (x.p < lo) lo = x.p; if (x.p > hi) hi = x.p; }
    const pad = (hi - lo) * 0.12 || Math.max(0.01, Math.abs(hi) * 0.001);
    lo -= pad; hi += pad;
    const yOf = (v) => H - ((v - lo) / (hi - lo)) * H;
    const xOf = (t) => ((t - t0) / useMs) * W;

    // 布林带
    const x0 = xOf(Math.max(t0, oldest));
    g.fillStyle = 'rgba(61,126,255,.12)';
    g.fillRect(x0, Math.min(yOf(st.up), yOf(st.dn)), Math.max(1, W - x0), Math.abs(yOf(st.dn) - yOf(st.up)) || 1);
    g.setLineDash([3, 3]);
    g.strokeStyle = '#3d7eff'; g.beginPath();
    g.moveTo(x0, yOf(st.up)); g.lineTo(W, yOf(st.up)); g.stroke();
    g.strokeStyle = '#8a5cff'; g.beginPath();
    g.moveTo(x0, yOf(st.dn)); g.lineTo(W, yOf(st.dn)); g.stroke();
    g.strokeStyle = '#7f8db0';
    g.beginPath(); g.moveTo(x0, yOf(st.mean)); g.lineTo(W, yOf(st.mean)); g.stroke();
    g.setLineDash([]);

    // 价格线
    g.strokeStyle = '#ffd166'; g.lineWidth = 1.4;
    g.beginPath();
    let started = false;
    for (const x of st.w) {
      const px = xOf(x.t), py = yOf(x.p);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
    }
    g.stroke();

    // 当前点
    const lp = num(quoteNow && quoteNow.lastPrice);
    if (isFinite(lp)) {
      const py = yOf(lp);
      g.fillStyle = '#ffd166';
      g.beginPath(); g.arc(W - 1, py, 2.6, 0, Math.PI * 2); g.fill();
    }

    const dg = Math.max(decimalsOf((metaOf(sym) && metaOf(sym).minTickSize) || 0.01), 1);

    // 轴标注
    g.fillStyle = '#4d5b7a';
    g.font = '9px -apple-system,"Microsoft YaHei",sans-serif';
    g.textAlign = 'left';
    g.fillText(hi.toFixed(dg), 3, 10);
    g.fillText(lo.toFixed(dg), 3, H - 4);
    g.textAlign = 'right';
    g.fillText(Math.round(useMs / 1000) + 's', W - 3, H - 4);
    g.textAlign = 'left';

    $stat.up.textContent = '上 ' + st.up.toFixed(dg);
    $stat.mid.textContent = '中 ' + st.mean.toFixed(dg);
    $stat.dn.textContent = '下 ' + st.dn.toFixed(dg);
    $stat.n.textContent = 'n=' + st.n + ' · σ' + st.sd.toFixed(dg);
    $stat.up.style.color = '#3d7eff';
    $stat.dn.style.color = '#8a5cff';
  }

  /* ============================================================
   * 10.5 持仓 / 资金
   * ============================================================ */
  const POS = { at: 0, list: [], cap: null, busy: false, err: '' };
  const PXC = {};   // 合约 -> {at, px} 现价缓存，用于重算真实盈亏

  async function lastPxOf(sym) {
    const c = PXC[sym];
    if (c && Date.now() - c.at < 8000) return c.px;
    try {
      const js = await apiGet('/VERace/FutQuery/QueryQuote', { Security: sym });
      if (isOk(js) && js.data) {
        const v = num(js.data.lastPrice);
        PXC[sym] = { at: Date.now(), px: v };
        return v;
      }
    } catch (e) {}
    return NaN;
  }

  // 按最新价重算浮动盈亏（平台返回的 unrealizedProfitLoss 用的是昨结算价）
  function realPnlOf(r, px) {
    const meta = metaOf(r.securityID + '.' + r.market);
    const mult = meta ? num(meta.contractMulti) : NaN;
    const avg = num(r.totalAverageCost);
    const qty = num(r.position);
    if (!isFinite(mult) || !isFinite(avg) || !isFinite(px) || !isFinite(qty)) return NaN;
    const dir = num(r.side) === 1 ? 1 : -1;
    return (px - avg) * mult * qty * dir;
  }

  function posRows(sym) {
    if (!sym) return [];
    const out = [];
    for (let i = 0; i < POS.list.length; i++) {
      const r = POS.list[i];
      if ((r.securityID + '.' + r.market) === sym) out.push(r);
    }
    return out;
  }

  function posOf(sym, side) {
    const rows = posRows(sym);
    for (let i = 0; i < rows.length; i++) if (num(rows[i].side) === side) return rows[i];
    return null;
  }

  async function refreshPos(force) {
    if (POS.busy) return;
    if (!force && Date.now() - POS.at < 4000) return;
    const uid = getUserId();
    if (!uid) { POS.err = '未识别交易账号，请打开「交易下单」页'; renderPosTab(); return; }
    POS.busy = true;
    try {
      // 商品期货 + 金融期货两套持仓都要拉
      const merged = [];
      let gotAny = false;
      try {
        const a = await apiGet('/VERace/FutQuery/QueryFutAssetPosition', { UserID: uid, PageIndex: 1, PageSize: 500 });
        if (isOk(a)) { gotAny = true; if (Array.isArray(a.data)) merged.push.apply(merged, a.data); }
      } catch (e) {}
      try {
        const b = await apiGet('/VERace/FinFutQuery/QueryFinFutAssetPosition', { UserID: uid, PageIndex: 1, PageSize: 500 });
        if (isOk(b)) { gotAny = true; if (Array.isArray(b.data)) merged.push.apply(merged, b.data); }
      } catch (e) {}
      if (!gotAny) throw new Error('持仓查询失败');
      POS.list = merged;
      POS.at = Date.now();
      POS.err = '';
      // 抓各持仓合约的最新价，用来重算真实盈亏
      try {
        const syms = [];
        POS.list.forEach(function (r) {
          const s = r.securityID + '.' + r.market;
          if (syms.indexOf(s) < 0) syms.push(s);
        });
        for (let i = 0; i < syms.length && i < 6; i++) {
          const px = (syms[i] === quoteSym && quoteNow) ? num(quoteNow.lastPrice) : await lastPxOf(syms[i]);
          PXC[syms[i]] = { at: Date.now(), px: px };
        }
      } catch (e) {}
      try {
        const fin = isFinMkt(currentSym());
        const cp = fin ? '/VERace/FinFutQuery/QueryFinFutAssetCapital' : '/VERace/FutQuery/QueryFutAssetCapital';
        let c = await apiGet(cp, { UserID: uid });
        if (!(isOk(c) && c.data)) {
          const alt = fin ? '/VERace/FutQuery/QueryFutAssetCapital' : '/VERace/FinFutQuery/QueryFinFutAssetCapital';
          c = await apiGet(alt, { UserID: uid });
        }
        if (isOk(c) && c.data) POS.cap = c.data;
      } catch (e) {}
    } catch (e) {
      POS.err = e.message || String(e);
    } finally {
      POS.busy = false;
      renderPosTab();
      checkProtectAlive();
    }
  }

  function money(v) {
    const n = num(v);
    if (!isFinite(n)) return '--';
    return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  }

  function renderPosTab() {
    if (!$posList) return;
    const sym = currentSym();
    const warn = POS.err
      ? '<div class="qd-hint2" style="color:#e0867f;margin-bottom:4px">刷新失败：' + esc(POS.err) + '（下面是上次数据）</div>'
      : '';
    if (!POS.list.length) {
      $posList.innerHTML = warn + '<div class="qd-hint2">' + (POS.err ? '' : '当前空仓') + '</div>';
    } else {
      let html = '';
      POS.list.forEach(function (r) {
        const sd = r.securityID + '.' + r.market;
        const dg = Math.max(decimalsOf(tickOf(sd)), 1);
        const isLong = num(r.side) === 1;
        const avg = num(r.totalAverageCost);
        const pnl = num(r.unrealizedProfitLoss);
        html += '<div class="pr' + (sd === sym ? ' cur' : '') + '">' +
          '<span class="s" title="' + esc(sd) + '">' + esc(r.shortName || r.securityID) + '</span>' +
          '<span class="d ' + (isLong ? 'l' : 's') + '">' + (isLong ? '多' : '空') + '</span>' +
          '<span class="n">' + num(r.position) + '/' + num(r.usablePosition) + '</span>' +
          '<span class="a">' + (isFinite(avg) ? avg.toFixed(dg) : '--') + '</span>' +
          '<span class="p ' + (pnl >= 0 ? 'up' : 'dn') + '">' + (pnl >= 0 ? '+' : '') + (isFinite(pnl) ? pnl.toFixed(0) : '--') + '</span>' +
          '</div>';

        // 平台浮盈 vs 按最新价重算的浮盈
        const cPx = PXC[sd] ? PXC[sd].px : NaN;
        const real = realPnlOf(r, cPx);
        if (isFinite(real)) {
          const gap = real - pnl;
          const big = Math.abs(gap) > Math.max(50, Math.abs(pnl) * 0.02);
          if (big) {
            html += '<div class="pr2">⚠ 按现价 ' + cPx.toFixed(dg) + ' 实为 <b>' +
              (real >= 0 ? '+' : '') + real.toFixed(0) + '</b>' +
              '（平台口径差 <b>' + (gap >= 0 ? '+' : '') + gap.toFixed(0) + '</b>）</div>';
          }
        }
      });
      html += '<div class="qd-hint2" style="margin-top:3px">持仓/可用 · 均价 · 浮盈</div>';
      $posList.innerHTML = warn + html;
    }


    const t = $root && $root.querySelector('#qd-pos-time');
    if (t) t.textContent = POS.at ? '更新 ' + hms(POS.at) : '';
    renderReverseBtn();
  }

  /* ============================================================
   * 10.6 止损 / 止盈 / 移动止损
   * ============================================================ */
  const PROT_KEY = 'csmar_qd_protect_v1';
  let PROT = null;
  let firing = false;

  function loadProt() {
    try { PROT = JSON.parse(localStorage.getItem(PROT_KEY) || 'null'); } catch (e) { PROT = null; }
    if (PROT && PROT.status === 'firing') { PROT.status = 'armed'; PROT.nextTry = 0; }
  }
  function saveProt() {
    try {
      if (PROT) localStorage.setItem(PROT_KEY, JSON.stringify(PROT));
      else localStorage.removeItem(PROT_KEY);
    } catch (e) {}
  }

  function tickOf(sym) {
    const m = metaOf(sym);
    return (m && num(m.minTickSize)) || 0.01;
  }

  function refOf(sym, side) {
    const r = posOf(sym, side);
    const v = r ? num(r.totalAverageCost) : NaN;
    if (isFinite(v) && v > 0) return v;
    return num(quoteNow && quoteNow.lastPrice);
  }

  function slPriceOf(sym, side, ticks) {
    const t = tickOf(sym), ref = refOf(sym, side);
    if (!isFinite(ref) || ref <= 0 || !(ticks > 0)) return NaN;
    return roundTick(side === 1 ? ref - ticks * t : ref + ticks * t, t);
  }

  function tpPriceOf(sym, side, ticks) {
    const t = tickOf(sym), ref = refOf(sym, side);
    if (!isFinite(ref) || ref <= 0 || !(ticks > 0)) return NaN;
    return roundTick(side === 1 ? ref + ticks * t : ref - ticks * t, t);
  }

  function renderRiskHints() {
    if (!$sl || !$root) return;
    const sym = currentSym();
    const elSl = $root.querySelector('#qd-slpx');
    const elTp = $root.querySelector('#qd-tppx');
    if (!elSl || !elTp) return;
    if (!sym) { elSl.textContent = '--'; elTp.textContent = '--'; return; }
    const rows = posRows(sym);
    // 取可用持仓最大的那一行作为主方向；无持仓时按多头预览
    let main = null;
    rows.forEach(function (r) {
      const u = num(r.usablePosition);
      if (u > 0 && (!main || u > num(main.usablePosition))) main = r;
    });
    const side = main ? num(main.side) : 1;
    const dg = Math.max(decimalsOf(tickOf(sym)), 1);
    const sp = slPriceOf(sym, side, cfg.slTicks);
    const tp = tpPriceOf(sym, side, cfg.tpTicks);
    elSl.textContent = cfg.slTicks > 0 ? (isFinite(sp) ? sp.toFixed(dg) : '--') : '不设';
    elTp.textContent = cfg.tpTicks > 0 ? (isFinite(tp) ? tp.toFixed(dg) : '--') : '不设';

    const elPos = $root.querySelector('#qd-risk-pos');
    if (elPos) {
      if (main) {
        const isLong = side === 1;
        const avg = num(main.totalAverageCost);
        elPos.className = 'qd-riskpos ' + (isLong ? 'long' : 'short');
        elPos.innerHTML = '当前持仓 <b class="' + (isLong ? 'u' : 'd') + '">' +
          (isLong ? '多' : '空') + ' ' + num(main.usablePosition) + ' 手</b>' +
          ' · 均价 ' + (isFinite(avg) ? avg.toFixed(dg) : '--') +
          '<br><span style="font-size:10px;color:#6b7a99">止损止盈按' +
          (isLong ? '多头方向（下方）' : '空头方向（上方）') + '换算</span>';
      } else {
        elPos.className = 'qd-riskpos none';
        elPos.innerHTML = '当前无持仓 · 下方按<b>多头</b>预览';
      }
    }
  }

  function renderRiskTab() {
    if (!$armed) return;
    if (!PROT) {
      $armed.classList.remove('on');
      $armed.classList.remove('warn');
      if ($dot) $dot.classList.remove('on');
      return;
    }
    const dg = Math.max(decimalsOf(tickOf(PROT.sym)), 1);
    const isLong = PROT.side === 1;
    const code = PROT.sym.split('.')[0];
    const bits = [];
    if (PROT.sl > 0) bits.push('止损 ' + PROT.sl.toFixed(dg));
    if (PROT.tp > 0) bits.push('止盈 ' + PROT.tp.toFixed(dg));
    if (PROT.trail > 0) bits.push('移动 ' + PROT.trail + '跳');
    let head = '';
    if (PROT.status === 'armed') head = '🛡 保护中';
    else if (PROT.status === 'failed') head = '✖ 已停用';
    else head = '… 处理中';
    $armed.innerHTML = '<b>' + head + '</b> ' + (isLong ? '多' : '空') + ' ' + code +
      (bits.length ? '<br>' + bits.join(' · ') : '');
    $armed.classList.add('on');
    $armed.classList.toggle('warn', PROT.status !== 'armed');
    if ($dot) $dot.classList.toggle('on', PROT.status === 'armed');
  }

  function commitRiskInputs() {
    if ($sl) { let v = Math.floor(num($sl.value)); if (!isFinite(v) || v < 0) v = 0; cfg.slTicks = v; $sl.value = v; }
    if ($tp) { let v = Math.floor(num($tp.value)); if (!isFinite(v) || v < 0) v = 0; cfg.tpTicks = v; $tp.value = v; }
    if ($tr) { let v = Math.floor(num($tr.value)); if (!isFinite(v) || v < 1) v = 1; cfg.trailTicks = v; $tr.value = v; }
    if ($risk) { let v = Math.round(num($risk.value)); if (!isFinite(v) || v < 0) v = 0; cfg.riskCash = v; $risk.value = v; }
    if ($trailOn) cfg.trailOn = $trailOn.checked;
    syncVariety();
    saveCfg();
  }

  async function armProtect() {
    commitRiskInputs();
    const sym = currentSym();
    if (!sym) return toast('未识别合约', 'err');
    if (!posRows(sym).length) {
      await refreshPos(true);
      if (!posRows(sym).length) { await sleep(700); await refreshPos(true); }
    }
    const rows = posRows(sym);
    if (!rows.length) return toast('当前合约没有持仓，无法挂保护单', 'err');

    const side = num(rows[0].side);
    const dg = Math.max(decimalsOf(tickOf(sym)), 1);
    const sl = cfg.slTicks > 0 ? slPriceOf(sym, side, cfg.slTicks) : 0;
    const tp = cfg.tpTicks > 0 ? tpPriceOf(sym, side, cfg.tpTicks) : 0;
    const useTrail = !!cfg.trailOn;
    if (!sl && !tp && !useTrail) return toast('止损 / 止盈 / 移动止损 都没设置', 'warn');

    const last = num(quoteNow && quoteNow.lastPrice);
    if (sl > 0 && isFinite(last)) {
      if (side === 1 && last <= sl) return toast('现价 ' + last + ' 已经低于止损价 ' + sl.toFixed(dg) + '，保护单无意义', 'err');
      if (side === 2 && last >= sl) return toast('现价 ' + last + ' 已经高于止损价 ' + sl.toFixed(dg) + '，保护单无意义', 'err');
    }
    if (tp > 0 && isFinite(last)) {
      if (side === 1 && last >= tp) return toast('现价已经超过止盈价，保护单无意义', 'err');
      if (side === 2 && last <= tp) return toast('现价已经低于止盈价，保护单无意义', 'err');
    }

    const txt = '挂保护：' + (side === 1 ? '多' : '空') + ' ' + sym.split('.')[0] +
      (sl > 0 ? ' · 止损 ' + sl.toFixed(dg) : '') +
      (tp > 0 ? ' · 止盈 ' + tp.toFixed(dg) : '') +
      (useTrail ? ' · 移动 ' + cfg.trailTicks + '跳' : '') + ' ？';
    if (!(await askConfirm(txt))) return;

    const ref = refOf(sym, side);
    PROT = {
      sym: sym, side: side,
      sl: sl, tp: tp,
      trail: useTrail ? cfg.trailTicks : 0,
      avg: isFinite(ref) ? ref : 0,
      peak: isFinite(last) ? last : ref,
      status: 'armed', at: Date.now(), fails: 0, nextTry: 0
    };
    saveProt();
    renderRiskTab();
    renderRiskHints();
    toast('保护单已挂上', 'ok');
    pushLog('保护', sym.split('.')[0] + ' ' + (side === 1 ? '多' : '空') +
      (sl > 0 ? ' 止损' + sl.toFixed(dg) : '') + (tp > 0 ? ' 止盈' + tp.toFixed(dg) : '') +
      (useTrail ? ' 移动' + cfg.trailTicks + '跳' : ''));
  }

  function disarmProtect() {
    if (!PROT) return toast('当前没有保护单', 'warn');
    PROT = null;
    saveProt();
    renderRiskTab();
    toast('保护单已撤销', 'info');
    pushLog('保护', '已手动撤销');
  }

  function checkProtectAlive() {
    if (!PROT || PROT.status !== 'armed') return;
    if (!POS.at || POS.at < (PROT.at || 0)) return;   // 持仓还没刷新过
    const rows = posRows(PROT.sym).filter(function (r) { return num(r.side) === PROT.side; });
    const alive = rows.some(function (r) { return num(r.position) > 0 || num(r.usablePosition) > 0; });
    if (!alive) {
      PROT = null;
      saveProt();
      renderRiskTab();
      pushLog('保护', '持仓已清空，保护单自动解除');
      toast('持仓已清空，保护单自动解除', 'info');
    }
  }

  function checkProtectFor(sym, q) {
    if (!PROT || PROT.status !== 'armed' || PROT.sym !== sym || !q) return;
    if (Date.now() < (PROT.nextTry || 0)) return;
    const last = num(q.lastPrice);
    if (!isFinite(last) || last <= 0) return;

    const t = tickOf(sym);
    const isLong = PROT.side === 1;
    const avg = num(PROT.avg) || 0;

    if (isLong) { if (!isFinite(PROT.peak) || last > PROT.peak) PROT.peak = last; }
    else { if (!isFinite(PROT.peak) || last < PROT.peak) PROT.peak = last; }

    let why = '';
    if (PROT.sl > 0 && ((isLong && last <= PROT.sl) || (!isLong && last >= PROT.sl))) {
      why = '止损';
    } else if (PROT.tp > 0 && ((isLong && last >= PROT.tp) || (!isLong && last <= PROT.tp))) {
      why = '止盈';
    } else if (PROT.trail > 0 && isFinite(PROT.peak) && avg > 0) {
      const started = isLong ? PROT.peak >= avg + PROT.trail * t : PROT.peak <= avg - PROT.trail * t;
      if (started) {
        const stop = isLong ? PROT.peak - PROT.trail * t : PROT.peak + PROT.trail * t;
        if ((isLong && last <= stop) || (!isLong && last >= stop)) why = '移动止损';
      }
    }
    if (why) fireProtect(why, last);
  }

  async function fireProtect(why, px) {
    if (firing || !PROT) return;
    firing = true;
    PROT.status = 'firing';
    saveProt();
    renderRiskTab();
    beep(3);

    const sym = PROT.sym;
    const side = PROT.side;
    const code = sym.split('.')[0];
    pushLog('触发', why + ' ' + code + ' @' + px);
    toast('⚠ ' + why + ' 触发：' + code + ' @' + px, 'err');

    try {
      await refreshPos(true);
      await sleep(200);
      const rows = posRows(sym).filter(function (r) {
        return num(r.side) === side && num(r.usablePosition) > 0;
      });
      if (!rows.length) {
        pushLog('保护', '触发时已无持仓，作废');
        toast('触发时已无持仓，保护单作废', 'warn');
        PROT = null;
        saveProt();
        return;
      }
      const closeSide = side === 1 ? 2 : 1;
      const q = await getQuote(sym, true);
      if (!q) throw new Error('行情获取失败');
      const price = makePrice(q, metaOf(sym), closeSide);
      let total = 0;
      for (let i = 0; i < rows.length; i++) {
        const qty = num(rows[i].usablePosition);
        if (!(qty > 0)) continue;
        await submitOrder({ sym: sym, side: closeSide, pe: cfg.closeType, qty: qty, price: price, text: '自动' + why });
        total += qty;
        await sleep(200);
      }
      pushLog('平仓', why + ' → 已发 ' + total + ' 手');
      PROT = null;
      saveProt();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      PROT.fails = (PROT.fails || 0) + 1;
      PROT.nextTry = Date.now() + 3000;
      if (PROT.fails >= 3) {
        PROT.status = 'failed';
        toast('自动平仓连续失败，保护已停用，请立刻手动处理！', 'err');
        pushLog('失败', why + ' 平仓失败：' + msg);
      } else {
        PROT.status = 'armed';
        toast('自动平仓失败（' + msg + '），3 秒后重试', 'err');
        pushLog('失败', why + ' 平仓失败：' + msg);
      }
    } finally {
      firing = false;
      renderRiskTab();
    }
  }

  /* ============================================================
   * 10.7 一键反手
   * ============================================================ */
  async function waitFlat(sym, side, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await refreshPos(true);
      const left = posRows(sym).filter(function (r) {
        return num(r.side) === side && num(r.usablePosition) > 0;
      });
      if (!left.length) return true;
      await sleep(400);
    }
    return false;
  }

  function autoArm(sym, side) {
    try {
      const rows = posRows(sym).filter(function (r) {
        return num(r.side) === side && num(r.usablePosition) > 0;
      });
      if (!rows.length) { pushLog('保护', '反手后没查到新持仓，保护未挂'); return; }
      const avg = num(rows[0].totalAverageCost);
      const t = tickOf(sym);
      const sl = cfg.slTicks > 0 ? roundTick(side === 1 ? avg - cfg.slTicks * t : avg + cfg.slTicks * t, t) : 0;
      const tp = cfg.tpTicks > 0 ? roundTick(side === 1 ? avg + cfg.tpTicks * t : avg - cfg.tpTicks * t, t) : 0;
      const last = num(quoteNow && quoteNow.lastPrice);
      PROT = {
        sym: sym, side: side, sl: sl, tp: tp,
        trail: cfg.trailOn ? cfg.trailTicks : 0,
        avg: isFinite(avg) && avg > 0 ? avg : last,
        peak: isFinite(last) ? last : avg,
        status: 'armed', at: Date.now(), fails: 0, nextTry: 0
      };
      saveProt();
      renderRiskTab();
      const dg = Math.max(decimalsOf(t), 1);
      pushLog('保护', '反手后自动挂 止损' + (sl ? sl.toFixed(dg) : '-') + ' 止盈' + (tp ? tp.toFixed(dg) : '-'));
    } catch (e) {}
  }

  async function doReverse() {
    if (sending) return toast('有订单正在处理，稍候', 'warn');
    commitInputs();
    const sym = currentSym();
    if (!sym) return toast('未识别合约', 'err');
    if (!getUserId()) return toast('未识别交易账号，请打开「交易下单」页', 'err');

    await refreshPos(true);
    const rows = posRows(sym).filter(function (r) {
      return num(r.position) > 0 || num(r.usablePosition) > 0;
    });
    if (!rows.length) return toast('当前合约没有持仓，无法反手', 'warn');

    let main = rows[0];
    rows.forEach(function (r) { if (num(r.usablePosition) > num(main.usablePosition)) main = r; });
    const oldSide = num(main.side);
    const qty = num(main.usablePosition);
    if (!(qty > 0)) return toast('持仓不可用（可能在途或已被冻结）', 'warn');

    const newSide = oldSide === 1 ? 2 : 1;
    const meta = metaOf(sym);
    let q = await getQuote(sym, true);
    if (!q) return toast('行情获取失败', 'err');
    const closePx = makePrice(q, meta, newSide);

    let txt = '反手：平' + (oldSide === 1 ? '多' : '空') + ' ' + qty + ' 手 → 开' +
      (newSide === 1 ? '多' : '空') + ' ' + qty + ' 手';
    if (cfg.autoArm && cfg.slTicks > 0) txt += '，并自动挂止损 ' + cfg.slTicks + ' 跳';
    txt += '？';
    if (!(await askConfirm(txt))) return;

    sending = true;
    setBtns(true);
    try {
      // 第一步：平旧仓（先平后开，避免双向持仓）
      pushLog('反手', '平' + (oldSide === 1 ? '多' : '空') + ' ' + qty + ' 手 @' + closePx);
      const r1 = await submitOrder({
        sym: sym, side: newSide, pe: cfg.closeType, qty: qty, price: closePx, text: '反手平仓'
      });
      if (!r1.ok) throw new Error('平仓未成功：' + (r1.msg || ''));

      const flat = cfg.dryRun ? true : await waitFlat(sym, oldSide, 6000);
      if (!flat) {
        toast('平仓未完全成交，已中止反手，请手动处理剩余持仓', 'err');
        pushLog('反手', '平仓未成交，已中止');
        return;
      }

      // 第二步：开反向仓
      q = await getQuote(sym, true);
      const openPx = makePrice(q, meta, newSide);
      pushLog('反手', '开' + (newSide === 1 ? '多' : '空') + ' ' + qty + ' 手 @' + openPx);
      const r2 = await submitOrder({
        sym: sym, side: newSide, pe: 1, qty: qty, price: openPx, text: '反手开仓'
      });
      if (!r2.ok) {
        toast('已平仓，但开仓失败：' + (r2.msg || '') + '，当前为空仓', 'err');
        pushLog('反手', '开仓失败');
        return;
      }

      // 旧保护单一定作废（它绑的是旧方向/旧均价）
      if (PROT && PROT.sym === sym) {
        PROT = null;
        saveProt();
        renderRiskTab();
      }

      if (cfg.autoArm && cfg.slTicks > 0) {
        await sleep(500);
        await refreshPos(true);
        await sleep(300);
        await refreshPos(true);
        autoArm(sym, newSide);
      }
      toast('反手完成：现在' + (newSide === 1 ? '多' : '空') + ' ' + qty + ' 手', 'ok');
    } catch (e) {
      toast('反手失败：' + (e.message || e), 'err');
      pushLog('反手', '失败：' + (e.message || e));
    } finally {
      sending = false;
      setBtns(false);
      renderReverseBtn();
    }
  }

  function renderReverseBtn() {
    if (!$root) return;
    const btn = $root.querySelector('#qd-reverse');
    if (!btn) return;
    const sym = currentSym();
    const rows = sym ? posRows(sym).filter(function (r) {
      return num(r.position) > 0 || num(r.usablePosition) > 0;
    }) : [];
    if (!rows.length) {
      btn.disabled = true;
      btn.textContent = '⇄ 一键反手（无持仓）';
      return;
    }
    let main = rows[0];
    rows.forEach(function (r) { if (num(r.usablePosition) > num(main.usablePosition)) main = r; });
    const qty = num(main.usablePosition);
    const isLong = num(main.side) === 1;
    btn.disabled = !(qty > 0) || sending;
    btn.textContent = '⇄ 一键反手 · 平' + (isLong ? '多' : '空') + ' ' + qty +
      ' → 开' + (isLong ? '空' : '多') + ' ' + qty;
  }

  /* ============================================================
   * 10.8 按品种记忆参数
   * ============================================================ */
  let LAST_VAR = '';

  // 中金所（金融期货）用独立的一套接口
  function isFinMkt(sym) {
    return String(sym || '').split('.')[1] === 'CFFEX';
  }

  function varietyOf(sym) {
    if (!sym) return '';
    return sym.split('.')[0].replace(/[0-9]+$/, '');
  }

  function syncVariety() {
    const v = varietyOf(currentSym());
    if (!v) return;
    cfg.vp[v] = {
      offset: cfg.offset, slTicks: cfg.slTicks, tpTicks: cfg.tpTicks,
      trailTicks: cfg.trailTicks, lots: cfg.lots
    };
  }

  function applyVariety(sym) {
    const v = varietyOf(sym);
    if (!v || v === LAST_VAR) return;
    const first = LAST_VAR === '';
    LAST_VAR = v;
    // 首次运行不覆盖用户已有设置，只把它记成该品种的基准
    if (first && !cfg.vp[v]) {
      syncVariety();
      saveCfg();
      renderReverseBtn();
      refreshPos(true);
      return;
    }
    const p = cfg.vp[v] || VARIETY_DEFAULT[v] || VARIETY_FALLBACK;
    cfg.offset = p.offset;
    cfg.slTicks = p.slTicks;
    cfg.tpTicks = p.tpTicks;
    cfg.trailTicks = p.trailTicks;
    if (p.lots) cfg.lots = Math.min(p.lots, cfg.maxLots);
    if ($off) $off.value = cfg.offset;
    if ($sl) $sl.value = cfg.slTicks;
    if ($tp) $tp.value = cfg.tpTicks;
    if ($tr) $tr.value = cfg.trailTicks;
    if ($qty) $qty.value = cfg.lots;
    saveCfg();
    syncLabels();
    renderRiskHints();
    renderInfo();
    pushLog('品种', v + ' · 偏移' + cfg.offset + ' 止损' + cfg.slTicks + '跳 止盈' + cfg.tpTicks + '跳');
    renderReverseBtn();
    refreshPos(true);
  }

  // 动量：最近 sec 秒的涨跌幅（用布林采样的价格序列）
  function momentumOf(sym, sec) {
    const arr = SERIES.get(sym) || [];
    if (arr.length < 3) return NaN;
    const from = Date.now() - sec * 1000;
    let base = null;
    for (let i = 0; i < arr.length; i++) { if (arr[i].t >= from) { base = arr[i].p; break; } }
    if (base == null) base = arr[0].p;
    const last = arr[arr.length - 1].p;
    if (!base) return NaN;
    return (last - base) / base * 100;
  }

  function renderSignal() {
    if (!$root) return;
    const el = $root.querySelector('#qd-signal');
    if (!el) return;
    const sym = quoteSym;
    if (!sym) { el.innerHTML = '<span>均价 --</span><span>动能 --</span><span>位置 --</span>'; return; }

    const last = num(quoteNow && quoteNow.lastPrice);
    const dg = Math.max(decimalsOf(tickOf(sym)), 1);

    // 均价：优先真 VWAP（iframe 探针），读不到退回 TWAP
    let aCls = '', aTxt = '均价 --';
    let avg = (VW.sym === sym && isFinite(VW.vwap)) ? VW.vwap : dayAvg(sym);
    const isVwap = (VW.sym === sym && isFinite(VW.vwap));
    if (isFinite(avg) && avg > 0 && isFinite(last)) {
      const dev = (last - avg) / avg * 100;
      aCls = dev > 0.03 ? 'up' : (dev < -0.03 ? 'dn' : '');
      aTxt = (isVwap ? 'VW ' : '均价 ') + avg.toFixed(dg) + ' ' +
        (dev >= 0 ? '+' : '') + dev.toFixed(2) + '%';
      const elA = el.querySelector('span');
      if (elA) elA.title = isVwap ? '成交量加权均价（来自分时图总手/总额）' : '时间加权均价（TWAP，分时图未加载）';
    }

    const mom = momentumOf(sym, 60);
    let mCls = '', mTxt = '动能 --';
    if (isFinite(mom)) {
      mCls = mom > 0.02 ? 'up' : (mom < -0.02 ? 'dn' : '');
      mTxt = '动能 ' + (mom >= 0 ? '+' : '') + mom.toFixed(2) + '%';
    }

    const st = bollStats(SERIES.get(sym) || []);
    let zCls = '', zTxt = '位置 --';
    if (isFinite(st.sd) && st.sd > 0 && isFinite(last)) {
      const z = (last - st.mean) / st.sd;
      if (z >= 2) { zCls = 'up'; zTxt = '超买 +' + z.toFixed(1) + 'σ'; }
      else if (z <= -2) { zCls = 'dn'; zTxt = '超卖 ' + z.toFixed(1) + 'σ'; }
      else if (z >= 1) { zCls = 'warn'; zTxt = '偏强 +' + z.toFixed(1) + 'σ'; }
      else if (z <= -1) { zCls = 'warn'; zTxt = '偏弱 ' + z.toFixed(1) + 'σ'; }
      else { zTxt = '中性 ' + (z >= 0 ? '+' : '') + z.toFixed(1) + 'σ'; }
    }
    el.innerHTML = '<span class="' + aCls + '">' + aTxt + '</span>' +
      '<span class="' + mCls + '">' + mTxt + '</span>' +
      '<span class="' + zCls + '">' + zTxt + '</span>';
  }

  /* ============================================================
   * 10.10 真 VWAP：iframe 探针
   *   平台 QueryQuote 不返回成交量，但分时图页面（qchartDetail.html）
   *   顶部有「总手 / 总额 / 持仓」，是当日累计统计。
   *   同源 iframe 加载它 → 读渲染后的文本 → VWAP = 总额 / (总手 × 乘数)
   *   读不到时自动退回 TWAP。
   * ============================================================ */
  const VW = { sym: '', frame: null, at: 0, vwap: NaN, vol: 0, amt: 0, oi: 0, sniffed: false };

  function ensureVwapFrame(sym) {
    if (cfg.vwap === false) return;
    if (!sym) return;
    if (VW.frame && VW.sym === sym) return;
    if (!VW.frame) {
      const f = document.createElement('iframe');
      f.id = 'qd-vwap-frame';
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;border:0;pointer-events:none;';
      document.body.appendChild(f);
      VW.frame = f;
    }
    VW.sym = sym;
    VW.at = 0;
    VW.vwap = NaN;
    VW.sniffed = false;
    VW.frame.src = location.origin + '/qchartDetail.html?activeSymbolMarket=' +
      encodeURIComponent(sym) + '&h=1';
  }

  function readVwap(sym) {
    if (cfg.vwap === false) return NaN;
    const f = VW.frame;
    if (!f || VW.sym !== sym) return NaN;
    let doc = null;
    try { doc = f.contentDocument; } catch (e) { return NaN; }
    if (!doc || !doc.body) return NaN;
    let txt = '';
    try { txt = doc.body.innerText || ''; } catch (e) { return NaN; }
    if (!txt || txt.length < 20) return NaN;

    const pick = function (label) {
      const m = txt.match(new RegExp(label + '[：:]\\s*([\\d.,]+)\\s*(万|亿)?'));
      if (!m) return NaN;
      let v = parseFloat(String(m[1]).replace(/,/g, ''));
      if (!isFinite(v)) return NaN;
      if (m[2] === '万') v *= 1e4;
      else if (m[2] === '亿') v *= 1e8;
      return v;
    };

    const vol = pick('总手');
    const amt = pick('总额');
    if (isFinite(vol) && isFinite(amt) && vol > 0) {
      const meta = metaOf(sym);
      const mult = meta ? num(meta.contractMulti) : NaN;
      if (isFinite(mult) && mult > 0) {
        VW.vwap = amt / (vol * mult);
        VW.vol = vol;
        VW.amt = amt;
        VW.oi = pick('持仓');
        VW.at = Date.now();
        if (!VW.sniffed) {
          VW.sniffed = true;
          try {
            const ents = f.contentWindow.performance.getEntriesByType('resource') || [];
            const hits = [];
            ents.forEach(function (e) {
              if (/quote|trend|chart|market|hq|kline|tick/i.test(e.name)) {
                hits.push(e.name.replace(location.origin, ''));
              }
            });
            if (hits.length) console.log('[QD] 分时图接口候选：', hits.slice(0, 12));
          } catch (e2) {}
        }
      }
    }
    return VW.vwap;
  }

  // 当日累计均价（TWAP 近似：每秒采样等权平均，不是成交量加权）
  const DAY = new Map();   // sym -> {date, sum, n}

  function dayAccum(sym, px) {
    if (!sym || !isFinite(px) || px <= 0) return;
    const today = new Date().toDateString();
    let d = DAY.get(sym);
    if (!d || d.date !== today) { d = { date: today, sum: 0, n: 0 }; DAY.set(sym, d); }
    d.sum += px;
    d.n += 1;
  }

  function dayAvg(sym) {
    const d = DAY.get(sym);
    if (!d || d.n < 5) return NaN;
    return d.sum / d.n;
  }

  let INFO_CACHE = '';
  function renderInfo() {
    if (!$root) return;
    const el = $root.querySelector('#qd-info');
    if (!el) return;
    const sym = currentSym();
    const meta = metaOf(sym);
    let txt;
    if (!sym) txt = '未识别合约';
    else if (!meta) txt = sym.split('.')[0] + ' · 合约参数加载中…';
    else {
      const perTick = num(meta.contractMulti) * num(meta.minTickSize);
      txt = sym.split('.')[0] + ' · 每跳 ' + perTick + ' 元';
      if (cfg.slTicks > 0) txt += ' · 止损 ' + cfg.slTicks + ' 跳 ≈ 每手亏 ' + (perTick * cfg.slTicks).toLocaleString('zh-CN') + ' 元';
      else txt += ' · 未设止损';
    }
    if (txt === INFO_CACHE) return;
    INFO_CACHE = txt;
    el.textContent = txt;
  }

  /* ============================================================
   * 10.9 按金额算手数
   * ============================================================ */
  function calcLotsByRisk() {
    commitRiskInputs();
    const sym = currentSym();
    const meta = metaOf(sym);
    if (!sym || !meta) return toast('合约信息还没加载好，稍等一下再点', 'warn');
    const perTick = num(meta.contractMulti) * num(meta.minTickSize);
    const ticks = cfg.slTicks;
    const cash = cfg.riskCash;
    if (!(perTick > 0)) return toast('该合约缺少乘数信息', 'err');
    if (!(ticks > 0)) return toast('先把「止损」跳数设成大于 0', 'warn');
    if (!(cash > 0)) return toast('先填「最多亏」金额', 'warn');

    const perLot = perTick * ticks;
    const lots = Math.floor(cash / perLot);
    if (lots < 1) {
      $sugg.style.color = '#e0867f';
      $sugg.innerHTML = '每跳 <b>' + perTick + '</b> 元 · 1 手止损就要亏 <b>' + perLot + '</b> 元，超出预算';
      return;
    }
    $sugg.style.color = '';
    $sugg.innerHTML = '每跳 ' + perTick + ' 元 · 每手止损亏 ' + perLot + ' 元 → 建议 <b>' + lots + '</b> 手' +
      ' <span id="qd-apply-lots" style="color:#3d7eff;cursor:pointer">应用</span>';
    const a = $sugg.querySelector('#qd-apply-lots');
    if (a) a.addEventListener('click', function () {
      cfg.lots = Math.min(lots, cfg.maxLots);
      $qty.value = cfg.lots;
      saveCfg();
      toast('手数已设为 ' + cfg.lots + ' 手', 'ok');
    });
  }

  /* ============================================================
   * 10.8 声音提示
   * ============================================================ */
  /* ============================================================
   * 10.9b 后台保活
   *   浏览器会把后台标签页的 setTimeout 节流到 1 分钟一次，
   *   保护单会因此失效。用一段极低音量的循环音频让页面保持
   *   "正在播放音频" 状态，从而不被节流。
   * ============================================================ */
  let KA = null;
  function startKeepAlive() {
    if (KA || cfg.keepAlive === false) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const len = Math.floor(ctx.sampleRate * 0.5);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() - 0.5) * 1e-5;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0.0015;
      src.connect(g);
      g.connect(ctx.destination);
      src.start();
      if (ctx.state === 'suspended') ctx.resume();
      KA = { ctx: ctx, src: src };
    } catch (e) {}
  }

  let ACTX = null;
  function beep(n) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ACTX) ACTX = new AC();
      if (ACTX.state === 'suspended') ACTX.resume();
      for (let i = 0; i < (n || 1); i++) {
        const o = ACTX.createOscillator(), g = ACTX.createGain();
        o.type = 'sine';
        o.frequency.value = 900;
        o.connect(g); g.connect(ACTX.destination);
        const t0 = ACTX.currentTime + i * 0.2;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        o.start(t0);
        o.stop(t0 + 0.18);
      }
    } catch (e) {}
  }

  /* ---------------- 主循环 ---------------- */
  let wake = false;
  async function loop() {
    let tick = 0;
    while (true) {
      const t0 = Date.now();
      const woken = wake;
      wake = false;
      try {
        if (!document.hidden || woken) {
          const sym = currentSym();
          if (sym && varietyOf(sym) !== LAST_VAR) applyVariety(sym);
          if (sym) {
            const q = await getQuote(sym, true);
            if (q) {
              quoteNow = q; quoteSym = sym;
              ensureVwapFrame(sym);
              readVwap(sym);
              dayAccum(sym, num(q.lastPrice));
              pushSample(sym, num(q.lastPrice));
              renderPrices();
              checkProtectFor(sym, q);
              if (!cfg.sym && $sym && $sym.placeholder !== '跟随页面 · ' + sym) {
                $sym.placeholder = '跟随页面 · ' + sym;
              }
              if ($root) {
                const u = getUserId();
                const el = $root.querySelector('#qd-uid');
                if (el) el.textContent = u ? u.slice(-8) : '';
              }
            }
          }
          drawBoll();
          renderSignal();

          // 保护单可能挂在别的合约上，单独拉一次行情
          if (PROT && PROT.status === 'armed' && PROT.sym && PROT.sym !== quoteSym) {
            try {
              const q2 = await getQuote(PROT.sym, true);
              if (q2) checkProtectFor(PROT.sym, q2);
            } catch (e2) {}
          }
          // 持仓：反手按钮 / 风控换算价 / 看板都依赖它，常驻低频刷新（内部节流 4s）
          refreshPos();
        }
      } catch (e) {
        if (tick < 3) console.warn('[QD]', e && e.message);
      }
      tick++;
      const dt = Date.now() - t0;
      await sleep(Math.max(250, 1000 - dt));
    }
  }

  /* ---------------- 启动 ---------------- */
  // 调试/高级用法入口：控制台可用 __QD.cfg.lots = 3 之类直接改配置
  window.__QD = {
    cfg: cfg,
    set: function (k, v) { cfg[k] = v; saveCfg(); },
    doTrade: doTrade,
    submitOrder: submitOrder,
    currentSym: currentSym,
    getUserId: getUserId,
    getQuote: getQuote,
    metaOf: metaOf,
    series: SERIES,
    toast: toast,
    // 风控 / 持仓（调试与高级用法）
    pos: function () { return POS; },
    prot: function () { return PROT; },
    arm: armProtect,
    disarm: disarmProtect,
    reverse: doReverse,
    checkProtect: checkProtectFor,
    refreshPos: refreshPos,
    renderPos: renderPosTab,
    lastPx: lastPxOf,
    realPnl: realPnlOf,
    calcLots: calcLotsByRisk,
    switchTab: switchTab
  };

  function boot() {
    buildUI();
    loadProt();
    renderRiskTab();
    switchTab(cfg.tab || 'trade');
    pushLog('就绪', '等待行情…（下单请点面板按钮）');
    loadMeta();
    loop();
    // 首次定位 Vue，拿到账号后提示
    setTimeout(() => {
      const u = getUserId();
      if (!u) toast('未识别交易账号：请打开「商品期货 → 交易下单」页面', 'warn');
      else { pushLog('账号', u); refreshPos(true); }
    }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  console.log('%c[QD] CSMAR 交易助手已加载', 'color:#3d7eff;font-weight:bold');
})();
