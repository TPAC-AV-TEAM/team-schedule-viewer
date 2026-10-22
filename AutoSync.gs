// ══════════════════════════════════════════════════════════
// 班表自動同步 — Google Apps Script  (安全防禦強化版 V2.1)
// 設定完成後，每次 Google Sheets 有人編輯，
// 自動解析並寫入 Firebase，index.html 隨時是最新資料。
// ══════════════════════════════════════════════════════════

/* ══════════════════════════════════════════════════════════
   CENTRAL CONFIG
   ══════════════════════════════════════════════════════════ */
const CONFIG = {
  SHEET_ID:          '1_d08Y1-M2Kjb-ezWtdkghenqSL32pVD6MZqU17tGOh8',
  FIREBASE_API_KEY:  'AIzaSyA7tgFRxDCnZpOzEvfT978wIAcqcXNZXVQ',
  FIREBASE_PROJECT:  'team-schedule-viewer',
  APP_ID:            'team-schedule-viewer',

  VENUES: [
    { id:'GT', excelRow:-4 },
    { id:'BB', excelRow:-3 },
    { id:'GP', excelRow:-2 },
  ],

  ST_ALIAS_MAP: { 'ST': ['GT','BB'] },
  SHIFT_MAP:    { A:'A', B:'B', C:'A', D:'B', E:'A', F:'B' },

  STAFF_ORDER: ['王志剛','張國飛','張劭如','謝祥玄','張懷德','楊淯舒','黎祐甄','廖俊龍','曾健洋','劉智敏'],

  EXCEL_ROWS_START:   [4, 52, 100, 148, 196, 244],
  EXCEL_COLS_INDEX:   [2, 5, 8, 11, 14, 17, 20],
  EXCEL_STAFF_RANGE:  { start:2, end:30 },
  EXCEL_NOTE_ROW_OFFSET: -1,

  SKIP_SHEET_KEYWORDS: ['設定','準則'],

  // 安全防禦門檻
  MIN_DAYS_THRESHOLD:  7,   // 至少需解析出 7 天以上資料
  MIN_STAFF_THRESHOLD: 5,   // 至少需匹配到 5 位以上名單同仁

  // 攔截通知：同一小時內不重複寄信（秒，CacheService 上限 21600）
  ALERT_COOLDOWN_SEC: 3600,
};

/* ══════════════════════════════════════════════════════════
   觸發器安裝（執行一次即可）
   ══════════════════════════════════════════════════════════ */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  Logger.log('✅ 觸發器安裝完成');
  Logger.log('   試算表：' + ss.getName());
  Logger.log('   之後每次有人編輯，自動同步到 Firebase');
}

/* ══════════════════════════════════════════════════════════
   觸發器狀態查詢（可隨時執行確認）
   ══════════════════════════════════════════════════════════ */
function checkTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.length) {
    Logger.log('⚠️ 沒有任何觸發器！請執行 setupTrigger()');
    return;
  }
  triggers.forEach(t => {
    Logger.log('觸發器：' + t.getHandlerFunction()
      + '  |  類型：' + t.getEventType()
      + '  |  來源：' + t.getTriggerSource());
  });
  Logger.log('共 ' + triggers.length + ' 個觸發器');
}

/* ══════════════════════════════════════════════════════════
   主觸發函式（onEdit 自動呼叫）
   ══════════════════════════════════════════════════════════ */
function onSheetEdit(e) {
  // 節流：60 秒內只同步一次
  const cache = CacheService.getScriptCache();
  const lastRun = cache.get('lastSync');
  const now = Date.now();
  if (lastRun && now - parseInt(lastRun) < 60000) {
    Logger.log('⏭️ 節流中，跳過（距上次 ' + Math.round((now - parseInt(lastRun))/1000) + ' 秒）');
    return;
  }
  cache.put('lastSync', String(now), 120);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    Logger.log('⏭️ 已有其他同步進行中，跳過');
    return;
  }

  try {
    syncToFirebase();
  } catch(err) {
    Logger.log('❌ 同步失敗：' + err.message);
    notifyAdmin('同步失敗', err.message);
  } finally {
    lock.releaseLock();
  }
}

