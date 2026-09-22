/* ============================================================================
 * Order Management Web App — backend (single file)
 * Database: the bound Google Sheets workbook (single source of truth).
 *
 * Workbook sheets (discovered, never assumed — see CFG_.SHEETS + synonyms):
 *   Order Tracker | Todays Billing | Pending Delivery | Delivered Orders |
 *   Key | Product Master | Holiday Master | Dashboard |
 *   Report - Customer Summary | Activity Log | Error Log
 *
 * Architecture: namespaced IIFEs (no global collisions). Only api*,
 * doGet/include and the thin action wrappers at the bottom are global.
 * All reads are header-driven (detectHeaderRow + synonym map), so moved
 * columns do not break the app. All mutations run under LockService.
 * ========================================================================== */

/* ------------------------------- CFG_ ---------------------------------- */
var CFG_ = (function () {
  var SHEETS = {
    TRACKER: 'Order Tracker',
    BILLING: 'Todays Billing',
    PENDING: 'Pending Delivery',
    DELIVERED: 'Delivered Orders',
    KEY: 'Key',
    PRODUCTS: 'Product Master',
    HOLIDAYS: 'Holiday Master',
    DASHBOARD: 'Dashboard',
    CUST_REPORT: 'Report - Customer Summary',
    ACTIVITY: 'Activity Log',
    ERRORS: 'Error Log'
  };
  // Acceptable aliases when locating a sheet (e.g. apostrophe variants).
  var ALIASES = {
    'Order Tracker': ['Order Tracker', 'OrderTracker', 'Orders'],
    'Todays Billing': ['Todays Billing', "Today's Billing", 'Today Billing'],
    'Pending Delivery': ['Pending Delivery', 'PendingDelivery'],
    'Delivered Orders': ['Delivered Orders', 'DeliveredOrders', 'Delivered'],
    'Key': ['Key', 'Customer Data', 'Customers'],
    'Product Master': ['Product Master', 'Products', 'SKU Master'],
    'Holiday Master': ['Holiday Master', 'Holidays'],
    'Dashboard': ['Dashboard', 'DASH'],
    'Report - Customer Summary': ['Report - Customer Summary', 'Customer Summary'],
    'Activity Log': ['Activity Log'],
    'Error Log': ['Error Log']
  };
  // Normalized header text -> canonical field key.
  var SYN = {
    'sl no': 'slNo', 'slno': 'slNo', 's no': 'slNo', 'sno': 'slNo', 'sl': 'slNo',
    'order id': 'orderId', 'orderid': 'orderId', 'order no': 'orderId', 'orderno': 'orderId',
    'order date': 'orderDate', 'ordered date': 'orderDate',
    'ledger name': 'ledgerName', 'customer name': 'ledgerName', 'customer': 'ledgerName',
    'ledger': 'ledgerName', 'client name': 'ledgerName', 'client': 'ledgerName',
    'blend name': 'blendName', 'blend': 'blendName', 'sku name': 'blendName',
    'product name': 'blendName', 'product': 'blendName', 'item name': 'blendName', 'item': 'blendName',
    'qty': 'qty', 'quantity': 'qty', 'qnty': 'qty',
    'uom': 'uom', 'unit': 'uom', 'units': 'uom',
    'route': 'route',
    'route day': 'routeDay', 'routeday': 'routeDay', 'delivery day': 'routeDay', 'deliveryday': 'routeDay',
    'billing date': 'billingDate', 'bill date': 'billingDate',
    'delivered on': 'deliveredOn', 'delivered date': 'deliveredOn', 'delivery date': 'deliveredOn',
    'deliveredon': 'deliveredOn', 'delivered': 'deliveredOn',
    'remarks': 'remarks', 'remark': 'remarks', 'notes': 'remarks', 'note': 'remarks',
    'billing status': 'billingStatus', 'bill status': 'billingStatus',
    'payment status': 'paymentStatus',
    'payment terms': 'paymentTerms', 'payment trems': 'paymentTerms', 'payment term': 'paymentTerms',
    'terms': 'paymentTerms',
    'delivery status': 'deliveryStatus',
    'customer status': 'customerStatus', 'status': 'status',
    'emp name': 'empName', 'employee': 'empName', 'sales person': 'empName', 'empname': 'empName',
    'location/place': 'address', 'location': 'address', 'place': 'address', 'address': 'address',
    'locationplace': 'address',
    'ledger id': 'ledgerId', 'ledgerid': 'ledgerId', 'customer id': 'ledgerId', 'customerid': 'ledgerId',
    'approved blend': 'approvedBlend', 'approvedblend': 'approvedBlend',
    'approved blends': 'approvedBlend', 'approvedblends': 'approvedBlend',
    'mobile number': 'mobile', 'mobile': 'mobile', 'phone': 'mobile', 'contact': 'mobile',
    'contact no': 'mobile', 'contact number': 'mobile',
    'city': 'city', 'area': 'area',
    'sku id': 'skuId', 'skuid': 'skuId', 'item code': 'skuId',
    'holiday date': 'holidayDate', 'holiday name': 'holidayName', 'holiday type': 'holidayType',
    'date': 'date', 'time': 'time', 'user': 'user', 'action': 'action',
    'message': 'message', 'details': 'details', 'row': 'rowNum', 'function': 'funcName',
    'sheet': 'sheetName', 'timestamp': 'timestamp'
  };
  return {
    SHEETS: SHEETS,
    ALIASES: ALIASES,
    SYN: SYN,
    ACTIVE_SHEETS: [SHEETS.TRACKER, SHEETS.BILLING, SHEETS.PENDING],
    PAYMENT_STATUSES: ['Waiting for Payment', 'Payment Received', 'Credit'],
    BILLING_STATUSES: ['Pending', 'Billed'],
    DELIVERY_STATUSES: ['Delivered'],
    UOMS: ['KG', 'LTR', 'PAC'],
    PAYMENT_TERMS: ['Advance', 'Credit'],
    FUZZY_ACCEPT: 0.9,   // >= this: auto-accept fuzzy match
    SCHEMA_TTL_SEC: 21600
  };
})();