/* ══════════════════════════════════════════════════════════
   手動同步（在 Apps Script 編輯器選此函式執行測試）
   ══════════════════════════════════════════════════════════ */
function manualSync() {
  syncToFirebase();
}

/* ══════════════════════════════════════════════════════════
   攔截 / 失敗通知（寄信給腳本擁有者；冷卻期內不重複寄）
   第一次執行會要求授權寄信權限，請手動執行 testNotify() 完成授權。
   ══════════════════════════════════════════════════════════ */
function notifyAdmin(title, detail) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('lastAlert')) {
      Logger.log('📧 通知冷卻中，不重複寄信');
      return;
    }
    const to = Session.getEffectiveUser().getEmail();
    if (!to) return;
    MailApp.sendEmail(
      to,
      '[班表同步] ' + title,
      detail + '\n\n線上班表資料「未被覆蓋」，仍為上一次成功同步的內容。\n'
        + '請檢查試算表格式（是否插入/刪除列欄、改動人名或日期列）。\n'
        + '時間：' + new Date().toISOString()
    );
    cache.put('lastAlert', '1', CONFIG.ALERT_COOLDOWN_SEC);
    Logger.log('📧 已寄出通知給 ' + to);
  } catch (err) {
    Logger.log('⚠️ 通知寄送失敗：' + err.message);
  }
}

// 執行一次以完成寄信授權並確認收得到信
function testNotify() {
  CacheService.getScriptCache().remove('lastAlert');
  notifyAdmin('測試通知', '這是測試信，收到代表通知功能正常。');
}

/* ══════════════════════════════════════════════════════════
   核心同步邏輯（含安全防禦鎖）
   ══════════════════════════════════════════════════════════ */
function syncToFirebase() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheets = ss.getSheets().filter(sh => {
    const name = sh.getName();
    return !CONFIG.SKIP_SHEET_KEYWORDS.some(kw => name.includes(kw));
  });

  if (!sheets.length) {
    Logger.log('⚠️ 找不到可用的工作表');
    return;
  }

  let data = { fR:{}, fS:{}, fH:{}, fN:{} };
  sheets.forEach(sh => {
    data = processSheetData(sh, data);
    Logger.log('📋 已解析：' + sh.getName());
  });

  const allKeys = Object.keys(data.fR).sort();

  // ──────────────────────────────────────────────────────────
  // ★ 安全防禦鎖：驗證資料完整性，未達標絕不上傳覆蓋
  // ──────────────────────────────────────────────────────────

  // 1. 檢查天數
  if (allKeys.length < CONFIG.MIN_DAYS_THRESHOLD) {
    const msg = '[安全攔截] 解析天數過少（僅 ' + allKeys.length + ' 天，門檻為 ' + CONFIG.MIN_DAYS_THRESHOLD + ' 天）。可能試算表座標錯位，取消同步以保護線上資料！';
    Logger.log('🛑 ' + msg);
    notifyAdmin('同步被攔截（天數過少）', msg);
    return;
  }

  // 2. 檢查同仁匹配有效性
  let matchedStaffCount = 0;
  CONFIG.STAFF_ORDER.forEach(name => {
    const hasRecord = allKeys.some(dateKey => {
      const inRoster = CONFIG.VENUES.some(v => data.fR[dateKey]?.[v.id]?.[name]);
      const inStatus = !!data.fS[dateKey]?.[name];
      return inRoster || inStatus;
    });
    if (hasRecord) matchedStaffCount++;
  });

  if (matchedStaffCount < CONFIG.MIN_STAFF_THRESHOLD) {
    const msg = '[安全攔截] 匹配到的人員過少（僅 ' + matchedStaffCount + ' / ' + CONFIG.STAFF_ORDER.length + ' 人）。試算表格式可能變更，取消同步以保護線上資料！';
    Logger.log('🛑 ' + msg);
    notifyAdmin('同步被攔截（人員過少）', msg);
    return;
  }

  // 3. 檢查場館排班：空白班別會被記成「休假」並算進人員匹配，
  //    所以整張表班別全空時仍會通過上面兩關，需另外確認真的有排班資料
  let rosterCount = 0;
  allKeys.forEach(k => CONFIG.VENUES.forEach(v => {
    rosterCount += Object.keys(data.fR[k]?.[v.id] || {}).length;
  }));

  if (rosterCount === 0) {
    const msg = '[安全攔截] 解析出 ' + allKeys.length + ' 天，但沒有任何場館排班資料（班別欄可能整片空白或格式改變），取消同步以保護線上資料！';
    Logger.log('🛑 ' + msg);
    notifyAdmin('同步被攔截（無場館排班）', msg);
    return;
  }
  // ──────────────────────────────────────────────────────────

  Logger.log('📅 日期範圍：' + allKeys[0] + ' ➔ ' + allKeys[allKeys.length-1] + '（共 ' + allKeys.length + ' 天，有效同仁 ' + matchedStaffCount + ' 人，場館排班 ' + rosterCount + ' 筆）');

  const token = getFirebaseToken();
  writeToFirestore(token, data);

  Logger.log('✅ 同步完成');
}

/* ══════════════════════════════════════════════════════════
   工作表解析
   ══════════════════════════════════════════════════════════ */
function processSheetData(sheet, existing) {
  const fR = JSON.parse(JSON.stringify(existing.fR || {}));
  const fS = JSON.parse(JSON.stringify(existing.fS || {}));
  const fH = JSON.parse(JSON.stringify(existing.fH || {}));
  const fN = JSON.parse(JSON.stringify(existing.fN || {}));

  const rows = sheet.getDataRange().getValues();
  if (!rows || rows.length === 0) return { fR, fS, fH, fN };

  const VENUE_IDS  = CONFIG.VENUES.map(v => v.id);
  const allCodes   = [...VENUE_IDS, ...Object.keys(CONFIG.ST_ALIAS_MAP)];
  const codeRegex  = new RegExp('(' + allCodes.join('|') + ')-([A-F])', 'i');

  CONFIG.EXCEL_ROWS_START.forEach(rS => {
    if (rS >= rows.length) return;

    CONFIG.EXCEL_COLS_INDEX.forEach(cI => {
      const dateKey = parseSheetDate(rows[rS] && rows[rS][cI]);
      if (!dateKey) return;

      if (!fR[dateKey]) fR[dateKey] = Object.fromEntries(VENUE_IDS.map(id => [id, {}]));
      if (!fS[dateKey]) fS[dateKey] = {};

      fH[dateKey] = Object.fromEntries(
        CONFIG.VENUES.map(v => [v.id, String((rows[rS + v.excelRow] && rows[rS + v.excelRow][cI]) || '').trim()])
      );

      fN[dateKey] = String((rows[rS + CONFIG.EXCEL_NOTE_ROW_OFFSET] && rows[rS + CONFIG.EXCEL_NOTE_ROW_OFFSET][cI]) || '').trim();

      for (let r = rS + CONFIG.EXCEL_STAFF_RANGE.start;
               r <= rS + CONFIG.EXCEL_STAFF_RANGE.end;
               r += 2) {
        if (r >= rows.length) break;

        const name = String((rows[r] && rows[r][1]) || '').trim();
        if (!CONFIG.STAFF_ORDER.includes(name)) continue;

        const code = String((rows[r + 1] && rows[r + 1][cI]) || '').trim();

        if (code === '' || /休|例|休息|無排班|公假|婚假|喪假|病假|事假|特休|補休/.test(code)) {
          fS[dateKey][name] = '休假';
          continue;
        }

        if (/辦公|支援|居家|其他|其它/.test(code)) {
          fS[dateKey][name] = '辦公';
          continue;
        }

        const match = code.match(codeRegex);
        if (match) {
          const vid = match[1].toUpperCase();
          const sh  = CONFIG.SHIFT_MAP[match[2].toUpperCase()] || 'A';

          if (CONFIG.ST_ALIAS_MAP[vid]) {
            CONFIG.ST_ALIAS_MAP[vid].forEach(targetVid => {
              if (!fR[dateKey][targetVid]) fR[dateKey][targetVid] = {};
              fR[dateKey][targetVid][name] = { shift: sh };
            });
          } else {
            if (!fR[dateKey][vid]) fR[dateKey][vid] = {};
            fR[dateKey][vid][name] = { shift: sh };
          }
          fS[dateKey][name] = '';
        } else {
          fS[dateKey][name] = '辦公';
        }
      }
    });
  });

  return { fR, fS, fH, fN };
}