/* ------------------------------ Utils_ (pure) --------------------------- */
var Utils_ = (function () {
  function normHeader(h) {
    return String(h === null || h === undefined ? '' : h)
      .toLowerCase().replace(/[_\-]+/g, ' ').replace(/[^a-z0-9 /]/g, '')
      .replace(/\s+/g, ' ').trim();
  }
  function normStr(s) {
    return String(s === null || s === undefined ? '' : s)
      .toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9'&]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function normId(s) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, '').toUpperCase(); }
  function normUom(s) { return String(s === null || s === undefined ? '' : s).replace(/[^a-z]/gi, '').toUpperCase(); }
  function toNumber(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    var n = parseFloat(String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/) || [NaN]);
    return n;
  }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  // Levenshtein distance on already-normalized strings.
  function lev(a, b) {
    a = a || ''; b = b || '';
    if (a === b) return 0;
    if (!a.length) return b.length; if (!b.length) return a.length;
    var dp = []; for (var i = 0; i <= a.length; i++) dp[i] = [i];
    for (var j = 0; j <= b.length; j++) dp[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++) {
      var c = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
    }
    return dp[a.length][b.length];
  }
  function similarity(a, b) {
    a = normStr(a); b = normStr(b);
    if (!a && !b) return 1; if (!a || !b) return 0;
    if (a === b) return 1;
    var d = lev(a, b), m = Math.max(a.length, b.length);
    return 1 - d / m;
  }
  function ok(o) { return { success: true, data: (o === undefined ? null : o) }; }
  function fail(message, errors) { return { success: false, message: message, errors: errors || [] }; }
  function escCsv(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  return {
    normHeader: normHeader, normStr: normStr, normId: normId, normUom: normUom,
    toNumber: toNumber, pad: pad, lev: lev, similarity: similarity,
    ok: ok, fail: fail, escCsv: escCsv
  };
})();

/* --------------------------- Dates_ (tz-aware) -------------------------- */
var Dates_ = (function () {
  function tz() {
    try { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || Session.getScriptTimeZone(); }
    catch (e) { try { return Session.getScriptTimeZone(); } catch (e2) { return 'Asia/Kolkata'; } }
  }
  function toYmd(v) {
    if (v === null || v === undefined || v === '') return '';
    var d = null;
    if (Object.prototype.toString.call(v) === '[object Date]') d = v;
    else if (typeof v === 'number' && isFinite(v)) {
      // Excel serial (workbook may hold raw serials)
      d = new Date(Math.round((v - 25569) * 86400 * 1000));
    } else {
      var s = String(v).trim();
      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // yyyy-mm-dd
      if (m) return m[1] + '-' + m[2] + '-' + m[3];
      m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); // dd/mm/yyyy or mm/dd — assume dd/mm
      if (m) {
        var yy = m[3].length === 2 ? '20' + m[3] : m[3];
        return yy + '-' + Utils_.pad(m[2]) + '-' + Utils_.pad(m[1]);
      }
      var t = Date.parse(s); if (!isNaN(t)) d = new Date(t); else return '';
    }
    if (!d || isNaN(d.getTime())) return '';
    try { return Utilities.formatDate(d, tz(), 'yyyy-MM-dd'); }
    catch (e) { return d.getFullYear() + '-' + Utils_.pad(d.getMonth() + 1) + '-' + Utils_.pad(d.getDate()); }
  }
  function todayYmd() {
    try { return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd'); }
    catch (e) { var d = new Date(); return d.getFullYear() + '-' + Utils_.pad(d.getMonth() + 1) + '-' + Utils_.pad(d.getDate()); }
  }
  function toDate(v) { var y = toYmd(v); if (!y) return null; var p = y.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function nowStamp() { return new Date(); }
  return { tz: tz, toYmd: toYmd, todayYmd: todayYmd, toDate: toDate, nowStamp: nowStamp };
})();

/* ------------------------------ Schema_ --------------------------------- */
var Schema_ = (function () {
  // NOTE: there is deliberately NO cross-execution schema cache. A cached
  // column map goes stale the moment anyone inserts/deletes/renames a column,
  // and writing through a stale map silently puts data in the wrong columns
  // (orders that "read back without a customer"). MEMO dedupes only within
  // one execution; every discover() re-validates against live headers.
  var MEMO = {}; // per-execution cache
  function invalidate() {
    MEMO = {};
  }
  function findSheet(logical) {
    var ss;
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { throw new Error('Cannot access the workbook.'); }
    var names = CFG_.ALIASES[logical] || [logical];
    for (var i = 0; i < names.length; i++) {
      var sh = ss.getSheetByName(names[i]);
      if (sh) return sh;
    }
    return null;
  }
  // Returns {sheet, headerRow (1-based), map {key:colIndex0}, headers[], width}
  function discover(logical) {
    var sh = findSheet(logical);
    if (!sh) throw new Error('Sheet not found: ' + logical);
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (!lastRow || !lastCol) return { sheet: sh, headerRow: 1, map: {}, headers: [], width: 0 };
    // One small live probe first: trust the per-execution memo only if every
    // cached column still holds the same header AND the width is unchanged.
    var pr = Math.min(10, lastRow), pc = Math.min(30, lastCol);
    var probe = sh.getRange(1, 1, pr, pc).getValues();
    var cached = MEMO[logical];
    if (cached && cached.lastCol === lastCol && cached.headerRow <= probe.length) {
      var hrow = probe[cached.headerRow - 1] || [];
      var keys = 0, okMap = true;
      for (var ck in cached.map) {
        keys++;
        var cc = cached.map[ck];
        if (cc >= hrow.length || CFG_.SYN[Utils_.normHeader(hrow[cc])] !== ck) { okMap = false; break; }
      }
      if (okMap && keys > 0) {
        return { sheet: sh, headerRow: cached.headerRow, map: cached.map, headers: cached.headers, width: cached.width };
      }
    }
    var best = -1, bestScore = 1, bestMap = null;
    for (var r = 0; r < probe.length; r++) {
      var map = {}, score = 0, seen = {};
      for (var c = 0; c < probe[r].length; c++) {
        var key = CFG_.SYN[Utils_.normHeader(probe[r][c])];
        if (key && !seen[key]) { seen[key] = true; map[key] = c; score++; }
      }
      if (score > bestScore) { bestScore = score; best = r; bestMap = map; }
    }
    if (best < 0) { // fall back to row 1 literal mapping
      var map2 = {};
      for (var c2 = 0; c2 < probe[0].length; c2++) {
        var k2 = CFG_.SYN[Utils_.normHeader(probe[0][c2])];
        if (k2 && map2[k2] === undefined) map2[k2] = c2;
      }
      best = 0; bestMap = map2;
    }
    var headers = probe[best].map(function (h) { return String(h === null || h === undefined ? '' : h); });
    var out = { headerRow: best + 1, map: bestMap, headers: headers, width: probe[best].length, lastCol: lastCol };
    MEMO[logical] = out;
    return { sheet: sh, headerRow: out.headerRow, map: out.map, headers: out.headers, width: out.width };
  }
  return { findSheet: findSheet, discover: discover, invalidate: invalidate };
})();

/* -------------------------------- Data_ --------------------------------- */
var Data_ = (function () {
  var TABLE_MEMO = {};
  function lock(fn) {
    var l = LockService.getScriptLock();
    l.waitLock(30000);
    try { return fn(); } finally { try { l.releaseLock(); } catch (e) {} }
  }
  // Whole-table read: {schema, rows:[{rowNumber, raw[]}], lastRow}
  function readTable(logical) {
    if (TABLE_MEMO[logical]) return TABLE_MEMO[logical];
    var d = Schema_.discover(logical);
    var sh = d.sheet, t = null;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (!lastRow || !lastCol || lastRow <= d.headerRow) {
      t = { schema: d, rows: [], lastRow: lastRow };
    } else {
      var w = Math.max(d.width, lastCol);
      var vals = sh.getRange(d.headerRow + 1, 1, lastRow - d.headerRow, w).getValues();
      var rows = [];
      for (var i = 0; i < vals.length; i++) {
        var empty = true;
        for (var j = 0; j < vals[i].length; j++) {
          if (vals[i][j] !== '' && vals[i][j] !== null) { empty = false; break; }
        }
        if (!empty) rows.push({ rowNumber: d.headerRow + 1 + i, raw: vals[i] });
      }
      t = { schema: d, rows: rows, lastRow: lastRow };
    }
    TABLE_MEMO[logical] = t;
    return t;
  }
  function clearMemo(logical) {
    if (logical) delete TABLE_MEMO[logical];
    else TABLE_MEMO = {};
    try { CacheService.getScriptCache().remove('dash_v1'); } catch (e) {} // writes invalidate dashboard
  }
  function cell(raw, map, key) {
    var c = map[key];
    if (c === undefined || c >= raw.length) return '';
    var v = raw[c];
    return (v === null || v === undefined) ? '' : v;
  }
  function writeRow(logical, rowNumber, arr) {
    var d = Schema_.discover(logical);
    var w = Math.max(d.width, arr.length);
    d.sheet.getRange(rowNumber, 1, 1, w).setValues([arr]);
    clearMemo(logical);
  }
  function appendRows(logical, arrays) {
    if (!arrays.length) return [];
    var d = Schema_.discover(logical);
    var w = Math.max(d.width, arrays.reduce(function (m, a) { return Math.max(m, a.length); }, 0));
    var norm = arrays.map(function (a) { while (a.length < w) a.push(''); return a; });
    var start = Math.max(d.sheet.getLastRow(), d.headerRow) + 1;
    d.sheet.getRange(start, 1, norm.length, w).setValues(norm);
    clearMemo(logical);
    var out = []; for (var i = 0; i < norm.length; i++) out.push(start + i);
    return out;
  }
  function deleteRow(logical, rowNumber) {
    Schema_.discover(logical).sheet.deleteRow(rowNumber);
    clearMemo(logical);
  }
  function nextSl(logical) {
    var t = readTable(logical), m = t.schema.map, mx = 0;
    if (m.slNo === undefined) return '';
    t.rows.forEach(function (r) {
      var n = Utils_.toNumber(Data_.cell(r.raw, m, 'slNo'));
      if (isFinite(n) && n > mx) mx = n;
    });
    return mx + 1;
  }
  function logActivity(action, orderId, ledgerId, ledgerName, remarks) {
    try {
      var d = Schema_.discover(CFG_.SHEETS.ACTIVITY);
      var now = Dates_.nowStamp(), arr = new Array(Math.max(d.width, 8)).fill('');
      var put = function (k, v) { if (d.map[k] !== undefined) arr[d.map[k]] = v; };
      put('date', now); put('time', now);
      try { put('user', Session.getActiveUser().getEmail() || 'unknown'); } catch (e) { put('user', 'unknown'); }
      put('action', action); put('orderId', orderId || ''); put('ledgerId', ledgerId || '');
      put('ledgerName', ledgerName || ''); put('remarks', remarks || '');
      var start = Math.max(d.sheet.getLastRow(), d.headerRow) + 1;
      d.sheet.getRange(start, 1, 1, arr.length).setValues([arr]);
    } catch (e) {}
  }
  function logError(funcName, sheetName, rowNum, message, details) {
    try {
      var d = Schema_.discover(CFG_.SHEETS.ERRORS);
      var arr = new Array(Math.max(d.width, 6)).fill('');
      var put = function (k, v) { if (d.map[k] !== undefined) arr[d.map[k]] = v; };
      put('timestamp', Dates_.nowStamp()); put('date', Dates_.nowStamp());
      put('funcName', funcName); put('action', funcName);
      put('sheetName', sheetName || ''); put('sheet', sheetName || '');
      put('rowNum', rowNum || ''); put('row', rowNum || '');
      put('message', message || ''); put('details', details || '');
      var start = Math.max(d.sheet.getLastRow(), d.headerRow) + 1;
      d.sheet.getRange(start, 1, 1, arr.length).setValues([arr]);
    } catch (e) {}
  }
  return {
    lock: lock, readTable: readTable, clearMemo: clearMemo, cell: cell,
    writeRow: writeRow, appendRows: appendRows, deleteRow: deleteRow,
    nextSl: nextSl, logActivity: logActivity, logError: logError
  };
})();

/* ------------------------------ Customers_ ------------------------------ */
var Customers_ = (function () {
  // One entry per Key row: {rowNumber, slNo, customerStatus, empName, address,
  // route, routeDay, paymentTerms, ledgerName, ledgerId, approvedBlend, mobile, city, area}
  function rows() {
    var t = Data_.readTable(CFG_.SHEETS.KEY), m = t.schema.map;
    return t.rows.map(function (r) {
      var g = function (k) { return Data_.cell(r.raw, m, k); };
      return {
        rowNumber: r.rowNumber, slNo: g('slNo'), customerStatus: String(g('customerStatus') || 'Active'),
        empName: g('empName'), address: g('address'), route: g('route'), routeDay: g('routeDay'),
        paymentTerms: canonTerms(g('paymentTerms')), ledgerName: String(g('ledgerName') || ''),
        ledgerId: Utils_.normId(g('ledgerId')), approvedBlend: String(g('approvedBlend') || ''),
        mobile: String(g('mobile') || ''), city: g('city'), area: g('area')
      };
    }).filter(function (c) { return c.ledgerName !== ''; });
  }
  function canonTerms(v) {
    var n = Utils_.normStr(v);
    if (n === 'credit') return 'Credit';
    if (n === 'advance') return 'Advance';
    return String(v || '').trim();
  }
  // Grouped ledger list: [{ledgerId, ledgerName, customerStatus, address, route,
  // routeDay, paymentTerms, mobile, city, area, empName, approvedBlends[]}]
  function list() {
    var byId = {}, order = [];
    rows().forEach(function (r) {
      var id = r.ledgerId || ('NAME:' + Utils_.normStr(r.ledgerName));
      if (!byId[id]) {
        byId[id] = {
          ledgerId: r.ledgerId, ledgerName: r.ledgerName, customerStatus: r.customerStatus,
          empName: r.empName, address: r.address, route: r.route, routeDay: r.routeDay,
          paymentTerms: r.paymentTerms, mobile: r.mobile, city: r.city, area: r.area,
          approvedBlends: []
        };
        order.push(id);
      }
      var b = r.approvedBlend;
      if (b && byId[id].approvedBlends.indexOf(b) < 0) byId[id].approvedBlends.push(b);
    });
    return order.map(function (id) { return byId[id]; });
  }
  function findLedger(ledgers, ledgerId) {
    var nid = Utils_.normId(ledgerId);
    for (var i = 0; i < ledgers.length; i++) if (ledgers[i].ledgerId === nid) return ledgers[i];
    return null;
  }
  // Resolve a customer from {ledgerId?, ledgerName?}. Returns {ledger} or {error, suggestions}.
  function resolve(input) {
    var ledgers = list();
    if (input.ledgerId) {
      var l = findLedger(ledgers, input.ledgerId);
      if (l) return { ledger: l };
      return { error: 'Unknown Ledger ID "' + input.ledgerId + '".' };
    }
    var want = Utils_.normStr(input.ledgerName || '');
    if (!want) return { error: 'Ledger Name is required.' };
    for (var i = 0; i < ledgers.length; i++) {
      if (Utils_.normStr(ledgers[i].ledgerName) === want) return { ledger: ledgers[i] };
    }
    var scored = ledgers.map(function (x) {
      return { ledger: x, sim: Utils_.similarity(x.ledgerName, input.ledgerName) };
    }).filter(function (x) { return x.sim >= 0.55; })
      .sort(function (a, b) { return b.sim - a.sim; }).slice(0, 5);
    if (scored.length && scored[0].sim >= CFG_.FUZZY_ACCEPT) return { ledger: scored[0].ledger, fuzzy: true };
    return {
      error: 'Customer "' + input.ledgerName + '" not found in Customer Data.',
      suggestions: scored.map(function (x) { return x.ledger.ledgerName; })
    };
  }
  function search(q, limit) {
    var nq = Utils_.normStr(q || '');
    var all = list().filter(function (l) { return Utils_.normStr(l.customerStatus) !== 'inactive'; });
    if (!nq) return all.slice(0, limit || 20);
    var starts = [], contains = [], fuzzy = [];
    all.forEach(function (l) {
      var n = Utils_.normStr(l.ledgerName);
      if (n.indexOf(nq) === 0) starts.push(l);
      else if (n.indexOf(nq) >= 0) contains.push(l);
      else if (Utils_.similarity(n, nq) >= 0.6) fuzzy.push(l);
    });
    return starts.concat(contains, fuzzy).slice(0, limit || 20);
  }
  function activeBlends(ledger) {
    var pm = Products_.activeMap();
    return (ledger.approvedBlends || []).filter(function (b) {
      return pm[Utils_.normStr(b)] !== false; // keep unless explicitly Inactive
    });
  }
  function makeLedgerId(existing) {
    for (var i = 0; i < 500; i++) {
      var id = 'CUS' + (100000 + Math.floor(Math.random() * 900000));
      if (existing.indexOf(id) < 0) return id;
    }
    return 'CUS' + String(Date.now()).slice(-6);
  }
  function toKeyRow(ledger, blend) {
    var t = Data_.readTable(CFG_.SHEETS.KEY), m = t.schema.map, w = Math.max(t.schema.width, 1);
    var arr = new Array(w).fill('');
    var put = function (k, v) { if (m[k] !== undefined) arr[m[k]] = v; };
    put('slNo', Data_.nextSl(CFG_.SHEETS.KEY));
    put('customerStatus', ledger.customerStatus || 'Active');
    put('empName', ledger.empName || ''); put('address', ledger.address || '');
    put('route', ledger.route || ''); put('routeDay', ledger.routeDay || '');
    put('paymentTerms', ledger.paymentTerms || '');
    put('ledgerName', ledger.ledgerName); put('ledgerId', ledger.ledgerId);
    put('approvedBlend', blend || '');
    put('mobile', ledger.mobile || ''); put('city', ledger.city || ''); put('area', ledger.area || '');
    return arr;
  }
  function addCustomer(p) {
    return Data_.lock(function () {
      var name = String((p && p.ledgerName) || '').trim();
      if (!name) return Utils_.fail('Ledger Name is required.');
      var ledgers = list();
      var dup = ledgers.filter(function (l) { return Utils_.normStr(l.ledgerName) === Utils_.normStr(name); });
      if (dup.length) return Utils_.fail('Duplicate customer: "' + dup[0].ledgerName + '" already exists (' + dup[0].ledgerId + ').',
        [{ field: 'ledgerName', error: 'duplicate' }]);
      var near = ledgers.map(function (l) { return { l: l, s: Utils_.similarity(l.ledgerName, name) }; })
        .filter(function (x) { return x.s >= CFG_.FUZZY_ACCEPT; }).sort(function (a, b) { return b.s - a.s; });
      if (near.length && !(p && p.confirmSimilar)) {
        return Utils_.fail('"' + name + '" is very similar to existing "' + near[0].l.ledgerName + '". Confirm to create anyway.',
          [{ field: 'ledgerName', error: 'similar', suggestion: near[0].l.ledgerName }]);
      }
      var id = Utils_.normId((p && p.ledgerId) || '');
      if (id) {
        if (findLedger(ledgers, id)) return Utils_.fail('Duplicate Ledger ID "' + id + '".');
      } else {
        id = makeLedgerId(ledgers.map(function (l) { return l.ledgerId; }));
      }
      var terms = canonTerms((p && p.paymentTerms) || '');
      if (terms && CFG_.PAYMENT_TERMS.indexOf(terms) < 0) return Utils_.fail('Invalid Payment Terms. Use Advance or Credit.');
      var ledger = {
        ledgerId: id, ledgerName: name, customerStatus: (p && p.customerStatus) || 'Active',
        empName: (p && p.empName) || '', address: (p && p.address) || '', route: (p && p.route) || '',
        routeDay: (p && p.routeDay) || '', paymentTerms: terms || 'Advance',
        mobile: (p && p.mobile) || '', city: (p && p.city) || '', area: (p && p.area) || ''
      };
      var blends = (p && p.approvedBlends) || (p && p.approvedBlend ? [p.approvedBlend] : []);
      blends = blends.map(function (b) { return String(b).trim(); }).filter(function (b) { return b; });
      if (!blends.length) return Utils_.fail('At least one Approved Blend is required.');
      var chk = Products_.assertActive(blends);
      if (!chk.ok) return chk;
      Data_.appendRows(CFG_.SHEETS.KEY, blends.map(function (b) { return toKeyRow(ledger, b); }));
      Data_.logActivity('Customer Created', '', id, name, blends.join('; '));
      Schema_.invalidate();
      return Utils_.ok({ ledgerId: id, ledgerName: name, approvedBlends: blends });
    });
  }
  function updateCustomer(p) {
    return Data_.lock(function () {
      var id = Utils_.normId((p && p.ledgerId) || '');
      if (!id) return Utils_.fail('Ledger ID is required to edit a customer.');
      var ledgers = list();
      var cur = findLedger(ledgers, id);
      if (!cur) return Utils_.fail('Unknown Ledger ID "' + id + '".');
      if (p.ledgerName && Utils_.normStr(p.ledgerName) !== Utils_.normStr(cur.ledgerName)) {
        var clash = ledgers.filter(function (l) {
          return l.ledgerId !== id && Utils_.normStr(l.ledgerName) === Utils_.normStr(p.ledgerName);
        });
        if (clash.length) return Utils_.fail('Duplicate customer: "' + clash[0].ledgerName + '" already exists.');
      }
      var t = Data_.readTable(CFG_.SHEETS.KEY), m = t.schema.map;
      var mine = t.rows.filter(function (r) {
        return Utils_.normId(Data_.cell(r.raw, m, 'ledgerId')) === id;
      });
      if (!mine.length) return Utils_.fail('No rows found for Ledger ID "' + id + '".');
      var upd = {
        ledgerName: (p.ledgerName !== undefined ? String(p.ledgerName).trim() : cur.ledgerName),
        customerStatus: p.customerStatus || cur.customerStatus,
        empName: p.empName !== undefined ? p.empName : cur.empName,
        address: p.address !== undefined ? p.address : cur.address,
        route: p.route !== undefined ? p.route : cur.route,
        routeDay: p.routeDay !== undefined ? p.routeDay : cur.routeDay,
        paymentTerms: p.paymentTerms !== undefined ? canonTerms(p.paymentTerms) : cur.paymentTerms,
        mobile: p.mobile !== undefined ? p.mobile : cur.mobile,
        city: p.city !== undefined ? p.city : cur.city,
        area: p.area !== undefined ? p.area : cur.area
      };
      if (!upd.ledgerName) return Utils_.fail('Ledger Name cannot be empty.');
      if (upd.paymentTerms && CFG_.PAYMENT_TERMS.indexOf(upd.paymentTerms) < 0)
        return Utils_.fail('Invalid Payment Terms. Use Advance or Credit.');
      // Blend set replacement (only when caller sends approvedBlends explicitly)
      var newBlends = (p.approvedBlends !== undefined) ? p.approvedBlends : null;
      if (newBlends !== null) {
        newBlends = newBlends.map(function (b) { return String(b).trim(); }).filter(function (b) { return b; });
        if (!newBlends.length) return Utils_.fail('At least one Approved Blend is required.');
        var chk = Products_.assertActive(newBlends);
        if (!chk.ok) return chk;
        var seen = {};
        newBlends = newBlends.filter(function (b) { var k = Utils_.normStr(b); return seen[k] ? false : (seen[k] = true); });
      }
      var keepBlends = newBlends;
      mine.forEach(function (r, idx) {
        var arr = r.raw.slice();
        var put = function (k, v) { if (m[k] !== undefined) { while (arr.length <= m[k]) arr.push(''); arr[m[k]] = v; } };
        put('ledgerName', upd.ledgerName); put('customerStatus', upd.customerStatus);
        put('empName', upd.empName); put('address', upd.address); put('route', upd.route);
        put('routeDay', upd.routeDay); put('paymentTerms', upd.paymentTerms);
        put('mobile', upd.mobile); put('city', upd.city); put('area', upd.area);
        if (keepBlends) put('approvedBlend', keepBlends[idx] || '');
        Data_.writeRow(CFG_.SHEETS.KEY, r.rowNumber, arr);
      });
      if (keepBlends && keepBlends.length > mine.length) {
        var extraLedger = {
          ledgerId: id, ledgerName: upd.ledgerName, customerStatus: upd.customerStatus,
          empName: upd.empName, address: upd.address, route: upd.route, routeDay: upd.routeDay,
          paymentTerms: upd.paymentTerms, mobile: upd.mobile, city: upd.city, area: upd.area
        };
        Data_.appendRows(CFG_.SHEETS.KEY, keepBlends.slice(mine.length).map(function (b) { return toKeyRow(extraLedger, b); }));
      }
      if (keepBlends && keepBlends.length < mine.length) {
        // Remove surplus rows (highest row numbers first) — blend removed from customer.
        var surplus = mine.slice(keepBlends.length).map(function (r) { return r.rowNumber; })
          .sort(function (a, b) { return b - a; });
        surplus.forEach(function (rn) { Data_.deleteRow(CFG_.SHEETS.KEY, rn); });
      }
      Data_.logActivity('Customer Updated', '', id, upd.ledgerName, '');
      Data_.clearMemo();
      return Utils_.ok({ ledgerId: id, ledgerName: upd.ledgerName });
    });
  }
  function addApprovedBlend(p) {
    return Data_.lock(function () {
      var r = resolve({ ledgerId: p && p.ledgerId, ledgerName: p && p.ledgerName });
      if (r.error) return Utils_.fail(r.error, [{ error: r.error }]);
      var blend = String((p && p.blend) || (p && p.approvedBlend) || '').trim();
      if (!blend) return Utils_.fail('Blend is required.');
      var chk = Products_.assertActive([blend]);
      if (!chk.ok) return chk;
      var exists = (r.ledger.approvedBlends || []).some(function (b) { return Utils_.normStr(b) === Utils_.normStr(blend); });
      if (exists) return Utils_.fail('"' + blend + '" is already approved for "' + r.ledger.ledgerName + '".');
      var ledger = {
        ledgerId: r.ledger.ledgerId, ledgerName: r.ledger.ledgerName, customerStatus: r.ledger.customerStatus,
        empName: r.ledger.empName, address: r.ledger.address, route: r.ledger.route,
        routeDay: r.ledger.routeDay, paymentTerms: r.ledger.paymentTerms,
        mobile: r.ledger.mobile, city: r.ledger.city, area: r.ledger.area
      };
      Data_.appendRows(CFG_.SHEETS.KEY, [toKeyRow(ledger, blend)]);
      Data_.logActivity('Blend Approved', '', ledger.ledgerId, ledger.ledgerName, blend);
      return Utils_.ok({ ledgerId: ledger.ledgerId, blend: blend });
    });
  }
  function removeApprovedBlend(p) {
    return Data_.lock(function () {
      var id = Utils_.normId((p && p.ledgerId) || '');
      var blend = String((p && p.blend) || '').trim();
      if (!id || !blend) return Utils_.fail('Ledger ID and Blend are required.');
      var t = Data_.readTable(CFG_.SHEETS.KEY), m = t.schema.map;
      var mine = t.rows.filter(function (r) { return Utils_.normId(Data_.cell(r.raw, m, 'ledgerId')) === id; });
      if (mine.length <= 1) return Utils_.fail('Cannot remove the last approved blend of a customer.');
      var target = mine.filter(function (r) {
        return Utils_.normStr(Data_.cell(r.raw, m, 'approvedBlend')) === Utils_.normStr(blend);
      })[0];
      if (!target) return Utils_.fail('Blend not found for this customer.');
      Data_.deleteRow(CFG_.SHEETS.KEY, target.rowNumber);
      Data_.logActivity('Blend Removed', '', id, '', blend);
      return Utils_.ok({});
    });
  }
  return {
    rows: rows, list: list, resolve: resolve, search: search,
    activeBlends: activeBlends, makeLedgerId: makeLedgerId,
    addCustomer: addCustomer, updateCustomer: updateCustomer,
    addApprovedBlend: addApprovedBlend, removeApprovedBlend: removeApprovedBlend
  };
})();

/* ------------------------------ Products_ ------------------------------- */
var Products_ = (function () {
  // Robust read: Product Master columns are SKU ID | SKU Name | UOM | Status.
  function read() {
    var t = Data_.readTable(CFG_.SHEETS.PRODUCTS), m = t.schema.map;
    // 'SKU Name' maps to blendName via synonyms; fall back to positional col 1.
    var nameCol = (m.blendName !== undefined) ? m.blendName : 1;
    var uomCol = (m.uom !== undefined) ? m.uom : 2;
    var statusCol = (m.status !== undefined) ? m.status : 3;
    var idCol = (m.skuId !== undefined) ? m.skuId : 0;
    return t.rows.map(function (r) {
      var at = function (c) { return (c < r.raw.length && r.raw[c] !== null && r.raw[c] !== undefined) ? String(r.raw[c]) : ''; };
      return { rowNumber: r.rowNumber, skuId: at(idCol), name: at(nameCol), uom: Utils_.normUom(at(uomCol)) || at(uomCol), status: at(statusCol) };
    }).filter(function (p) { return p.name !== ''; });
  }
  // normalized name -> true (Active) / false (Inactive)
  function activeMap() {
    var map = {};
    read().forEach(function (p) {
      map[Utils_.normStr(p.name)] = Utils_.normStr(p.status) !== 'inactive';
    });
    return map;
  }
  function defaultUom(blend) {
    var n = Utils_.normStr(blend);
    var hit = read().filter(function (p) { return Utils_.normStr(p.name) === n; })[0];
    return hit ? Utils_.normUom(hit.uom) : '';
  }
  function assertActive(blends) {
    var pm = activeMap();
    var names = Object.keys(pm);
    for (var i = 0; i < blends.length; i++) {
      var b = String(blends[i]).trim(), n = Utils_.normStr(b);
      if (pm[n] === undefined) {
        var scored = names.map(function (k) { return { k: k, s: Utils_.similarity(k, n) }; })
          .filter(function (x) { return x.s >= 0.8; }).sort(function (a, b2) { return b2.s - a.s; }).slice(0, 3);
        var hint = scored.length ? ' Did you mean "' + read().filter(function (p) { return Utils_.normStr(p.name) === scored[0].k; })[0].name + '"?' : '';
        return Utils_.fail('"' + b + '" is not in Product Master.' + hint);
      }
      if (pm[n] === false) return Utils_.fail('"' + b + '" is Inactive in Product Master.');
    }
    return Utils_.ok({});
  }
  function addProduct(p) {
    return Data_.lock(function () {
      var name = String((p && (p.name || p.skuName)) || '').trim();
      if (!name) return Utils_.fail('SKU Name is required.');
      var uom = Utils_.normUom((p && p.uom) || '');
      if (CFG_.UOMS.indexOf(uom) < 0) return Utils_.fail('Invalid UOM. Use ' + CFG_.UOMS.join(', ') + '.');
      var existing = read().filter(function (x) { return Utils_.normStr(x.name) === Utils_.normStr(name); });
      if (existing.length) return Utils_.fail('Duplicate product: "' + existing[0].name + '" already exists.');
      var near = read().map(function (x) { return { x: x, s: Utils_.similarity(x.name, name) }; })
        .filter(function (a) { return a.s >= CFG_.FUZZY_ACCEPT; });
      if (near.length && !(p && p.confirmSimilar))
        return Utils_.fail('"' + name + '" is very similar to "' + near[0].x.name + '". Confirm to add anyway.');
      var t = Data_.readTable(CFG_.SHEETS.PRODUCTS), m = t.schema.map, w = Math.max(t.schema.width, 4);
      var arr = new Array(w).fill('');
      var put = function (k, v) { if (m[k] !== undefined) arr[m[k]] = v; };
      var skuId = String((p && (p.skuId)) || '').trim() || ('SKU' + String(Date.now()).slice(-6));
      if (m.skuId !== undefined) arr[m.skuId] = skuId; else arr[0] = skuId;
      if (m.blendName !== undefined) arr[m.blendName] = name; else arr[1] = name;
      if (m.uom !== undefined) arr[m.uom] = uom; else arr[2] = uom;
      if (m.status !== undefined) arr[m.status] = (p && p.status) || 'Active'; else arr[3] = (p && p.status) || 'Active';
      Data_.appendRows(CFG_.SHEETS.PRODUCTS, [arr]);
      Data_.logActivity('Product Added', '', '', '', name);
      return Utils_.ok({ name: name, uom: uom });
    });
  }
  return { list: read, read: read, activeMap: activeMap, defaultUom: defaultUom, assertActive: assertActive, addProduct: addProduct };
})();

/* ------------------------------- Orders_ -------------------------------- */
var Orders_ = (function () {
  var ORDER_KEYS = ['slNo', 'orderId', 'orderDate', 'ledgerName', 'blendName', 'qty', 'uom',
    'route', 'routeDay', 'billingDate', 'deliveredOn', 'remarks',
    'billingStatus', 'paymentStatus', 'paymentTerms', 'deliveryStatus'];
  function canonPayment(v) {
    var n = Utils_.normStr(v);
    if (n === 'waiting for payment' || n === 'waiting') return 'Waiting for Payment';
    if (n === 'payment received' || n === 'received' || n === 'paid') return 'Payment Received';
    if (n === 'credit') return 'Credit';
    return String(v || '').trim();
  }
  function canonBilling(v) {
    var n = Utils_.normStr(v);
    if (n === 'pending') return 'Pending';
    if (n === 'billed') return 'Billed';
    return String(v || '').trim();
  }
  function rowToApi(logical, raw, map, ledgerByName) {
    var g = function (k) { return Data_.cell(raw, map, k); };
    var qty = Utils_.toNumber(g('qty'));
    var o = {
      slNo: g('slNo'), orderId: String(g('orderId') || ''), orderDate: Dates_.toYmd(g('orderDate')),
      ledgerName: String(g('ledgerName') || ''), blendName: String(g('blendName') || ''),
      qty: isFinite(qty) ? qty : '', uom: String(g('uom') || ''),
      route: g('route'), routeDay: g('routeDay'),
      billingDate: Dates_.toYmd(g('billingDate')), deliveredOn: Dates_.toYmd(g('deliveredOn')),
      remarks: String(g('remarks') || ''),
      billingStatus: canonBilling(g('billingStatus')), paymentStatus: canonPayment(g('paymentStatus')),
      paymentTerms: String(g('paymentTerms') || ''), deliveryStatus: String(g('deliveryStatus') || ''),
      _sheet: logical
    };
    if (ledgerByName) {
      var l = ledgerByName[Utils_.normStr(o.ledgerName)];
      o._ledgerId = l ? l.ledgerId : '';
    }
    return o;
  }
  function ledgerIndex() {
    var idx = {};
    Customers_.list().forEach(function (l) { idx[Utils_.normStr(l.ledgerName)] = l; });
    return idx;
  }
  // Physical read of one workflow sheet. Rows without a customer are NOT valid
  // orders (e.g. half-written/externally-seeded stubs with only an Order ID):
  // they are excluded from views and counted as hiddenIncomplete so the UI
  // never renders the "empty row" bug. Nothing is deleted (non-destructive).
  function listBySheet(logical, opt) {
    var t = Data_.readTable(logical), m = t.schema.map;
    var idx = ledgerIndex();
    var hidden = 0;
    var out = [];
    t.rows.forEach(function (r) {
      var o = rowToApi(logical, r.raw, m, idx);
      o._rowNumber = r.rowNumber;
      if (o.ledgerName === '') { hidden++; return; }
      out.push(o);
    });
    var res = filterList(out, opt);
    res.hiddenIncomplete = (res.hiddenIncomplete || 0) + hidden;
    return res;
  }
  function filterList(out, opt) {
    opt = opt || {};
    if (opt.q) {
      var nq = Utils_.normStr(opt.q);
      out = out.filter(function (o) {
        return Utils_.normStr(o.orderId + ' ' + o.ledgerName + ' ' + o.blendName + ' ' + (o.remarks || '')).indexOf(nq) >= 0;
      });
    }
    var total = out.length;
    var offset = Math.max(0, opt.offset | 0), limit = Math.min(2000, Math.max(1, opt.limit | 0 || 200));
    return { rows: out.slice(offset, offset + limit), total: total };
  }
  function allOrderIds() {
    var ids = {};
    [CFG_.SHEETS.TRACKER, CFG_.SHEETS.BILLING, CFG_.SHEETS.PENDING, CFG_.SHEETS.DELIVERED].forEach(function (s) {
      try {
        var t = Data_.readTable(s), m = t.schema.map;
        if (m.orderId === undefined) return;
        t.rows.forEach(function (r) {
          var id = Utils_.normId(Data_.cell(r.raw, m, 'orderId'));
          if (id) ids[id] = true;
        });
      } catch (e) {}
    });
    return ids;
  }
  function makeOrderId(existingIds) {
    var d = new Date(), base;
    try { base = Utilities.formatDate(d, Dates_.tz(), 'yyyyMMdd'); }
    catch (e) { base = d.getFullYear() + Utils_.pad(d.getMonth() + 1) + Utils_.pad(d.getDate()); }
    for (var seq = 1; seq <= 9999; seq++) {
      var id = 'ORD' + base + Utils_.pad(seq, 4);
      if (!existingIds[Utils_.normId(id)]) return id;
    }
    return 'ORD' + base + Utils_.pad(Math.floor(Math.random() * 9000) + 1000, 4) + 'X';
  }
  // Find an order anywhere (active sheets first, then history).
  function findOrder(orderId) {
    var nid = Utils_.normId(orderId);
    var sheets = [CFG_.SHEETS.TRACKER, CFG_.SHEETS.BILLING, CFG_.SHEETS.PENDING, CFG_.SHEETS.DELIVERED];
    for (var i = 0; i < sheets.length; i++) {
      try {
        var t = Data_.readTable(sheets[i]), m = t.schema.map;
        for (var j = 0; j < t.rows.length; j++) {
          if (Utils_.normId(Data_.cell(t.rows[j].raw, m, 'orderId')) === nid) {
            var o = rowToApi(sheets[i], t.rows[j].raw, m, ledgerIndex());
            o._rowNumber = t.rows[j].rowNumber;
            return { order: o, sheet: sheets[i], rowNumber: t.rows[j].rowNumber, raw: t.rows[j].raw, map: m };
          }
        }
      } catch (e) {}
    }
    return null;
  }
  function validatePayload(p, isUpdate) {
    var errors = [];
    var qty = Utils_.toNumber(p.qty);
    if (!isFinite(qty) || qty <= 0) errors.push({ field: 'qty', error: 'Quantity must be a positive number.' });
    var uom = Utils_.normUom(p.uom || '');
    if (p.uom && CFG_.UOMS.indexOf(uom) < 0) errors.push({ field: 'uom', error: 'Invalid UOM. Use ' + CFG_.UOMS.join(', ') + '.' });
    ['orderDate', 'billingDate', 'deliveredOn'].forEach(function (f) {
      if (p[f] !== undefined && p[f] !== '' && p[f] !== null && !Dates_.toYmd(p[f]))
        errors.push({ field: f, error: 'Invalid date.' });
    });
    if (p.paymentStatus !== undefined && p.paymentStatus !== '' &&
      CFG_.PAYMENT_STATUSES.map(Utils_.normStr).indexOf(Utils_.normStr(p.paymentStatus)) < 0)
      errors.push({ field: 'paymentStatus', error: 'Invalid Payment Status.' });
    return errors;
  }
  // Shared create/update core. isUpdate=true keeps identity.
  function saveCore(p, isUpdate) {
    var res = Customers_.resolve({ ledgerId: p.ledgerId, ledgerName: p.ledgerName });
    if (res.error) {
      var r = Utils_.fail(res.error, [{ field: 'ledgerName', error: res.error }]);
      r.suggestions = res.suggestions || [];
      return r;
    }
    var ledger = res.ledger;
    if (Utils_.normStr(ledger.customerStatus) === 'inactive')
      return Utils_.fail('"' + ledger.ledgerName + '" is Inactive. Reactivate the customer first.');
    var blend = String(p.blendName || '').trim();
    if (!blend) return Utils_.fail('Blend is required.');
    var approved = (ledger.approvedBlends || []).some(function (b) { return Utils_.normStr(b) === Utils_.normStr(blend); });
    if (!approved)
      return Utils_.fail('"' + blend + '" is not an approved active blend for "' + ledger.ledgerName + '".',
        [{ field: 'blendName', error: 'not-approved' }]);
    var chk = Products_.assertActive([blend]);
    if (!chk.ok) return chk;
    var errs = validatePayload(p, isUpdate);
    var uom = Utils_.normUom(p.uom || '');
    if (!uom) {
      uom = Products_.defaultUom(blend);
      if (!uom) errs.push({ field: 'uom', error: 'UOM is required.' });
    }
    if (errs.length) return Utils_.fail(errs[0].error, errs);
    var terms = ledger.paymentTerms || 'Advance';
    var pay = canonPayment(p.paymentStatus !== undefined && p.paymentStatus !== '' ? p.paymentStatus :
      (Utils_.normStr(terms) === 'credit' ? 'Credit' : 'Waiting for Payment'));
    var order = {
      orderId: p.orderId, orderDate: Dates_.toYmd(p.orderDate) || Dates_.todayYmd(),
      ledgerName: ledger.ledgerName, blendName: blend,
      qty: Utils_.toNumber(p.qty), uom: uom,
      route: (p.route !== undefined && p.route !== '') ? p.route : ledger.route,
      routeDay: (p.routeDay !== undefined && p.routeDay !== '') ? p.routeDay : ledger.routeDay,
      billingDate: Dates_.toYmd(p.billingDate),
      deliveredOn: Dates_.toYmd(p.deliveredOn),
      remarks: String(p.remarks || ''),
      billingStatus: canonBilling(p.billingStatus || ''),
      paymentStatus: pay, paymentTerms: terms, deliveryStatus: String(p.deliveryStatus || '')
    };
    if (res.fuzzy) order._matchedAs = ledger.ledgerName;
    return Utils_.ok(order);
  }
  function toRowArray(logical, o) {
    var d = Schema_.discover(logical), m = d.map, w = Math.max(d.width, 1);
    var arr = new Array(w).fill('');
    var put = function (k, v) { if (m[k] !== undefined) arr[m[k]] = v; };
    var disp = function (y) { return y ? Dates_.toDate(y) : ''; };
    put('slNo', o.slNo !== undefined ? o.slNo : Data_.nextSl(logical));
    put('orderId', o.orderId); put('orderDate', disp(o.orderDate));
    put('ledgerName', o.ledgerName); put('blendName', o.blendName);
    put('qty', o.qty); put('uom', o.uom); put('route', o.route); put('routeDay', o.routeDay);
    put('billingDate', disp(o.billingDate)); put('deliveredOn', disp(o.deliveredOn));
    put('remarks', o.remarks); put('billingStatus', o.billingStatus);
    put('paymentStatus', o.paymentStatus); put('paymentTerms', o.paymentTerms);
    put('deliveryStatus', o.deliveryStatus);
    return arr;
  }
  function create(p) {
    return Data_.lock(function () {
      var v = saveCore(p || {}, false);
      if (!v.success) return v;
      var order = v.data;
      var ids = allOrderIds();
      if (order.orderId) {
        if (ids[Utils_.normId(order.orderId)])
          return Utils_.fail('Duplicate Order ID "' + order.orderId + '".', [{ field: 'orderId', error: 'duplicate' }]);
      } else {
        order.orderId = makeOrderId(ids);
      }
      Data_.appendRows(CFG_.SHEETS.TRACKER, [toRowArray(CFG_.SHEETS.TRACKER, order)]);
      Data_.logActivity('Order Created', order.orderId, '', order.ledgerName, order.blendName + ' x ' + order.qty);
      Data_.clearMemo();
      var moved = Workflow_.sync();
      // Read-back verification: the row must come back with its customer.
      // If it doesn't, the sheet columns shifted — fail loudly with debug info
      // instead of silently producing another "empty" row.
      Data_.clearMemo();
      var check = findOrder(order.orderId);
      if (!check || String(check.order.ledgerName || '') === '') {
        var dbg = { orderId: order.orderId };
        try {
          var dt = Data_.readTable(CFG_.SHEETS.TRACKER);
          dbg.headerRow = dt.schema.headerRow; dbg.headers = dt.schema.headers;
        } catch (e) { dbg.schemaError = String((e && e.message) || e); }
        var fr = Utils_.fail('Order ' + order.orderId + ' was written but reads back without a customer. The Order Tracker header/columns may have shifted — check the sheet headers.', [{ field: 'ledgerName', error: 'readback-empty' }]);
        fr.debug = dbg;
        return fr;
      }
      return Utils_.ok({ orderId: order.orderId, sync: moved });
    });
  }
  function update(p) {
    return Data_.lock(function () {
      var id = String((p && p.orderId) || '').trim();
      if (!id) return Utils_.fail('Order ID is required to edit an order.');
      var found = findOrder(id);
      if (!found) return Utils_.fail('Order "' + id + '" not found.');
      if (found.sheet === CFG_.SHEETS.DELIVERED)
        return Utils_.fail('Delivered orders are permanent history and cannot be edited.');
      var merged = {
        ledgerId: p.ledgerId, ledgerName: p.ledgerName !== undefined ? p.ledgerName : found.order.ledgerName,
        blendName: p.blendName !== undefined ? p.blendName : found.order.blendName,
        qty: p.qty !== undefined ? p.qty : found.order.qty,
        uom: p.uom !== undefined ? p.uom : found.order.uom,
        orderDate: p.orderDate !== undefined ? p.orderDate : found.order.orderDate,
        billingDate: p.billingDate !== undefined ? p.billingDate : found.order.billingDate,
        deliveredOn: p.deliveredOn !== undefined ? p.deliveredOn : found.order.deliveredOn,
        remarks: p.remarks !== undefined ? p.remarks : found.order.remarks,
        paymentStatus: p.paymentStatus !== undefined ? p.paymentStatus : found.order.paymentStatus,
        billingStatus: p.billingStatus !== undefined ? p.billingStatus : found.order.billingStatus,
        deliveryStatus: p.deliveryStatus !== undefined ? p.deliveryStatus : found.order.deliveryStatus,
        paymentTerms: found.order.paymentTerms
      };
      // Preserve explicit route edits; re-fill from master only when customer changed.
      var custChanged = (p.ledgerId || Utils_.normStr(p.ledgerName || '') !== Utils_.normStr(found.order.ledgerName));
      if (!custChanged) { merged.route = found.order.route; merged.routeDay = found.order.routeDay; }
      var v = saveCore(merged, true);
      if (!v.success) return v;
      var order = v.data;
      order.orderId = found.order.orderId;
      order.slNo = found.order.slNo;
      if (!custChanged) { order.route = merged.route; order.routeDay = merged.routeDay; }
      if (p.route !== undefined) order.route = p.route;
      if (p.routeDay !== undefined) order.routeDay = p.routeDay;
      var arr = toRowArray(found.sheet, order);
      // Keep original SL No cell
      Data_.writeRow(found.sheet, found.rowNumber, arr);
      Data_.logActivity('Order Updated', order.orderId, '', order.ledgerName, '');
      Data_.clearMemo();
      var moved = Workflow_.sync();
      return Utils_.ok({ orderId: order.orderId, sync: moved });
    });
  }
  function remove(orderId) {
    return Data_.lock(function () {
      var id = String(orderId || '').trim();
      if (!id) return Utils_.fail('Order ID is required.');
      var found = findOrder(id);
      if (!found) return Utils_.fail('Order "' + id + '" not found.');
      if (found.sheet === CFG_.SHEETS.DELIVERED)
        return Utils_.fail('Delivered orders are permanent history and cannot be deleted.');
      Data_.deleteRow(found.sheet, found.rowNumber);
      Data_.logActivity('Order Deleted', id, '', found.order.ledgerName, 'from ' + found.sheet);
      return Utils_.ok({ orderId: id });
    });
  }
  return {
    ORDER_KEYS: ORDER_KEYS, canonPayment: canonPayment, canonBilling: canonBilling,
    rowToApi: rowToApi, listBySheet: listBySheet, findOrder: findOrder,
    allOrderIds: allOrderIds, makeOrderId: makeOrderId,
    create: create, update: update, remove: remove,
    toRowArray: toRowArray, validatePayload: validatePayload
  };
})();

/* ------------------------------ Workflow_ ------------------------------- */
var Workflow_ = (function () {
  function isPaymentReady(o) {
    var n = Utils_.normStr(o.paymentStatus);
    return n === 'payment received' || n === 'credit';
  }
  function isBilled(o) { return Utils_.normStr(o.billingStatus) === 'billed'; }
  function isDelivered(o) {
    return Utils_.normStr(o.deliveryStatus) === 'delivered' || !!o.deliveredOn;
  }
  // Logical owner of an order: 'tracker' | 'billing' | 'pending' | 'delivered'
  function ownerOf(o, today) {
    today = today || Dates_.todayYmd();
    if (isDelivered(o)) return 'delivered';
    if (isBilled(o)) return 'pending';
    if (o.billingDate && o.billingDate <= today && isPaymentReady(o)) return 'billing';
    return 'tracker';
  }
  function sheetFor(owner) {
    return owner === 'billing' ? CFG_.SHEETS.BILLING :
      owner === 'pending' ? CFG_.SHEETS.PENDING :
      owner === 'delivered' ? CFG_.SHEETS.DELIVERED : CFG_.SHEETS.TRACKER;
  }
  function snapshot(logical) {
    var t = Data_.readTable(logical), m = t.schema.map, idx = {};
    var map = {};
    t.rows.forEach(function (r) {
      var o = Orders_.rowToApi(logical, r.raw, m, idx);
      o._rowNumber = r.rowNumber;
      if (!o.orderId) return;
      var k = Utils_.normId(o.orderId);
      if (!map[k]) map[k] = { api: o, rowNumber: r.rowNumber, raw: r.raw };
    });
    return { table: t, map: map };
  }
  // State-based sync. NEVER clears Delivered Orders — upsert only.
  // Returns {moved, updatedHistory, removedDupes}.
  function sync() {
    return Data_.lock(function () {
      var today = Dates_.todayYmd();
      var snaps = {}, i;
      [CFG_.SHEETS.TRACKER, CFG_.SHEETS.BILLING, CFG_.SHEETS.PENDING, CFG_.SHEETS.DELIVERED]
        .forEach(function (s) { snaps[s] = snapshot(s); });
      var moved = 0, updatedHistory = 0;
      var removedDupes = removeActiveDupes(snaps);
      // Refresh after dupe removal
      [CFG_.SHEETS.TRACKER, CFG_.SHEETS.BILLING, CFG_.SHEETS.PENDING].forEach(function (s) { snaps[s] = snapshot(s); });
      var activeKeys = {};
      [CFG_.SHEETS.TRACKER, CFG_.SHEETS.BILLING, CFG_.SHEETS.PENDING].forEach(function (s) {
        Object.keys(snaps[s].map).forEach(function (k) { activeKeys[k] = s; });
      });
      Object.keys(activeKeys).forEach(function (key) {
        var fromSheet = activeKeys[key];
        var entry = snaps[fromSheet].map[key];
        if (!entry) return;
        var o = entry.api;
        // Degenerate stub rows (no customer) are left alone but logged once
        // per day — never auto-deleted, never moved.
        if (!o.ledgerName) { logDegenOnce(fromSheet, entry.rowNumber, o.orderId); return; }
        var owner = ownerOf(o, today);
        if (owner === 'delivered') {
          // Upsert into history, then drop the active copy.
          var hist = snaps[CFG_.SHEETS.DELIVERED].map[key];
          if (hist) {
            var changed = ['billingStatus', 'paymentStatus', 'remarks', 'deliveredOn', 'billingDate', 'qty', 'blendName']
              .some(function (f) { return String(hist.api[f] || '') !== String(o[f] || ''); });
            if (changed) {
              var hrow = Orders_.toRowArray(CFG_.SHEETS.DELIVERED, o);
              hrow = keepSl(hrow, CFG_.SHEETS.DELIVERED, hist.raw);
              Data_.writeRow(CFG_.SHEETS.DELIVERED, hist.rowNumber, hrow);
              updatedHistory++;
            }
          } else {
            Data_.appendRows(CFG_.SHEETS.DELIVERED, [Orders_.toRowArray(CFG_.SHEETS.DELIVERED, stampDelivered(o))]);
            updatedHistory++;
          }
          Data_.deleteRow(fromSheet, entry.rowNumber);
          Data_.logActivity('Order Delivered', o.orderId, '', o.ledgerName, fromSheet + ' → Delivered Orders');
          moved++;
        } else {
          var dest = sheetFor(owner);
          var want = (owner === 'billing' && !Orders_.canonBilling(o.billingStatus))
            ? 'Pending' : o.billingStatus;
          if (dest !== fromSheet) {
            var copy = {};
            for (var f in o) copy[f] = o[f];
            copy.billingStatus = want;
            Data_.appendRows(dest, [Orders_.toRowArray(dest, copy)]);
            Data_.deleteRow(fromSheet, entry.rowNumber);
            Data_.logActivity('Order Moved', o.orderId, '', o.ledgerName, fromSheet + ' → ' + dest);
            moved++;
          } else if (want !== o.billingStatus) {
            var arr = entry.raw.slice(), m = snaps[fromSheet].table.schema.map;
            if (m.billingStatus !== undefined) {
              while (arr.length <= m.billingStatus) arr.push('');
              arr[m.billingStatus] = want;
              Data_.writeRow(fromSheet, entry.rowNumber, arr);
              updatedHistory++;
            }
          }
        }
      });
      if (moved || updatedHistory || removedDupes) { Data_.clearMemo(); Schema_.invalidate(); }
      return { moved: moved, updatedHistory: updatedHistory, removedDupes: removedDupes };
    });
  }
  function stampDelivered(o) {
    var c = {};
    for (var f in o) c[f] = o[f];
    if (!c.deliveredOn) c.deliveredOn = Dates_.todayYmd();
    c.deliveryStatus = 'Delivered';
    if (!Orders_.canonBilling(c.billingStatus)) c.billingStatus = 'Billed';
    return c;
  }
  function keepSl(rowArr, logical, oldRaw) {
    try {
      var m = Data_.readTable(logical).schema.map;
      if (m.slNo !== undefined && oldRaw.length > m.slNo) {
        while (rowArr.length <= m.slNo) rowArr.push('');
        rowArr[m.slNo] = oldRaw[m.slNo];
      }
    } catch (e) {}
    return rowArr;
  }
  function logDegenOnce(sheet, rowNumber, orderId) {
    try {
      var ck = 'degen_' + Utils_.normId(orderId || (sheet + ':' + rowNumber));
      var c = CacheService.getScriptCache().get(ck);
      if (c) return;
      CacheService.getScriptCache().put(ck, '1', 86400);
      Data_.logError('sync', sheet, rowNumber, 'Incomplete row skipped (has Order ID but no customer)', orderId);
    } catch (e) {}
  }
  // Inspect degenerate rows (Order ID but no customer) across active sheets.
  // Returns raw display values + headers so the cause is visible, not guessed.
  function inspectIncomplete() {
    var out = [];
    CFG_.ACTIVE_SHEETS.forEach(function (logical) {
      try {
        var t = Data_.readTable(logical), m = t.schema.map, sh = t.schema.sheet;
        var lastRow = sh.getLastRow();
        if (!lastRow || lastRow <= t.schema.headerRow) return;
        var w = Math.max(t.schema.width, sh.getLastColumn());
        var disp = sh.getRange(t.schema.headerRow + 1, 1, lastRow - t.schema.headerRow, w).getDisplayValues();
        var at = function (arr, k) { return (m[k] === undefined || m[k] >= arr.length) ? '' : String(arr[m[k]] === null || arr[m[k]] === undefined ? '' : arr[m[k]]); };
        t.rows.forEach(function (r) {
          if (String(Data_.cell(r.raw, m, 'ledgerName') || '') !== '') return;
          var hasAnything = r.raw.some(function (v) { return v !== '' && v !== null && v !== undefined; });
          if (!hasAnything) return;
          var di = r.rowNumber - (t.schema.headerRow + 1);
          var drow = (di >= 0 && di < disp.length) ? disp[di] : [];
          out.push({
            sheet: logical, rowNumber: r.rowNumber,
            orderId: at(r.raw, 'orderId'), ledgerName: at(r.raw, 'ledgerName'),
            blendName: at(r.raw, 'blendName'), qty: at(r.raw, 'uom') !== undefined ? at(r.raw, 'qty') : '',
            headers: t.schema.headers, headerRow: t.schema.headerRow,
            cells: drow.map(String).slice(0, t.schema.headers.length)
          });
          if (out.length >= 20) return;
        });
      } catch (e) { out.push({ sheet: logical, error: String((e && e.message) || e) }); }
    });
    return out;
  }
  // Delete ONE degenerate stub row (refuses if it now has a customer = real data).
  function deleteStub(p) {
    return Data_.lock(function () {
      var logical = String((p && p.sheet) || '');
      var rn = Number((p && p.rowNumber) || 0);
      var oid = Utils_.normId((p && p.orderId) || '');
      if (CFG_.ACTIVE_SHEETS.indexOf(logical) < 0) return Utils_.fail('Unknown sheet.');
      if (!rn) return Utils_.fail('Row number is required.');
      var t = Data_.readTable(logical), m = t.schema.map;
      var hit = t.rows.filter(function (r) { return r.rowNumber === rn; })[0];
      if (!hit) return Utils_.fail('Row no longer exists.');
      var ledger = String(Data_.cell(hit.raw, m, 'ledgerName') || '');
      if (ledger !== '') return Utils_.fail('Row now has a customer ("' + ledger + '") — not deleted. It is real data.');
      if (oid && Utils_.normId(Data_.cell(hit.raw, m, 'orderId')) !== oid) {
        return Utils_.fail('Row content changed — not deleted. Re-inspect first.');
      }
      Data_.deleteRow(logical, rn);
      Data_.logActivity('Stub Row Deleted', oid, '', '', 'from ' + logical + ' row ' + rn);
      Data_.clearMemo();
      return Utils_.ok({ sheet: logical, rowNumber: rn });
    });
  }
  function removeActiveDupes(snaps) {
    var seen = {}, n = 0;
    var order = [CFG_.SHEETS.TRACKER, CFG_.SHEETS.BILLING, CFG_.SHEETS.PENDING];
    // Collect all, delete extras (highest row numbers first for safety).
    var extras = [];
    order.forEach(function (s) {
      Object.keys(snaps[s].map).forEach(function (k) {
        if (seen[k]) extras.push({ sheet: s, rowNumber: snaps[s].map[k].rowNumber, key: k });
        else seen[k] = s;
      });
    });
    extras.sort(function (a, b) { return b.rowNumber - a.rowNumber; });
    var bySheet = {};
    extras.forEach(function (e) {
      (bySheet[e.sheet] = bySheet[e.sheet] || []).push(e);
    });
    Object.keys(bySheet).forEach(function (s) {
      bySheet[s].sort(function (a, b) { return b.rowNumber - a.rowNumber; }).forEach(function (e) {
        try {
          Data_.deleteRow(s, e.rowNumber);
          Data_.logError('sync', s, e.rowNumber, 'Duplicate active row removed', e.key);
          n++;
        } catch (err) {}
      });
    });
    return n;
  }
  function setPaymentStatus(p) {
    return Data_.lock(function () {
      var id = String((p && p.orderId) || '').trim();
      var st = Orders_.canonPayment((p && p.paymentStatus) || '');
      if (!id) return Utils_.fail('Order ID is required.');
      if (CFG_.PAYMENT_STATUSES.map(Utils_.normStr).indexOf(Utils_.normStr(st)) < 0)
        return Utils_.fail('Invalid Payment Status. Use ' + CFG_.PAYMENT_STATUSES.join(', ') + '.');
      var found = Orders_.findOrder(id);
      if (!found) return Utils_.fail('Order "' + id + '" not found.');
      if (found.sheet === CFG_.SHEETS.DELIVERED) return Utils_.fail('Delivered orders cannot be changed.');
      var arr = found.raw.slice();
      if (found.map.paymentStatus === undefined) return Utils_.fail('Payment Status column not found in ' + found.sheet + '.');
      while (arr.length <= found.map.paymentStatus) arr.push('');
      arr[found.map.paymentStatus] = st;
      Data_.writeRow(found.sheet, found.rowNumber, arr);
      Data_.logActivity('Payment Updated', id, '', found.order.ledgerName, st);
      Data_.clearMemo();
      var moved = sync();
      return Utils_.ok({ orderId: id, paymentStatus: st, sync: moved });
    });
  }
  function setBillingStatus(p) {
    return Data_.lock(function () {
      var id = String((p && p.orderId) || '').trim();
      var st = Orders_.canonBilling((p && p.billingStatus) || '');
      if (!id) return Utils_.fail('Order ID is required.');
      if (CFG_.BILLING_STATUSES.map(Utils_.normStr).indexOf(Utils_.normStr(st)) < 0)
        return Utils_.fail('Invalid Billing Status. Use ' + CFG_.BILLING_STATUSES.join(', ') + '.');
      var found = Orders_.findOrder(id);
      if (!found) return Utils_.fail('Order "' + id + '" not found.');
      if (found.sheet === CFG_.SHEETS.DELIVERED) return Utils_.fail('Delivered orders cannot be changed.');
      if (st === 'Billed' && !isPaymentReady(found.order) &&
        Utils_.normStr(found.order.paymentStatus) !== '')
        return Utils_.fail('Collect payment (or set Credit) before marking Billed. Current: "' + found.order.paymentStatus + '".');
      var arr = found.raw.slice();
      if (found.map.billingStatus === undefined) return Utils_.fail('Billing Status column not found in ' + found.sheet + '.');
      while (arr.length <= found.map.billingStatus) arr.push('');
      arr[found.map.billingStatus] = st;
      Data_.writeRow(found.sheet, found.rowNumber, arr);
      Data_.logActivity('Billing Updated', id, '', found.order.ledgerName, st);
      Data_.clearMemo();
      var moved = sync();
      return Utils_.ok({ orderId: id, billingStatus: st, sync: moved });
    });
  }
  function setDelivered(p) {
    return Data_.lock(function () {
      var id = String((p && p.orderId) || '').trim();
      if (!id) return Utils_.fail('Order ID is required.');
      var found = Orders_.findOrder(id);
      if (!found) return Utils_.fail('Order "' + id + '" not found.');
      if (found.sheet === CFG_.SHEETS.DELIVERED) return Utils_.fail('Order "' + id + '" is already delivered.');
      var on = Dates_.toYmd((p && (p.deliveredOn || p.deliveredDate)) || '') || Dates_.todayYmd();
      var arr = found.raw.slice();
      if (found.map.deliveredOn !== undefined) {
        while (arr.length <= found.map.deliveredOn) arr.push('');
        arr[found.map.deliveredOn] = Dates_.toDate(on);
      }
      if (found.map.deliveryStatus !== undefined) {
        while (arr.length <= found.map.deliveryStatus) arr.push('');
        arr[found.map.deliveryStatus] = 'Delivered';
      } else {
        return Utils_.fail('This sheet has no Delivery Status / Delivered on column; mark Billed first.');
      }
      Data_.writeRow(found.sheet, found.rowNumber, arr);
      Data_.logActivity('Order Delivered', id, '', found.order.ledgerName, on);
      Data_.clearMemo();
      var moved = sync();
      return Utils_.ok({ orderId: id, deliveredOn: on, sync: moved });
    });
  }
  return {
    isPaymentReady: isPaymentReady, isBilled: isBilled, isDelivered: isDelivered,
    ownerOf: ownerOf, sheetFor: sheetFor, sync: sync,
    setPaymentStatus: setPaymentStatus, setBillingStatus: setBillingStatus, setDelivered: setDelivered,
    inspectIncomplete: inspectIncomplete, deleteStub: deleteStub
  };
})();

/* ------------------------------- Reports_ ------------------------------- */
var Reports_ = (function () {
  function activeAll() {
    var out = [], hidden = 0;
    CFG_.ACTIVE_SHEETS.forEach(function (s) {
      try {
        var r = Orders_.listBySheet(s, {});
        out = out.concat(r.rows);
        hidden += r.hiddenIncomplete | 0;
      } catch (e) {}
    });
    return { orders: out, hidden: hidden };
  }
  function deliveredAll() {
    try { return Orders_.listBySheet(CFG_.SHEETS.DELIVERED, { limit: 2000 }).rows; }
    catch (e) { return []; }
  }
  function dashboard() {
    var cached = dashCacheGet();
    if (cached) return cached;
    var act = activeAll();
    var active = act.orders, hidden = act.hidden;
    var delivered = deliveredAll();
    var today = Dates_.todayYmd();
    var todayOrders = 0, todayQty = 0, overdue = 0;
    var byCust = {}, byBlend = {};
    var bump = function (o, map, k) {
      if (!map[k]) map[k] = { orders: 0, qty: 0, last: '' };
      map[k].orders++;
      map[k].qty += (Number(o.qty) || 0);
      if (o.orderDate && o.orderDate > map[k].last) map[k].last = o.orderDate;
    };
    active.forEach(function (o) {
      var q = Number(o.qty) || 0;
      if (o.billingDate === today) { todayOrders++; todayQty += q; }
      if (o.billingDate && o.billingDate < today && !Workflow_.isBilled(o)) overdue++;
      bump(o, byCust, o.ledgerName || '(unknown)');
      bump(o, byBlend, o.blendName || '(unknown)');
    });
    delivered.forEach(function (o) {
      bump(o, byCust, o.ledgerName || '(unknown)');
      bump(o, byBlend, o.blendName || '(unknown)');
    });
    var idByName = {};
    Customers_.list().forEach(function (l) { idByName[Utils_.normStr(l.ledgerName)] = l.ledgerId; });
    var topCustomers = Object.keys(byCust).map(function (k) {
      return { ledgerId: idByName[Utils_.normStr(k)] || '', ledgerName: k, orders: byCust[k].orders, quantity: byCust[k].qty, lastOrderDate: byCust[k].last };
    }).sort(function (a, b) { return b.quantity - a.quantity; }).slice(0, 10);
    var topBlends = Object.keys(byBlend).map(function (k) {
      return { blendName: k, orders: byBlend[k].orders, quantity: byBlend[k].qty };
    }).sort(function (a, b) { return b.quantity - a.quantity; }).slice(0, 10);
    var customers = Customers_.list();
    var res = {
      todayOrders: todayOrders, todayQuantity: todayQty,
      pendingOrders: active.length, deliveredOrders: delivered.length,
      overdueOrders: overdue, hiddenIncomplete: hidden,
      totalActiveCustomers: customers.filter(function (c) { return Utils_.normStr(c.customerStatus) !== 'inactive'; }).length,
      topCustomers: topCustomers, topBlends: topBlends, lastUpdated: new Date()
    };
    mirrorLastUpdated();
    dashCachePut(res);
    return res;
  }
  var DASH_KEY = 'dash_v1';
  function dashCacheGet() {
    try {
      var c = CacheService.getScriptCache().get(DASH_KEY);
      if (c) { var o = JSON.parse(c); o._cached = true; return o; }
    } catch (e) {}
    return null;
  }
  function dashCachePut(res) {
    try { CacheService.getScriptCache().put(DASH_KEY, JSON.stringify(res), 60); } catch (e) {}
  }
  function dashCacheClear() {
    try { CacheService.getScriptCache().remove(DASH_KEY); } catch (e) {}
  }
  function mirrorLastUpdated() {
    try {
      var sh = Schema_.findSheet(CFG_.SHEETS.DASHBOARD);
      if (!sh) return;
      var vals = sh.getRange(1, 1, Math.min(6, sh.getLastRow()), Math.min(4, sh.getLastColumn())).getValues();
      for (var r = 0; r < vals.length; r++)
        for (var c = 0; c < vals[r].length; c++)
          if (Utils_.normStr(vals[r][c]) === 'last updated') { sh.getRange(r + 1, c + 2).setValue(new Date()); return; }
    } catch (e) {}
  }
  // Per-ledger summary computed from live orders (not from stored report cells).
  function customerSummary(opt) {
    var ledgers = Customers_.list();
    var active = activeAll().orders, delivered = deliveredAll();
    var per = {};
    ledgers.forEach(function (l) {
      per[l.ledgerId] = {
        ledgerId: l.ledgerId, ledgerName: l.ledgerName, totalOrders: 0, lifetimeQuantity: 0,
        blends: {}, pendingOrders: 0, deliveredOrders: 0, lastOrderDate: '', firstOrderDate: '', dates: []
      };
    });
    var feed = function (o, isDel) {
      var led = null;
      if (o._ledgerId && per[o._ledgerId]) led = per[o._ledgerId];
      else {
        for (var id in per) {
          if (Utils_.normStr(per[id].ledgerName) === Utils_.normStr(o.ledgerName)) { led = per[id]; break; }
        }
      }
      if (!led) return;
      led.totalOrders++;
      led.lifetimeQuantity += (Number(o.qty) || 0);
      if (o.blendName) led.blends[o.blendName] = (led.blends[o.blendName] || 0) + (Number(o.qty) || 0);
      if (isDel) led.deliveredOrders++; else led.pendingOrders++;
      if (o.orderDate) {
        led.dates.push(o.orderDate);
        if (!led.lastOrderDate || o.orderDate > led.lastOrderDate) led.lastOrderDate = o.orderDate;
        if (!led.firstOrderDate || o.orderDate < led.firstOrderDate) led.firstOrderDate = o.orderDate;
      }
    };
    active.forEach(function (o) { feed(o, false); });
    delivered.forEach(function (o) { feed(o, true); });
    var today = Dates_.todayYmd();
    var rows = Object.keys(per).map(function (id) {
      var e = per[id];
      var fav = '', favQ = -1;
      Object.keys(e.blends).forEach(function (b) { if (e.blends[b] > favQ) { favQ = e.blends[b]; fav = b; } });
      var freq = '', expected = '', daysSince = '', health = 'Never Ordered', prio = 5;
      if (e.dates.length) {
        e.dates.sort();
        if (e.dates.length >= 2) {
          var d0 = Dates_.toDate(e.dates[0]).getTime(), d1 = Dates_.toDate(e.dates[e.dates.length - 1]).getTime();
          var avg = Math.round((d1 - d0) / (e.dates.length - 1) / 86400000);
          freq = avg;
          expected = Dates_.toYmd(new Date(Dates_.toDate(e.lastOrderDate).getTime() + avg * 86400000));
        }
        daysSince = Math.round((Dates_.toDate(today).getTime() - Dates_.toDate(e.lastOrderDate).getTime()) / 86400000);
        if (e.totalOrders <= 1 && daysSince <= 30) { health = 'New'; prio = 7; }
        else if (daysSince <= 15) { health = 'Active'; prio = 6; }
        else if (daysSince <= 30) { health = 'Due Soon'; prio = 4; }
        else { health = 'Dormant'; prio = 1; }
      }
      return {
        ledgerId: e.ledgerId, ledgerName: e.ledgerName, totalOrders: e.totalOrders,
        lifetimeQuantity: e.lifetimeQuantity, favouriteBlend: fav,
        pendingOrders: e.pendingOrders, deliveredOrders: e.deliveredOrders,
        firstOrderDate: e.firstOrderDate, lastOrderDate: e.lastOrderDate,
        orderFrequencyDays: freq, expectedNextOrderDate: expected,
        daysSinceLastOrder: daysSince, healthStatus: health, followUpPriority: prio
      };
    });
    if (opt && opt.q) {
      var nq = Utils_.normStr(opt.q);
      rows = rows.filter(function (r) {
        return Utils_.normStr(r.ledgerId + ' ' + r.ledgerName).indexOf(nq) >= 0;
      });
    }
    rows.sort(function (a, b) { return b.lifetimeQuantity - a.lifetimeQuantity; });
    return rows;
  }
  // Genuinely new customers: first-ever order date inside [from, to].
  function newCustomers(from, to) {
    var f = Dates_.toYmd(from) || '0000-00-00', t = Dates_.toYmd(to) || '9999-99-99';
    var all = customerSummary({});
    var fresh = all.filter(function (r) {
      return r.firstOrderDate && r.firstOrderDate >= f && r.firstOrderDate <= t;
    }).sort(function (a, b) { return a.firstOrderDate < b.firstOrderDate ? -1 : 1; });
    return { from: f, to: t, count: fresh.length, rows: fresh };
  }
  // Month-to-date aggregation over live orders (pure grouping core).
  // orders: [{orderDate 'yyyy-mm-dd', ledgerName, _ledgerId, qty, ...}], ym: 'yyyy-mm'.
  function groupMtd(orders, ym) {
    var totalOrders = 0, totalQty = 0, byLedger = {};
    (orders || []).forEach(function (o) {
      if (!o.orderDate || o.orderDate.slice(0, 7) !== ym) return;
      var q = Number(o.qty) || 0;
      totalOrders++; totalQty += q;
      var key = o._ledgerId || Utils_.normStr(o.ledgerName || '(unknown)');
      if (!byLedger[key]) {
        byLedger[key] = {
          ledgerId: o._ledgerId || '',
          ledgerName: o.ledgerName || '(unknown)',
          orders: 0, quantity: 0
        };
      }
      byLedger[key].orders++; byLedger[key].quantity += q;
    });
    var ledgerWise = Object.keys(byLedger).map(function (k) { return byLedger[k]; })
      .sort(function (a, b) { return b.quantity - a.quantity; });
    return { month: ym, totalOrders: totalOrders, totalQuantity: totalQty, ledgerWise: ledgerWise };
  }
  // MTD over ALL orders (active + delivered history) by Order Date.
  function mtd(month) {
    var ym = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : Dates_.todayYmd().slice(0, 7);
    var all = activeAll().orders.concat(deliveredAll());
    return groupMtd(all, ym);
  }
  return { dashboard: dashboard, customerSummary: customerSummary, newCustomers: newCustomers, activeAll: activeAll, deliveredAll: deliveredAll, groupMtd: groupMtd, mtd: mtd };
})();

/* ------------------------------- Holidays_ ------------------------------ */
var Holidays_ = (function () {
  function list() {
    var t = Data_.readTable(CFG_.SHEETS.HOLIDAYS), m = t.schema.map;
    var out = t.rows.map(function (r) {
      return {
        rowNumber: r.rowNumber,
        date: Dates_.toYmd(Data_.cell(r.raw, m, 'holidayDate') !== '' ? Data_.cell(r.raw, m, 'holidayDate') : Data_.cell(r.raw, m, 'date')),
        name: String(Data_.cell(r.raw, m, 'holidayName') || ''),
        type: String(Data_.cell(r.raw, m, 'holidayType') || '')
      };
    }).filter(function (h) { return h.date !== '' || h.name !== ''; });
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out;
  }
  function add(p) {
    return Data_.lock(function () {
      var d = Dates_.toYmd((p && (p.date || p.holidayDate)) || '');
      var name = String((p && (p.name || p.holidayName)) || '').trim();
      if (!d) return Utils_.fail('Holiday Date is required.');
      if (!name) return Utils_.fail('Holiday Name is required.');
      var dup = list().filter(function (h) { return h.date === d && Utils_.normStr(h.name) === Utils_.normStr(name); });
      if (dup.length) return Utils_.fail('"' + name + '" on ' + d + ' already exists.');
      var t = Data_.readTable(CFG_.SHEETS.HOLIDAYS), m = t.schema.map, w = Math.max(t.schema.width, 3);
      var arr = new Array(w).fill('');
      var put = function (k, v) { if (m[k] !== undefined) arr[m[k]] = v; };
      put('holidayDate', Dates_.toDate(d)); put('date', Dates_.toDate(d));
      put('holidayName', name); put('holidayType', (p && (p.type || p.holidayType)) || 'National');
      Data_.appendRows(CFG_.SHEETS.HOLIDAYS, [arr]);
      Data_.logActivity('Holiday Added', '', '', '', name + ' ' + d);
      return Utils_.ok({ date: d, name: name });
    });
  }
  function remove(p) {
    return Data_.lock(function () {
      var d = Dates_.toYmd((p && (p.date || p.holidayDate)) || '');
      var name = String((p && (p.name || p.holidayName)) || '').trim();
      var t = Data_.readTable(CFG_.SHEETS.HOLIDAYS), m = t.schema.map;
      var hit = null;
      t.rows.forEach(function (r) {
        var rd = Dates_.toYmd(Data_.cell(r.raw, m, 'holidayDate') !== '' ? Data_.cell(r.raw, m, 'holidayDate') : Data_.cell(r.raw, m, 'date'));
        var rn = String(Data_.cell(r.raw, m, 'holidayName') || '');
        if ((!d || rd === d) && (!name || Utils_.normStr(rn) === Utils_.normStr(name))) hit = r;
      });
      if (!hit) return Utils_.fail('Holiday not found.');
      Data_.deleteRow(CFG_.SHEETS.HOLIDAYS, hit.rowNumber);
      Data_.logActivity('Holiday Deleted', '', '', '', name + ' ' + d);
      return Utils_.ok({});
    });
  }
  return { list: list, add: add, remove: remove };
})();

/* --------------------------------- Iex_ --------------------------------- */
var Iex_ = (function () {
  function template(kind) {
    if (kind === 'customers') return ['Ledger Name', 'Ledger ID (optional)', 'Address', 'Route', 'Route Day', 'Payment Terms (Advance/Credit)', 'Approved Blend(s) — separate with ;', 'Mobile Number', 'City', 'Area', 'Emp Name', 'Customer Status'];
    if (kind === 'products') return ['SKU Name', 'UOM (KG/LTR/PAC)', 'Status (Active/Inactive)', 'SKU ID (optional)'];
    if (kind === 'orders') return ['Order ID (optional)', 'Order Date (YYYY-MM-DD)', 'Ledger Name', 'Blend Name', 'Qty', 'UOM (optional)', 'Billing Date (optional YYYY-MM-DD)', 'Payment Status (optional)', 'Remarks'];
    if (kind === 'delivered') return ['Order ID (optional)', 'Order Date (YYYY-MM-DD)', 'Ledger Name', 'Blend Name', 'Qty', 'UOM (optional)', 'Billing Date (optional)', 'Delivered on (YYYY-MM-DD)', 'Remarks'];
    return [];
  }
  function splitBlends(s) {
    return String(s || '').split(/[;|\n]/).map(function (x) { return x.trim(); }).filter(function (x) { return x; });
  }
  function validateRows(kind, rows) {
    var valid = [], invalid = [], dupKeys = {};
    var ids = Orders_.allOrderIds();
    var ledgers = Customers_.list();
    var ledByName = {}, ledById = {};
    ledgers.forEach(function (l) { ledByName[Utils_.normStr(l.ledgerName)] = l; ledById[l.ledgerId] = l; });
    var seenOrder = {};
    rows.forEach(function (r, i) {
      var line = i + 2;
      var bad = function (msg) { invalid.push({ line: line, error: msg, row: r }); };
      if (kind === 'customers') {
        var nm = String(r['Ledger Name'] || '').trim();
        if (!nm) return bad('Ledger Name is required.');
        var blends = splitBlends(r['Approved Blend(s) — separate with ;'] || r['Approved Blend'] || r['Approved Blends']);
        if (!blends.length) return bad('At least one Approved Blend is required.');
        var chk = Products_.assertActive(blends);
        if (!chk.ok) return bad(chk.message);
        var lid = Utils_.normId(r['Ledger ID (optional)'] || r['Ledger ID'] || '');
        var terms = String(r['Payment Terms (Advance/Credit)'] || r['Payment Terms'] || 'Advance').trim();
        if (CFG_.PAYMENT_TERMS.indexOf(terms) < 0 && Utils_.normStr(terms) !== '') return bad('Invalid Payment Terms.');
        var dk = (lid || Utils_.normStr(nm)) + '|' + blends.map(Utils_.normStr).sort().join('+');
        if (dupKeys[dk]) return bad('Duplicate row inside the file.');
        dupKeys[dk] = true;
        var ex = ledByName[Utils_.normStr(nm)];
        if (ex) {
          var newB = blends.filter(function (b) {
            return !(ex.approvedBlends || []).some(function (e) { return Utils_.normStr(e) === Utils_.normStr(b); });
          });
          if (!newB.length && (!lid || lid === ex.ledgerId)) return bad('Already exists (duplicate customer/blends).');
        }
        valid.push({ line: line, row: r });
      } else if (kind === 'products') {
        var pn = String(r['SKU Name'] || '').trim();
        if (!pn) return bad('SKU Name is required.');
        var u = Utils_.normUom(r['UOM (KG/LTR/PAC)'] || r['UOM'] || '');
        if (CFG_.UOMS.indexOf(u) < 0) return bad('Invalid UOM.');
        valid.push({ line: line, row: r });
      } else { // orders / delivered
        var oid = Utils_.normId(r['Order ID (optional)'] || r['Order ID'] || '');
        if (oid && (ids[oid] || seenOrder[oid])) return bad('Duplicate Order ID "' + oid + '".');
        if (oid) seenOrder[oid] = true;
        if (!Dates_.toYmd(r['Order Date (YYYY-MM-DD)'] || r['Order Date'])) return bad('Invalid Order Date.');
        var ln = String(r['Ledger Name'] || '').trim();
        var led = ledByName[Utils_.normStr(ln)];
        if (!led) {
          var scored = ledgers.map(function (l) { return { l: l, s: Utils_.similarity(l.ledgerName, ln) }; })
            .filter(function (x) { return x.s >= CFG_.FUZZY_ACCEPT; });
          if (!scored.length) return bad('Unknown Ledger "' + ln + '".');
        } else scored = [{ l: led, s: 1 }];
        var bl = String(r['Blend Name'] || '').trim();
        var okB = (scored[0].l.approvedBlends || []).some(function (b) { return Utils_.normStr(b) === Utils_.normStr(bl); });
        if (!okB) return bad('"' + bl + '" is not approved for "' + scored[0].l.ledgerName + '".');
        var q = Utils_.toNumber(r['Qty']);
        if (!isFinite(q) || q <= 0) return bad('Invalid Qty.');
        var uu = Utils_.normUom(r['UOM (optional)'] || r['UOM'] || '');
        if (uu && CFG_.UOMS.indexOf(uu) < 0) return bad('Invalid UOM.');
        if (kind === 'delivered') {
          var dd = Dates_.toYmd(r['Delivered on (YYYY-MM-DD)'] || r['Delivered on'] || r['Billing Date (optional)'] || r['Order Date (YYYY-MM-DD)'] || '');
          if (!dd) return bad('Delivered on date is required.');
        }
        valid.push({ line: line, row: r });
      }
    });
    return { valid: valid, invalid: invalid };
  }
  function bulkUpload(kind, rows, confirm) {
    var v = validateRows(kind, rows || []);
    if (!confirm) {
      return Utils_.ok({
        kind: kind, validCount: v.valid.length, invalidCount: v.invalid.length,
        invalid: v.invalid.slice(0, 50)
      });
    }
    if (v.invalid.length) return Utils_.fail(v.invalid.length + ' invalid row(s). Fix them before confirming.', v.invalid.slice(0, 50));
    return Data_.lock(function () {
      var added = 0, warnings = [];
      if (kind === 'customers') {
        v.valid.forEach(function (it) {
          var r = it.row;
          var nm = String(r['Ledger Name'] || '').trim();
          var lid = Utils_.normId(r['Ledger ID (optional)'] || r['Ledger ID'] || '');
          var ledgers = Customers_.list();
          var ex = ledgers.filter(function (l) { return Utils_.normStr(l.ledgerName) === Utils_.normStr(nm); })[0];
          var blends = splitBlends(r['Approved Blend(s) — separate with ;'] || r['Approved Blend'] || '');
          var base = ex ? {
            ledgerId: ex.ledgerId, ledgerName: ex.ledgerName, customerStatus: ex.customerStatus,
            empName: ex.empName, address: ex.address, route: ex.route, routeDay: ex.routeDay,
            paymentTerms: ex.paymentTerms, mobile: ex.mobile, city: ex.city, area: ex.area
          } : {
            ledgerId: lid || Customers_.makeLedgerId(ledgers.map(function (l) { return l.ledgerId; })),
            ledgerName: nm, customerStatus: String(r['Customer Status'] || 'Active'),
            empName: String(r['Emp Name'] || ''), address: String(r['Address'] || ''),
            route: String(r['Route'] || ''), routeDay: String(r['Route Day'] || ''),
            paymentTerms: String(r['Payment Terms (Advance/Credit)'] || r['Payment Terms'] || 'Advance'),
            mobile: String(r['Mobile Number'] || ''), city: String(r['City'] || ''), area: String(r['Area'] || '')
          };
          var fresh = blends.filter(function (b) {
            return !(ex ? (ex.approvedBlends || []) : []).some(function (e) { return Utils_.normStr(e) === Utils_.normStr(b); });
          });
          if (fresh.length || !ex) {
            var mk = function (b) {
              var t = Data_.readTable(CFG_.SHEETS.KEY), m = t.schema.map, w = Math.max(t.schema.width, 1);
              var arr = new Array(w).fill('');
              var put = function (k, val) { if (m[k] !== undefined) arr[m[k]] = val; };
              put('slNo', ''); put('customerStatus', base.customerStatus); put('empName', base.empName);
              put('address', base.address); put('route', base.route); put('routeDay', base.routeDay);
              put('paymentTerms', base.paymentTerms); put('ledgerName', base.ledgerName);
              put('ledgerId', base.ledgerId); put('approvedBlend', b); put('mobile', base.mobile);
              put('city', base.city); put('area', base.area);
              return arr;
            };
            Data_.appendRows(CFG_.SHEETS.KEY, (ex ? fresh : fresh.length ? fresh : blends).map(mk));
            // fix SL numbers for appended rows
            added++;
          }
        });
        renumberSl(CFG_.SHEETS.KEY);
      } else if (kind === 'products') {
        v.valid.forEach(function (it) {
          var r = it.row;
          var res = Products_.addProduct({
            name: r['SKU Name'], uom: r['UOM (KG/LTR/PAC)'] || r['UOM'],
            status: r['Status (Active/Inactive)'] || 'Active', skuId: r['SKU ID (optional)'] || ''
          });
          if (res.success) added++; else warnings.push('Line ' + it.line + ': ' + res.message);
        });
      } else if (kind === 'orders') {
        v.valid.forEach(function (it) {
          var r = it.row;
          var res = Orders_.create({
            orderId: String(r['Order ID (optional)'] || r['Order ID'] || '').trim() || undefined,
            orderDate: r['Order Date (YYYY-MM-DD)'] || r['Order Date'],
            ledgerName: r['Ledger Name'], blendName: r['Blend Name'], qty: r['Qty'],
            uom: r['UOM (optional)'] || r['UOM'] || '',
            billingDate: r['Billing Date (optional YYYY-MM-DD)'] || r['Billing Date'] || '',
            paymentStatus: r['Payment Status (optional)'] || r['Payment Status'] || '',
            remarks: r['Remarks'] || ''
          });
          if (res.success) added++; else warnings.push('Line ' + it.line + ': ' + res.message);
        });
      } else if (kind === 'delivered') {
        v.valid.forEach(function (it) {
          var r = it.row;
          var res = upsertDelivered({
            orderId: String(r['Order ID (optional)'] || r['Order ID'] || '').trim() || undefined,
            orderDate: r['Order Date (YYYY-MM-DD)'] || r['Order Date'],
            ledgerName: r['Ledger Name'], blendName: r['Blend Name'], qty: r['Qty'],
            uom: r['UOM (optional)'] || r['UOM'] || '',
            billingDate: r['Billing Date (optional)'] || '',
            deliveredOn: r['Delivered on (YYYY-MM-DD)'] || r['Delivered on'] || '',
            remarks: r['Remarks'] || ''
          });
          if (res.success) added++; else warnings.push('Line ' + it.line + ': ' + res.message);
        });
      } else {
        return Utils_.fail('Unknown import kind.');
      }
      Data_.clearMemo();
      Workflow_.sync();
      return Utils_.ok({ added: added, warnings: warnings });
    });
  }
  // Insert or update a delivered record. Never deletes history.
  function upsertDelivered(o) {
    var res = Customers_.resolve({ ledgerName: o.ledgerName });
    if (res.error) return Utils_.fail(res.error);
    var ledger = res.ledger;
    var approved = (ledger.approvedBlends || []).some(function (b) { return Utils_.normStr(b) === Utils_.normStr(o.blendName); });
    if (!approved) return Utils_.fail('"' + o.blendName + '" is not approved for "' + ledger.ledgerName + '".');
    var uom = Utils_.normUom(o.uom || '') || Products_.defaultUom(o.blendName) || 'KG';
    var rec = {
      orderId: o.orderId || Orders_.makeOrderId(Orders_.allOrderIds()),
      orderDate: Dates_.toYmd(o.orderDate) || Dates_.todayYmd(),
      ledgerName: ledger.ledgerName, blendName: String(o.blendName).trim(),
      qty: Utils_.toNumber(o.qty), uom: uom,
      route: ledger.route, routeDay: ledger.routeDay,
      billingDate: Dates_.toYmd(o.billingDate) || Dates_.toYmd(o.orderDate),
      deliveredOn: Dates_.toYmd(o.deliveredOn) || Dates_.todayYmd(),
      remarks: String(o.remarks || ''), billingStatus: 'Billed',
      paymentStatus: '', paymentTerms: ledger.paymentTerms, deliveryStatus: 'Delivered'
    };
    if (!isFinite(rec.qty) || rec.qty <= 0) return Utils_.fail('Invalid Qty.');
    var found = Orders_.findOrder(rec.orderId);
    if (found && found.sheet === CFG_.SHEETS.DELIVERED) {
      var arr = Orders_.toRowArray(CFG_.SHEETS.DELIVERED, rec);
      try {
        var m = Data_.readTable(CFG_.SHEETS.DELIVERED).schema.map;
        if (m.slNo !== undefined && found.raw.length > m.slNo) {
          while (arr.length <= m.slNo) arr.push('');
          arr[m.slNo] = found.raw[m.slNo];
        }
      } catch (e) {}
      Data_.writeRow(CFG_.SHEETS.DELIVERED, found.rowNumber, arr);
      return Utils_.ok({ orderId: rec.orderId, updated: true });
    }
    Data_.appendRows(CFG_.SHEETS.DELIVERED, [Orders_.toRowArray(CFG_.SHEETS.DELIVERED, rec)]);
    Data_.logActivity('Delivered Uploaded', rec.orderId, ledger.ledgerId, ledger.ledgerName, rec.blendName);
    return Utils_.ok({ orderId: rec.orderId, updated: false });
  }
  function renumberSl(logical) {
    try {
      var t = Data_.readTable(logical), m = t.schema.map;
      if (m.slNo === undefined) return;
      t.rows.forEach(function (r, i) {
        var arr = r.raw.slice();
        while (arr.length <= m.slNo) arr.push('');
        arr[m.slNo] = i + 1;
        Data_.writeRow(logical, r.rowNumber, arr);
      });
    } catch (e) {}
  }
  function exportDelivered(q) {
    var r = Orders_.listBySheet(CFG_.SHEETS.DELIVERED, { q: q, limit: 2000 });
    var headers = ['SL No', 'Order ID', 'Order Date', 'Ledger Name', 'Blend Name', 'Qty', 'UOM',
      'Route', 'Route Day', 'Billing Date', 'Delivered on', 'Remarks', 'Delivery Status'];
    var rows = r.rows.map(function (o) {
      return [o.slNo, o.orderId, o.orderDate, o.ledgerName, o.blendName, o.qty, o.uom,
        o.route, o.routeDay, o.billingDate, o.deliveredOn, o.remarks, o.deliveryStatus];
    });
    return { headers: headers, rows: rows, total: r.total };
  }
  return { template: template, validateRows: validateRows, bulkUpload: bulkUpload, upsertDelivered: upsertDelivered, exportDelivered: exportDelivered };
})();

/* ------------------------------ API layer ------------------------------- */
function apiOk(data, message) {
  var r = Utils_.ok(data);
  if (message) r.message = message;
  return r;
}
function apiFail(e) {
  try { Data_.logError('api', '', '', String((e && e.message) || e), String((e && e.stack) || '')); } catch (x) {}
  return Utils_.fail(String((e && e.message) || e));
}
function apiBootstrap() {
  try {
    var counts = {}, schemas = {};
    [['tracker', CFG_.SHEETS.TRACKER], ['billing', CFG_.SHEETS.BILLING], ['pending', CFG_.SHEETS.PENDING],
     ['delivered', CFG_.SHEETS.DELIVERED], ['customers', CFG_.SHEETS.KEY],
     ['products', CFG_.SHEETS.PRODUCTS], ['holidays', CFG_.SHEETS.HOLIDAYS]].forEach(function (pair) {
      try {
        var t = Data_.readTable(pair[1]);
        counts[pair[0]] = t.rows.length;
        schemas[pair[0]] = { found: true, headerRow: t.schema.headerRow, headers: t.schema.headers };
      } catch (err) { counts[pair[0]] = 0; schemas[pair[0]] = { found: false, error: String(err && err.message || err) }; }
    });
    var routes = {}, routeDays = {};
    Customers_.list().forEach(function (l) {
      if (l.route) routes[String(l.route)] = true;
      if (l.routeDay) routeDays[String(l.routeDay)] = true;
    });
    return apiOk({
      today: Dates_.todayYmd(), counts: counts, schemas: schemas,
      paymentStatuses: CFG_.PAYMENT_STATUSES, billingStatuses: CFG_.BILLING_STATUSES,
      deliveryStatuses: CFG_.DELIVERY_STATUSES, uoms: CFG_.UOMS, paymentTerms: CFG_.PAYMENT_TERMS,
      routes: Object.keys(routes).sort(), routeDays: Object.keys(routeDays).sort()
    });
  } catch (e) { return apiFail(e); }
}
function apiDiscoverSchema() {
  try {
    var out = {};
    Object.keys(CFG_.SHEETS).forEach(function (k) {
      try {
        var t = Data_.readTable(CFG_.SHEETS[k]);
        out[CFG_.SHEETS[k]] = { found: true, headerRow: t.schema.headerRow, headers: t.schema.headers, dataRows: t.rows.length };
      } catch (err) { out[CFG_.SHEETS[k]] = { found: false, error: String(err && err.message || err) }; }
    });
    return apiOk(out);
  } catch (e) { return apiFail(e); }
}
// State-filtered views: correct wherever the row physically sits.
function apiGetOrderTracker(p) {
  try {
    var today = Dates_.todayYmd();
    var act = Reports_.activeAll();
    var out = act.orders.filter(function (o) { return Workflow_.ownerOf(o, today) === 'tracker'; });
    return apiOk(withHidden(pageFilter(out, p), act.hidden));
  } catch (e) { return apiFail(e); }
}
function apiGetTodaysBilling(p) {
  try {
    var today = Dates_.todayYmd();
    var act = Reports_.activeAll();
    var out = act.orders.filter(function (o) { return Workflow_.ownerOf(o, today) === 'billing'; });
    return apiOk(withHidden(pageFilter(out, p), act.hidden));
  } catch (e) { return apiFail(e); }
}
function apiGetPendingDelivery(p) {
  try {
    var today = Dates_.todayYmd();
    var act = Reports_.activeAll();
    var out = act.orders.filter(function (o) { return Workflow_.ownerOf(o, today) === 'pending'; });
    return apiOk(withHidden(pageFilter(out, p), act.hidden));
  } catch (e) { return apiFail(e); }
}
function withHidden(res, hidden) { res.hiddenIncomplete = hidden | 0; return res; }
function pageFilter(out, p) {
  p = p || {};
  if (p.q) {
    var nq = Utils_.normStr(p.q);
    out = out.filter(function (o) {
      return Utils_.normStr(o.orderId + ' ' + o.ledgerName + ' ' + o.blendName + ' ' + (o.remarks || '')).indexOf(nq) >= 0;
    });
  }
  var total = out.length;
  var offset = Math.max(0, (p.offset | 0)), limit = Math.min(2000, Math.max(1, (p.limit | 0) || 200));
  return { rows: out.slice(offset, offset + limit), total: total };
}
function apiGetDeliveredOrders(p) { try { return apiOk(Orders_.listBySheet(CFG_.SHEETS.DELIVERED, p || {})); } catch (e) { return apiFail(e); } }
function apiCreateOrder(p) { try { return Orders_.create(p || {}); } catch (e) { return apiFail(e); } }
function apiUpdateOrder(p) { try { return Orders_.update(p || {}); } catch (e) { return apiFail(e); } }
function apiDeleteOrder(p) { try { return Orders_.remove((p && (p.orderId || p.id)) || ''); } catch (e) { return apiFail(e); } }
function apiUpdatePaymentStatus(p) { try { return Workflow_.setPaymentStatus(p || {}); } catch (e) { return apiFail(e); } }
function apiUpdateBillingStatus(p) { try { return Workflow_.setBillingStatus(p || {}); } catch (e) { return apiFail(e); } }
function apiUpdateDeliveryStatus(p) { try { return Workflow_.setDelivered(p || {}); } catch (e) { return apiFail(e); } }
function apiSyncWorkflow() { try { return apiOk(Workflow_.sync()); } catch (e) { return apiFail(e); } }
function apiInspectIncomplete() { try { return apiOk(Workflow_.inspectIncomplete()); } catch (e) { return apiFail(e); } }
function apiDeleteStub(p) { try { return Workflow_.deleteStub(p || {}); } catch (e) { return apiFail(e); } }
function apiGetCustomers() { try { return apiOk(Customers_.list()); } catch (e) { return apiFail(e); } }
function apiSearchCustomers(p) { try { return apiOk(Customers_.search((p && p.q) || '', (p && p.limit) || 20)); } catch (e) { return apiFail(e); } }
function apiGetApprovedBlends(p) {
  try {
    var r = Customers_.resolve({ ledgerId: p && p.ledgerId, ledgerName: p && p.ledgerName });
    if (r.error) return Utils_.fail(r.error);
    return apiOk({ ledgerId: r.ledger.ledgerId, ledgerName: r.ledger.ledgerName, blends: Customers_.activeBlends(r.ledger) });
  } catch (e) { return apiFail(e); }
}
function apiAddCustomer(p) { try { return Customers_.addCustomer(p || {}); } catch (e) { return apiFail(e); } }
function apiUpdateCustomer(p) { try { return Customers_.updateCustomer(p || {}); } catch (e) { return apiFail(e); } }
function apiAddApprovedBlend(p) { try { return Customers_.addApprovedBlend(p || {}); } catch (e) { return apiFail(e); } }
function apiRemoveApprovedBlend(p) { try { return Customers_.removeApprovedBlend(p || {}); } catch (e) { return apiFail(e); } }
function apiGetProducts() { try { return apiOk(Products_.list()); } catch (e) { return apiFail(e); } }
function apiAddProduct(p) { try { return Products_.addProduct(p || {}); } catch (e) { return apiFail(e); } }
function apiGetDashboard() { try { return apiOk(Reports_.dashboard()); } catch (e) { return apiFail(e); } }
function apiGetCustomerSummary(p) { try { return apiOk(Reports_.customerSummary(p || {})); } catch (e) { return apiFail(e); } }
function apiGetNewCustomers(p) { try { return apiOk(Reports_.newCustomers((p && p.from) || '', (p && p.to) || '')); } catch (e) { return apiFail(e); } }
function apiGetMtdReport(p) { try { return apiOk(Reports_.mtd((p && (p.month || p.ym)) || '')); } catch (e) { return apiFail(e); } }
function apiGetHolidays() { try { return apiOk(Holidays_.list()); } catch (e) { return apiFail(e); } }
function apiAddHoliday(p) { try { return Holidays_.add(p || {}); } catch (e) { return apiFail(e); } }
function apiDeleteHoliday(p) { try { return Holidays_.remove(p || {}); } catch (e) { return apiFail(e); } }
function apiGetBulkTemplate(p) { try { return apiOk({ headers: Iex_.template((p && p.kind) || 'orders') }); } catch (e) { return apiFail(e); } }
function apiBulkUpload(p) {
  try { return Iex_.bulkUpload((p && p.kind) || 'orders', (p && p.rows) || [], !!((p && p.confirm))); }
  catch (e) { return apiFail(e); }
}
function apiExportDeliveredOrders(p) { try { return apiOk(Iex_.exportDelivered((p && p.q) || '')); } catch (e) { return apiFail(e); } }
function apiGetActivityLog(p) {
  try {
    var t = Data_.readTable(CFG_.SHEETS.ACTIVITY), m = t.schema.map;
    var rows = t.rows.map(function (r) {
      return {
        date: Dates_.toYmd(Data_.cell(r.raw, m, 'date')), time: String(Data_.cell(r.raw, m, 'time') || ''),
        user: String(Data_.cell(r.raw, m, 'user') || ''), action: String(Data_.cell(r.raw, m, 'action') || ''),
        orderId: String(Data_.cell(r.raw, m, 'orderId') || ''), ledgerId: String(Data_.cell(r.raw, m, 'ledgerId') || ''),
        ledgerName: String(Data_.cell(r.raw, m, 'ledgerName') || ''), remarks: String(Data_.cell(r.raw, m, 'remarks') || '')
      };
    }).filter(function (x) { return x.action; });
    rows.reverse();
    var lim = Math.min(500, Math.max(1, ((p && p.limit) || 100)));
    return apiOk({ rows: rows.slice(0, lim), total: rows.length });
  } catch (e) { return apiFail(e); }
}
function apiLogClientError(p) {
  // Client-side auto-diagnostics intake. Never throws — always JSON.
  try {
    p = p || {};
    var msg = String(p.message || 'unspecified UI issue').slice(0, 2000);
    var src = String(p.source || 'ui').slice(0, 120);
    var ctx = String(p.context || '').slice(0, 4000);
    Data_.logError('UI:' + src, '', '', msg, ctx);
    return apiOk({ logged: true });
  } catch (e) { return apiOk({ logged: false }); }
}
function apiGetErrorLog(p) {
  try {
    var t = Data_.readTable(CFG_.SHEETS.ERRORS), m = t.schema.map;
    var rows = t.rows.map(function (r) {
      var g = function (k) { return String(Data_.cell(r.raw, m, k) || ''); };
      return {
        timestamp: g('timestamp') || g('date'), funcName: g('funcName') || g('action'),
        sheetName: g('sheetName') || g('sheet'), rowNum: g('rowNum') || g('row'),
        message: g('message'), details: g('details')
      };
    }).filter(function (x) { return x.message; });
    rows.reverse();
    var lim = Math.min(500, Math.max(1, ((p && p.limit) || 100)));
    return apiOk({ rows: rows.slice(0, lim), total: rows.length });
  } catch (e) { return apiFail(e); }
}

/* ------------------------------ Web layer ------------------------------- */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Order Management')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* Thin global action wrappers (called by google.script.run). */
function getBootstrap() { return apiBootstrap(); }
function discoverSchema() { return apiDiscoverSchema(); }
function getOrderTracker(p) { return apiGetOrderTracker(p); }
function getTodaysBilling(p) { return apiGetTodaysBilling(p); }
function getPendingDelivery(p) { return apiGetPendingDelivery(p); }
function getDeliveredOrders(p) { return apiGetDeliveredOrders(p); }
function createOrder(p) { return apiCreateOrder(p); }
function updateOrder(p) { return apiUpdateOrder(p); }
function deleteOrder(p) { return apiDeleteOrder(p); }
function updatePaymentStatus(p) { return apiUpdatePaymentStatus(p); }
function updateBillingStatus(p) { return apiUpdateBillingStatus(p); }
function updateDeliveryStatus(p) { return apiUpdateDeliveryStatus(p); }
function syncWorkflow() { return apiSyncWorkflow(); }
function inspectIncomplete() { return apiInspectIncomplete(); }
function deleteStub(p) { return apiDeleteStub(p); }
function getCustomers() { return apiGetCustomers(); }
function searchCustomers(p) { return apiSearchCustomers(p); }
function getApprovedBlends(p) { return apiGetApprovedBlends(p); }
function addCustomer(p) { return apiAddCustomer(p); }
function updateCustomer(p) { return apiUpdateCustomer(p); }
function addApprovedBlend(p) { return apiAddApprovedBlend(p); }
function removeApprovedBlend(p) { return apiRemoveApprovedBlend(p); }
function getProducts() { return apiGetProducts(); }
function addProduct(p) { return apiAddProduct(p); }
function getDashboard() { return apiGetDashboard(); }
function getCustomerSummary(p) { return apiGetCustomerSummary(p); }
function getNewCustomers(p) { return apiGetNewCustomers(p); }
function getMtdReport(p) { return apiGetMtdReport(p); }
function getHolidays() { return apiGetHolidays(); }
function addHoliday(p) { return apiAddHoliday(p); }
function deleteHoliday(p) { return apiDeleteHoliday(p); }
function getBulkTemplate(p) { return apiGetBulkTemplate(p); }
function bulkUpload(p) { return apiBulkUpload(p); }
function exportDeliveredOrders(p) { return apiExportDeliveredOrders(p); }
function getActivityLog(p) { return apiGetActivityLog(p); }
function getErrorLog(p) { return apiGetErrorLog(p); }
function logClientError(p) { return apiLogClientError(p); }

/* Test hook (not a UI action): exposes pure modules to node harness. */
function __testHook() { return { CFG: CFG_, Utils: Utils_, Dates: Dates_, Workflow: Workflow_, Orders: Orders_, Reports: Reports_ }; }