/* ══════════════════════════════════════════════════════════
   日期解析
   ══════════════════════════════════════════════════════════ */
function parseSheetDate(cell) {
  if (!cell) return null;

  if (cell instanceof Date) {
    const y = cell.getFullYear();
    const m = String(cell.getMonth() + 1).padStart(2, '0');
    const d = String(cell.getDate()).padStart(2, '0');
    return y + '/' + m + '/' + d;
  }

  if (typeof cell === 'number' && cell > 1000) {
    const d = new Date(Math.round((cell - 25569) * 86400 * 1000));
    return d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0');
  }

  if (typeof cell === 'string') {
    const m = cell.match(/(\d{1,2})\/(\d{1,2})/);
    if (m) {
      const now = new Date();
      const mm = parseInt(m[1]), dd = parseInt(m[2]);
      let y = now.getFullYear();
      if (now.getMonth() >= 10 && mm <= 2) y++;
      else if (now.getMonth() <= 1 && mm >= 11) y--;
      return y + '/' + String(mm).padStart(2,'0') + '/' + String(dd).padStart(2,'0');
    }
  }

  return null;
}

/* ══════════════════════════════════════════════════════════
   Firebase 匿名登入
   ══════════════════════════════════════════════════════════ */
function getFirebaseToken() {
  const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + CONFIG.FIREBASE_API_KEY;
  const res = UrlFetchApp.fetch(url, {
    method:      'post',
    contentType: 'application/json',
    payload:     JSON.stringify({ returnSecureToken: true }),
    muteHttpExceptions: true,
  });

  const json = JSON.parse(res.getContentText());
  if (!json.idToken) throw new Error('Firebase 匿名登入失敗：' + res.getContentText());

  Logger.log('🔑 Firebase 認證成功');
  return json.idToken;
}

/* ══════════════════════════════════════════════════════════
   寫入 Firestore
   ══════════════════════════════════════════════════════════ */
function writeToFirestore(token, data) {
  const { fR, fS, fH, fN } = data;
  const docPath = 'artifacts/' + CONFIG.APP_ID + '/public/data/rosters/master';
  const url = 'https://firestore.googleapis.com/v1/projects/' + CONFIG.FIREBASE_PROJECT + '/databases/(default)/documents/' + docPath;

  const body = {
    fields: {
      roster:      { stringValue: JSON.stringify(fR) },
      statuses:    { stringValue: JSON.stringify(fS) },
      shows:       { stringValue: JSON.stringify(fH) },
      notes:       { stringValue: JSON.stringify(fN) },
      lastUpdated: { stringValue: new Date().toISOString() },
    }
  };

  const res = UrlFetchApp.fetch(url, {
    method:      'patch',
    contentType: 'application/json',
    headers:     { Authorization: 'Bearer ' + token },
    payload:     JSON.stringify(body),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Firestore 寫入失敗 (' + res.getResponseCode() + ')：' + res.getContentText());
  }

  Logger.log('📡 Firestore 寫入成功');
}
