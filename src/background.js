// Background service worker
// Handles API calls (Porting Query API + Porting Admin API + Google Calendar)
// No tab scraping — all data fetched via direct API calls

let lastDetectedSrId = null;

// ─── Environment config ───────────────────────────────────────────────────────
// ENV flipped to 'prod' on 2026-10-13. All API calls derive from this.
const ENV = 'prod';
const CONFIG = {
  dev: {
    API_BASE: 'http://porting.query.dev.telnyx.io:4000',
    PORTING_ADMIN: 'https://portingadmindev.telnyx.com'
  },
  prod: {
    API_BASE: 'http://porting.query.prod.telnyx.io:4000',
    PORTING_ADMIN: 'https://portingadmin.telnyx.com'
  }
};
const API_BASE = CONFIG[ENV].API_BASE;
const PORTING_ADMIN_URL = CONFIG[ENV].PORTING_ADMIN;
// Host for port-completion calls (foc_date endpoint)
const INTERNAL_HOST = ENV === 'prod' ? 'api-internal.telnyx.com' : 'apidev-internal.telnyx.com';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SR_DETECTED') {
    lastDetectedSrId = msg.srId;
    chrome.storage.session.set({ detectedSrId: msg.srId });
    return false;
  }
  if (msg.type === 'SIGN_IN') {
    handleSignIn().then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_CURRENT_USER') {
    getCurrentUser().then(sendResponse);
    return true;
  }
  if (msg.type === 'LOOKUP_AND_READ') {
    lookupAndRead(msg.srId, msg.dateFormat).then(sendResponse);
    return true;
  }
  if (msg.type === 'CREATE_EVENT') {
    createCalendarEvent(msg.eventData).then(sendResponse);
    return true;
  }
  if (msg.type === 'SCHEDULE_AUTO_PORT') {
    scheduleAutoPort(msg.orderData, msg.eventId, msg.eventLink).then(sendResponse);
    return true;
  }
  if (msg.type === 'CANCEL_AUTO_PORT') {
    cancelAutoPort(msg.srId).then(sendResponse);
    return true;
  }
  if (msg.type === 'CANCEL_AUTO_PORT_FULL') {
    cancelAutoPortFull(msg.srId).then(sendResponse);
    return true;
  }
  if (msg.type === 'RESCHEDULE_AUTO_PORT') {
    rescheduleAutoPort(msg.orderData).then(sendResponse);
    return true;
  }
  if (msg.type === 'CHECK_AUTO_PORT_STATUS') {
    checkAutoPortStatus(msg.srId).then(sendResponse);
    return true;
  }
  if (msg.type === 'CLEANUP_CALENDAR_EVENTS') {
    findAndDeleteAllEventsForSr(msg.srId).then(sendResponse);
    return true;
  }
});

// ─── Auto-Port: chrome.alarms listener ───────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('autoport_')) {
    const srId = alarm.name.replace('autoport_', '');
    executeAutoPort(srId);
  }
});

// ─── Sign in ─────────────────────────────────────────────────────────────────
async function handleSignIn() {
  try {
    var token = await getGoogleToken();
    var email = await detectAndSaveEmail(token);
    if (email) return { success: true, email: email };
    return { success: true, email: null };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getCurrentUser() {
  try {
    var token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(t);
      });
    });
    var email = await detectAndSaveEmail(token);
    if (email) return { success: true, email: email };
    return { success: false, error: 'No email returned from Google' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Main flow ───────────────────────────────────────────────────────────────
async function lookupAndRead(srId, dateFormat) {
  let debug = [];
  const { telnyxApiKey } = await chrome.storage.sync.get('telnyxApiKey');
  if (!telnyxApiKey) {
    return { error: 'No API key configured. Open Settings to set your Telnyx API key.', debug };
  }
  debug.push('fetching order via API');
  let orderResult;
  try {
    orderResult = await fetchOrderViaAPI(srId, telnyxApiKey);
  } catch (e) {
    debug.push('API error: ' + e.message);
    return { error: e.message, debug };
  }
  if (!orderResult.focDate) {
    debug.push('no FOC date found for ' + srId);
    return { error: 'No FOC date found on ' + srId + '. FOC must be confirmed first.', debug };
  }
  debug.push('got data, focDate=' + orderResult.focDate);
  debug.push('country=' + (orderResult.country || 'null'));
  debug.push('status=' + (orderResult.status || 'null'));

  const ltSource = orderResult.fullComment || orderResult.comment;
  if (ltSource) debug.push('comment for LT comparison: ' + ltSource.substring(0, 200));
  else debug.push('no comment available for LT comparison');

  if (orderResult.country && ltSource) {
    const ltTime = parseLocalTimeFromComment(ltSource, orderResult.country, dateFormat);
    if (ltTime) {
      const comparison = compareLtWithFoc(orderResult.focDate, ltTime, orderResult.country);
      orderResult.ltComparison = comparison;
      debug.push('LT comparison: ' + (comparison.match === true ? 'MATCH' : comparison.match === false ? 'MISMATCH' : 'N/A') + ' (' + (comparison.ltLabel || '') + ' → ' + (comparison.cstLabel || '') + ')');
    } else {
      debug.push('LT parse: no local time found in comment');
    }
  } else {
    debug.push('skipping LT comparison: country=' + (orderResult.country || 'null') + ' comment=' + (ltSource ? 'yes' : 'no'));
  }

  // Check for existing auto-port job (for reschedule UI)
  const { autoPortJobs } = await chrome.storage.local.get('autoPortJobs');
  const existingJob = (autoPortJobs || {})[orderResult.srId] || null;
  if (existingJob) debug.push('existing job: executed=' + !!existingJob.executed + ' focDate=' + existingJob.focDate);

  return { order: orderResult, existingJob, debug };
}

// ─── API-based order lookup ──────────────────────────────────────────────────
async function fetchOrderViaAPI(srId, apiKey) {
  const queryUrl = API_BASE + '/private/v2/porting_orders?filter%5Bsupport_key%5D=' + srId;
  const resp = await fetch(queryUrl, { headers: { 'Authorization': 'Bearer ' + apiKey } });
  if (!resp.ok) throw new Error('Porting Query API: ' + resp.status);
  const data = await resp.json();
  if (!data.data || data.data.length === 0) throw new Error('Order ' + srId + ' not found');

  const order = data.data[0];
  const focDate = order.activation_settings?.foc_datetime_actual || null;
  const country = order.country_code || null;
  const status = order.status?.value || null;
  const orderId = order.id;
  const subRequestId = order.sub_request_id;

  let comment = '';
  let fullComment = '';
  try {
    const commentsUrl = API_BASE + '/private/v2/porting_orders/' + orderId + '/comments';
    const cResp = await fetch(commentsUrl, { headers: { 'Authorization': 'Bearer ' + apiKey } });
    if (cResp.ok) {
      const cData = await cResp.json();
      const comments = cData.data || cData;
      if (Array.isArray(comments) && comments.length > 0) {
        if (comments.length > 1) {
          comments.sort((a, b) => {
            const aTime = a.created_at || a.createdAt || a.inserted_at || a.updated_at || '';
            const bTime = b.created_at || b.createdAt || b.inserted_at || b.updated_at || '';
            if (aTime && bTime) return new Date(bTime) - new Date(aTime);
            return 0;
          });
        }
        const scheduleRe = /(\d+\s*(?:hours?|hrs?|minutes?|mins?)\s+(?:to\s+)?(?:release|complete|process|port|trigger))|(?:scheduled|rescheduled|confirmed.*(?:FOC|date|port)|carrier.*confirm)|(\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*(?:AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT|CEST|CET|WET|WEST|EEST|EET|GMT|BST|IST|SGT|HKT|JST|KST|TWT|CST|PHT|ICT|MYT|LT))/i;
        let selectedComment = null;
        for (const c of comments) {
          const body = c.body || c.text || c.content || '';
          if (c.user_type === 'admin' && scheduleRe.test(body)) { selectedComment = c; break; }
        }
        if (!selectedComment) {
          for (const c of comments) {
            const body = c.body || c.text || c.content || '';
            if (scheduleRe.test(body)) { selectedComment = c; break; }
          }
        }
        if (!selectedComment) selectedComment = comments[0];
        fullComment = selectedComment.body || selectedComment.text || selectedComment.content || '';
        comment = fullComment;
      }
    }
  } catch (e) {
    // Non-critical
  }

  return {
    srId: srId,
    country: country,
    focDate: focDate,
    comment: comment,
    fullComment: fullComment,
    status: status,
    parentSupportKey: order.parent_support_key || null,
    _uuids: { portRequestId: orderId, subRequestId: subRequestId }
  };
}

// ─── Country → IANA Timezone Map ─────────────────────────────────────────────
const COUNTRY_TIMEZONES = {
  AT: 'Europe/Vienna', BE: 'Europe/Brussels', BG: 'Europe/Sofia', HR: 'Europe/Zagreb',
  CY: 'Asia/Nicosia', CZ: 'Europe/Prague', DK: 'Europe/Copenhagen', EE: 'Europe/Tallinn',
  FI: 'Europe/Helsinki', FR: 'Europe/Paris', DE: 'Europe/Berlin', GR: 'Europe/Athens',
  HU: 'Europe/Budapest', IE: 'Europe/Dublin', IT: 'Europe/Rome', LV: 'Europe/Riga',
  LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', MT: 'Europe/Malta', NL: 'Europe/Amsterdam',
  NO: 'Europe/Oslo', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon', RO: 'Europe/Bucharest',
  SK: 'Europe/Bratislava', SI: 'Europe/Ljubljana', ES: 'Europe/Madrid', SE: 'Europe/Stockholm',
  CH: 'Europe/Zurich', GB: 'Europe/London',
  AU: 'Australia/Sydney', NZ: 'Pacific/Auckland', SG: 'Asia/Singapore', HK: 'Asia/Hong_Kong',
  JP: 'Asia/Tokyo', KR: 'Asia/Seoul', TW: 'Asia/Taipei', IN: 'Asia/Kolkata', PH: 'Asia/Manila',
  TH: 'Asia/Bangkok', MY: 'Asia/Kuala_Lumpur',
  ZA: 'Africa/Johannesburg', AE: 'Asia/Dubai', IL: 'Asia/Jerusalem', SA: 'Asia/Riyadh'
};

// ─── Timezone Abbreviation → IANA Map ─────────────────────────────────────────
const TZ_ABBREV = {
  CET: 'Europe/Paris', CEST: 'Europe/Amsterdam', WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon',
  EET: 'Europe/Athens', EEST: 'Europe/Athens', GMT: 'Europe/London', BST: 'Europe/London',
  IST: 'Europe/Dublin', MET: 'Europe/Paris', MEST: 'Europe/Paris',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney', ACST: 'Australia/Adelaide',
  ACDT: 'Australia/Adelaide', AWST: 'Australia/Perth', NZST: 'Pacific/Auckland',
  NZDT: 'Pacific/Auckland', SGT: 'Asia/Singapore', HKT: 'Asia/Hong_Kong', JST: 'Asia/Tokyo',
  KST: 'Asia/Seoul', TWT: 'Asia/Taipei', CST: 'Asia/Shanghai', IST_IN: 'Asia/Kolkata',
  PHT: 'Asia/Manila', ICT: 'Asia/Bangkok', MYT: 'Asia/Kuala_Lumpur',
  SAST: 'Africa/Johannesburg', GST: 'Asia/Dubai', IST_IL: 'Asia/Jerusalem', AST: 'Asia/Riyadh'
};

// ─── LT → CST Comparison ──────────────────────────────────────────────────────
function parseLocalTimeFromComment(comment, country, dateFormatOverride) {
  if (!comment) return null;
  var useMonthFirst;
  if (dateFormatOverride === 'MM/DD') useMonthFirst = true;
  else if (dateFormatOverride === 'DD/MM') useMonthFirst = false;
  else {
    var MMDD_COUNTRIES = ['US', 'PH', 'CA', 'PR', 'GU', 'MP', 'AS', 'FM', 'MH', 'PW'];
    useMonthFirst = country && MMDD_COUNTRIES.indexOf(country) !== -1;
  }

  var dateMatch = comment.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  var commentYear = null, commentMonth = null, commentDay = null;

  if (!dateMatch) {
    var malformedDate = comment.match(/(\d{1,2})\/(\d{1,2})(\d{4})/);
    if (malformedDate) dateMatch = [malformedDate[0], malformedDate[1], malformedDate[2], malformedDate[3]];
  }
  if (dateMatch) {
    var a = parseInt(dateMatch[1]);
    var b = parseInt(dateMatch[2]);
    var yr = parseInt(dateMatch[3]);
    if (yr < 100) yr += 2000;
    commentYear = yr;
    if (a > 12) { commentDay = a; commentMonth = b; }
    else if (b > 12) { commentMonth = a; commentDay = b; }
    else if (useMonthFirst) { commentMonth = a; commentDay = b; }
    else { commentDay = a; commentMonth = b; }
  }
  if (!dateMatch) {
    var isoDate = comment.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoDate) {
      commentYear = parseInt(isoDate[1]);
      commentMonth = parseInt(isoDate[2]);
      commentDay = parseInt(isoDate[3]);
    }
  }

  if (!dateMatch && !commentDay) {
    var monthNames = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
    var nlPatterns = [
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})?\b/i,
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?\b/i
    ];
    for (var nli = 0; nli < nlPatterns.length; nli++) {
      var nlMatch = comment.match(nlPatterns[nli]);
      if (nlMatch) {
        if (nli === 0) {
          commentDay = parseInt(nlMatch[1]);
          commentMonth = monthNames[nlMatch[2].toLowerCase()];
          if (nlMatch[3]) commentYear = parseInt(nlMatch[3]);
        } else {
          commentMonth = monthNames[nlMatch[1].toLowerCase()];
          commentDay = parseInt(nlMatch[2]);
          if (nlMatch[3]) commentYear = parseInt(nlMatch[3]);
        }
        break;
      }
    }
  }

  if (commentDay && commentMonth && !dateMatch && !commentYear) {
    var yr2 = new Date().getFullYear();
    return { hour: 0, minute: 0, tzAbbr: 'LT', year: yr2, month: commentMonth, day: commentDay, dateOnly: true };
  }
  if (commentDay && commentMonth && !dateMatch) {
    var yr3 = commentYear || new Date().getFullYear();
    return { hour: 0, minute: 0, tzAbbr: 'LT', year: yr3, month: commentMonth, day: commentDay, dateOnly: true };
  }

  var abbrevs = Object.keys(TZ_ABBREV).sort(function(a, b) { return b.length - a.length; });
  for (var ai = 0; ai < abbrevs.length; ai++) {
    var ab = abbrevs[ai];
    var re = new RegExp('(\\d{1,2})(?::(\\d{2}))?\\s*(AM|PM)\\s*' + ab, 'i');
    var match = comment.match(re);
    if (match) {
      var hour = parseInt(match[1]);
      var minute = match[2] ? parseInt(match[2]) : 0;
      var ampm = match[3].toUpperCase();
      if (ampm === 'PM' && hour !== 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      return { hour: hour, minute: minute, tzAbbr: ab, tzIana: TZ_ABBREV[ab], year: commentYear, month: commentMonth, day: commentDay };
    }
  }
  var match = comment.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*LT/i);
  if (!match) return null;
  var hour = parseInt(match[1]);
  var minute = match[2] ? parseInt(match[2]) : 0;
  var ampm = match[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return { hour: hour, minute: minute, tzAbbr: 'LT', year: commentYear, month: commentMonth, day: commentDay };
}

function compareLtWithFoc(focDateStr, ltTime, country) {
  var tz = (ltTime.tzIana) ? ltTime.tzIana : COUNTRY_TIMEZONES[country];
  var tzLabel = (ltTime.tzAbbr && ltTime.tzAbbr !== 'LT') ? ltTime.tzAbbr : 'LT';
  if (!tz) return { match: null, ltLabel: null, cstLabel: null, error: 'No timezone for ' + country };

  var focUtcMatch = focDateStr.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!focUtcMatch) return { match: null, error: 'Invalid FOC date format' };

  var focUtcYear = parseInt(focUtcMatch[1]), focUtcMo = parseInt(focUtcMatch[2]), focUtcDy = parseInt(focUtcMatch[3]);
  var focUtcHour = parseInt(focUtcMatch[4]), focUtcMin = parseInt(focUtcMatch[5]);
  var focDateObj = new Date(Date.UTC(focUtcYear, focUtcMo - 1, focUtcDy, focUtcHour, focUtcMin));

  var focCstFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: true
  });
  var focCstStr = focCstFmt.format(focDateObj);
  var focCstParsed = focCstStr.match(/(\w{3})\s+(\d{1,2}),?\s*(?:\d{4},?)?\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
  if (!focCstParsed) return { match: null, error: 'Could not parse FOC date in CST' };

  var focMoName = focCstParsed[1];
  var focDy = parseInt(focCstParsed[2]);
  var focHour12 = parseInt(focCstParsed[3]);
  var focMinCST = parseInt(focCstParsed[4]);
  var focAmpm = focCstParsed[5].toUpperCase();
  var focHourCST = focHour12;
  if (focAmpm === 'PM' && focHourCST !== 12) focHourCST += 12;
  if (focAmpm === 'AM' && focHourCST === 12) focHourCST = 0;

  var focYearFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' });
  var focYear = parseInt(focYearFmt.format(focDateObj));
  var focMo = parseInt(focDateObj.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'numeric' }));

  var ltYear = (ltTime.year) ? ltTime.year : focYear;
  var ltMo = (ltTime.month) ? ltTime.month : focMo;
  var ltDy = (ltTime.day) ? ltTime.day : focDy;

  if (ltTime.dateOnly) {
    var dateMatch = (ltYear === focYear && ltMo === focMo && ltDy === focDy);
    var monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var ltLabel = monthNames[ltMo] + ' ' + ltDy + ', ' + ltYear + ' (date only, ' + country + ')';
    var cstLabel = monthNames[focMo] + ' ' + focDy + ', ' + focYear + ' CST';
    return { match: dateMatch, dateMatch: dateMatch, ltLabel: ltLabel, cstLabel: cstLabel, note: 'Date-only comparison (no time in comment)' };
  }

  var targetHour = ltTime.hour;
  var targetMin = ltTime.minute;
  var utcBase = Date.UTC(ltYear, ltMo - 1, ltDy, 0, 0, 0);
  var foundUtc = null;

  var countryFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false
  });

  for (var utcOff = -12; utcOff <= 24; utcOff++) {
    var testMs = utcBase + utcOff * 3600000;
    var formatted = countryFmt.format(new Date(testMs));
    var fmtMatch = formatted.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})/);
    if (fmtMatch) {
      var fmtMo = parseInt(fmtMatch[1]);
      var fmtDy = parseInt(fmtMatch[2]);
      var fmtYr = parseInt(fmtMatch[3]);
      var fmtH = parseInt(fmtMatch[4]);
      if (fmtH === 24) fmtH = 0;
      var dateMatches = (fmtYr === ltYear && fmtMo === ltMo && fmtDy === ltDy);
      var diff = Math.abs(fmtH - targetHour);
      if (dateMatches && (diff === 0 || diff === 23)) {
        for (var fineOff = 0; fineOff < 60; fineOff++) {
          var fineMs = testMs + fineOff * 60000;
          var fineFmt = countryFmt.format(new Date(fineMs));
          var fineMatch = fineFmt.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})/);
          if (fineMatch) {
            var fMo = parseInt(fineMatch[1]);
            var fDy = parseInt(fineMatch[2]);
            var fYr = parseInt(fineMatch[3]);
            var fH = parseInt(fineMatch[4]);
            if (fH === 24) fH = 0;
            var fM = parseInt(fineMatch[5]);
            if (fYr === ltYear && fMo === ltMo && fDy === ltDy && fH === targetHour && fM === targetMin) {
              foundUtc = fineMs;
              break;
            }
          }
        }
        if (foundUtc !== null) break;
      }
    }
  }

  if (foundUtc === null) return { match: null, error: 'Could not convert local time to UTC' };

  var cstDateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: true
  });
  var cstStr = cstDateFmt.format(new Date(foundUtc));
  var cstParsed = cstStr.match(/(\w{3})\s+(\d{1,2}),?\s*(?:\d{4},?)?\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
  if (!cstParsed) return { match: null, error: 'Could not parse CST time' };

  var cstMoName = cstParsed[1];
  var cstDy = parseInt(cstParsed[2]);
  var cstHour12 = parseInt(cstParsed[3]);
  var cstMin = parseInt(cstParsed[4]);
  var cstAmpm = cstParsed[5].toUpperCase();
  var cstHour = cstHour12;
  if (cstAmpm === 'PM' && cstHour !== 12) cstHour += 12;
  if (cstAmpm === 'AM' && cstHour === 12) cstHour = 0;

  var cstYearFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' });
  var cstYear = parseInt(cstYearFmt.format(new Date(foundUtc)));

  var ltH12 = ltTime.hour % 12 || 12;
  var ltAmpm = ltTime.hour >= 12 ? 'PM' : 'AM';
  var ltTimeStr = ltH12 + ':' + String(ltTime.minute).padStart(2, '0') + ' ' + ltAmpm + ' ' + tzLabel;
  var ltLabel;
  if (ltTime.year && ltTime.month && ltTime.day) {
    var ltDateObj = new Date(ltTime.year, ltTime.month - 1, ltTime.day);
    var ltMoShort = ltDateObj.toLocaleString('en-US', { month: 'short' });
    ltLabel = ltMoShort + ' ' + ltTime.day + ', ' + ltTimeStr + ' (' + country + ')';
  } else {
    ltLabel = ltTimeStr + ' (' + country + ')';
  }

  var cstLabel = cstMoName + ' ' + cstDy + ', ' + cstHour12 + ':' + String(cstMin).padStart(2, '0') + ' ' + cstAmpm + ' CST';

  var dateMatch = (cstYear === focYear && cstMoName === new Date(focYear, focMo - 1, focDy).toLocaleString('en-US', { month: 'short' }) && cstDy === focDy);
  var timeDiffMin = Math.abs(cstHour * 60 + cstMin - focHourCST * 60 - focMinCST);
  var match = dateMatch && timeDiffMin <= 2;

  return { match: match, dateMatch: dateMatch, ltLabel: ltLabel, cstLabel: cstLabel, timeDiffMin: timeDiffMin };
}

// ─── Google Calendar API ──────────────────────────────────────────────────────
async function getGoogleToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) { resolve(token); return; }
      chrome.identity.getAuthToken({ interactive: true }, (token2) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(token2);
      });
    });
  });
}

async function detectAndSaveEmail(token) {
  // Use Chrome's built-in identity API to get the signed-in Google account email.
  // Avoids needing OAuth userinfo scope (which our manifest doesn't have).
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        if (info && info.email) {
          chrome.storage.sync.set({ userEmail: info.email });
          resolve(info.email);
        } else {
          resolve(null);
        }
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function parseDuration(comment) {
  if (!comment) return 1;
  var match = comment.match(/(\d+)\s*(hour|hr|minute|min)/i);
  if (match) {
    var num = parseInt(match[1]);
    var unit = match[2].toLowerCase();
    if (unit.startsWith('min')) return Math.max(num / 60, 0.5);
    return num;
  }
  return 1;
}

function addHoursToFloating(dtStr, hours) {
  var parts = dtStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!parts) return dtStr;
  var yr = parseInt(parts[1]), mo = parseInt(parts[2]), dy = parseInt(parts[3]);
  var h = parseInt(parts[4]), m = parseInt(parts[5]);
  var dt = new Date(Date.UTC(yr, mo - 1, dy, h, m) + hours * 3600000);
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()) + 'T' + pad(dt.getUTCHours()) + ':' + pad(dt.getUTCMinutes()) + ':00';
}

async function createCalendarEvent(eventData) {
  try {
    var token = await getGoogleToken();
    await detectAndSaveEmail(token);

    var srId = eventData.srId, country = eventData.country, focDate = eventData.focDate, comment = eventData.comment;
    var durationHours = eventData.durationHours || parseDuration(comment);

    // Preserve timezone offset — bug fix from v1.1.1
    // Floating times (no Z, no offset) stay as-is; Google interprets in timeZone: America/Chicago
    var hasTz = focDate.includes('+') || focDate.includes('Z');
    var startDateTime = focDate;
    var endDateTime = addHoursToFloating(focDate, durationHours);
    if (hasTz) {
      if (focDate.includes('Z')) endDateTime += 'Z';
      else {
        var offMatch = focDate.match(/[+-]\d{2}:?\d{2}$/);
        if (offMatch) endDateTime += offMatch[0];
      }
    }

    var event = {
      summary: (country || '??') + ' ACT: ' + srId,
      description: [
        'Porting order FOC',
        '',
        'SR ID: ' + srId,
        'Country: ' + (country || 'N/A'),
        'Comment: ' + (comment || 'N/A'),
        '',
        'PortingAdmin: ' + PORTING_ADMIN_URL + '/#!/sub-request/' + (eventData._uuids ? eventData._uuids.portRequestId + '/' + eventData._uuids.subRequestId : 'queue?search=' + srId)
      ].join('\n'),
      start: { dateTime: startDateTime, timeZone: 'America/Chicago' },
      end: { dateTime: endDateTime, timeZone: 'America/Chicago' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
          { method: 'popup', minutes: 10 }
        ]
      }
    };

    var res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      }
    );

    if (!res.ok) {
      var err = await res.json();
      return { error: 'Calendar API error: ' + (err.error?.message || res.statusText) };
    }

    var created = await res.json();
    return { success: true, eventId: created.id, eventLink: created.htmlLink };
  } catch (err) {
    return { error: 'Failed to create event: ' + err.message };
  }
}

async function deleteCalendarEvent(eventId) {
  try {
    var token = await getGoogleToken();
    var res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + encodeURIComponent(eventId),
      { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }
    );
    // 204 = success, 410 = already gone — both fine
    if (res.ok || res.status === 204 || res.status === 410) return { success: true, status: res.status };
    var text = '';
    try { text = await res.text(); } catch (e) {}
    return { error: 'Calendar delete failed: HTTP ' + res.status + ' ' + text.substring(0, 200) };
  } catch (err) {
    return { error: 'Failed to delete event: ' + err.message };
  }
}

// Find ALL calendar events matching the SR ID using time-range scan (avoids fuzzy search index).
// Paginated — fetches up to 250 events per page across past 7 days to future 30 days.
async function findAndDeleteAllEventsForSr(srId) {
  try {
    var token = await getGoogleToken();
    var now = new Date();
    var weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    var monthAhead = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    var allMatches = [];
    var pageToken = null;

    do {
      var url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
        + '?timeMin=' + encodeURIComponent(weekAgo.toISOString())
        + '&timeMax=' + encodeURIComponent(monthAhead.toISOString())
        + '&showDeleted=false'
        + '&maxResults=250'
        + '&singleEvents=true'
        + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
      if (!res.ok) {
        var t = '';
        try { t = await res.text(); } catch (e) {}
        return { error: 'Calendar list failed: HTTP ' + res.status + ' ' + t.substring(0, 200), deletedCount: 0, totalFound: 0, errors: [] };
      }
      var data = await res.json();
      var events = data.items || [];
      var pageMatches = events.filter(function(e) {
        var summary = e.summary || '';
        var desc = e.description || '';
        return summary.indexOf(srId) !== -1 || desc.indexOf(srId) !== -1;
      });
      allMatches = allMatches.concat(pageMatches);
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    var deletedCount = 0;
    var errors = [];
    for (var i = 0; i < allMatches.length; i++) {
      var evId = allMatches[i].id;
      var evSummary = allMatches[i].summary || '(no title)';
      console.log('[Calendar Cleanup] Deleting', i + 1 + '/' + allMatches.length + ':', evId, '—', evSummary);
      var delResult = await deleteCalendarEvent(evId);
      if (delResult.success) {
        deletedCount++;
        console.log('[Calendar Cleanup] OK', evId, '(HTTP', delResult.status + ')');
      } else {
        errors.push({ eventId: evId, summary: evSummary, error: delResult.error });
        console.error('[Calendar Cleanup] FAILED', evId, ':', delResult.error);
      }
    }
    console.log('[Calendar Cleanup] Done. deleted=' + deletedCount + '/' + allMatches.length);
    return { deletedCount: deletedCount, totalFound: allMatches.length, errors: errors };
  } catch (err) {
    return { error: 'Failed to search/delete events: ' + err.message, deletedCount: 0, totalFound: 0, errors: [] };
  }
}

// ─── Auto-Port: scheduling + execution ────────────────────────────────────────
async function scheduleAutoPort(orderData, eventId, eventLink) {
  try {
    const srId = orderData.srId;
    const focDate = orderData.focDate;
    if (!focDate) return { error: 'No FOC date on order' };

    const focMs = new Date(focDate).getTime();
    if (isNaN(focMs)) return { error: 'Invalid FOC date: ' + focDate };

    const nowMs = Date.now();
    const delayMin = (focMs - nowMs) / 60000;

    if (delayMin <= 0) {
      const result = await executeAutoPort(srId, orderData);
      return { success: true, executed: true, result };
    }

    // chrome.alarms has ~1 minute minimum; use setTimeout for shorter delays
    if (delayMin < 1) {
      setTimeout(() => executeAutoPort(srId, orderData), delayMin * 60000);
    } else {
      chrome.alarms.create('autoport_' + srId, { when: focMs });
    }

    const jobData = {
      srId: srId,
      focDate: focDate,
      scheduledAt: new Date().toISOString(),
      executed: false,
      eventId: eventId || null,
      eventLink: eventLink || null,
      orderData: orderData
    };
    const { autoPortJobs } = await chrome.storage.local.get('autoPortJobs');
    const jobs = autoPortJobs || {};
    jobs[srId] = jobData;
    await chrome.storage.local.set({ autoPortJobs: jobs });

    return { success: true, scheduled: true, focDate: focDate, delayMinutes: Math.round(delayMin), srId: srId };
  } catch (e) {
    return { error: 'Schedule failed: ' + e.message };
  }
}

async function cancelAutoPort(srId) {
  try {
    await chrome.alarms.clear('autoport_' + srId);
    const { autoPortJobs } = await chrome.storage.local.get('autoPortJobs');
    const jobs = autoPortJobs || {};
    if (jobs[srId]) {
      delete jobs[srId];
      await chrome.storage.local.set({ autoPortJobs: jobs });
      return { success: true, cancelled: true, srId };
    }
    return { success: false, error: 'No job found for ' + srId };
  } catch (e) {
    return { error: 'Cancel failed: ' + e.message };
  }
}

async function cancelAutoPortFull(srId) {
  try {
    const alarmResult = await cancelAutoPort(srId);
    const cleanupResult = await findAndDeleteAllEventsForSr(srId);
    return {
      success: true,
      cancelled: true,
      alarmCancelled: !alarmResult.error,
      eventDeleted: cleanupResult.deletedCount > 0,
      eventDeletedCount: cleanupResult.deletedCount || 0,
      eventTotalFound: cleanupResult.totalFound || 0,
      eventError: cleanupResult.error || (cleanupResult.errors && cleanupResult.errors.length ? cleanupResult.errors[0].error : null),
      srId: srId
    };
  } catch (e) {
    return { error: 'Cancel full failed: ' + e.message };
  }
}

async function rescheduleAutoPort(orderData) {
  try {
    const srId = orderData.srId;
    if (!srId) return { error: 'No srId' };
    const cancelResult = await cancelAutoPortFull(srId);
    let oldEventDeletedCount = cancelResult.eventDeletedCount || 0;
    let oldEventError = cancelResult.eventError;
    let eventResult = null;
    try {
      eventResult = await createCalendarEvent(orderData);
      if (eventResult.error) return { error: 'Reschedule failed at create event: ' + eventResult.error };
    } catch (e) {
      return { error: 'Reschedule failed at create event: ' + e.message };
    }
    const scheduleResult = await scheduleAutoPort(orderData, eventResult.eventId, eventResult.eventLink);
    return {
      success: true,
      oldEventDeleted: oldEventDeletedCount > 0,
      oldEventDeletedCount: oldEventDeletedCount,
      oldEventError: oldEventError,
      newEventId: eventResult.eventId,
      newEventLink: eventResult.eventLink,
      scheduled: scheduleResult.scheduled || false,
      executed: scheduleResult.executed || false,
      focDate: scheduleResult.focDate || orderData.focDate
    };
  } catch (e) {
    return { error: 'Reschedule failed: ' + e.message };
  }
}

async function checkAutoPortStatus(srId) {
  try {
    const { autoPortJobs } = await chrome.storage.local.get('autoPortJobs');
    const jobs = autoPortJobs || {};
    const job = jobs[srId];
    if (!job) return { found: false };
    return {
      found: true,
      srId: job.srId,
      focDate: job.focDate,
      scheduledAt: job.scheduledAt,
      executed: job.executed || false,
      executedAt: job.executedAt || null,
      completionSuccess: job.completionSuccess || null,
      commentSuccess: job.commentSuccess || null,
      error: job.error || null,
      log: job.log || []
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function executeAutoPort(srId, cachedOrderData) {
  let orderData = cachedOrderData;
  if (!orderData) {
    const { autoPortJobs } = await chrome.storage.local.get('autoPortJobs');
    const job = ((autoPortJobs || {})[srId]);
    if (job) orderData = job.orderData;
  }
  if (!orderData) {
    console.error('[Auto-Port] No order data for', srId);
    return { error: 'No order data' };
  }
  const { telnyxApiKey } = await chrome.storage.sync.get('telnyxApiKey');
  if (!telnyxApiKey) {
    console.error('[Auto-Port] No API key');
    return { error: 'No API key configured' };
  }

  let orderId = orderData._uuids?.portRequestId || orderData.orderId || '';
  const subRequestId = orderData._uuids?.subRequestId || orderData.subRequestId || '';
  const phoneNumbers = orderData.phoneNumbers || [];
  let parentSupportKey = orderData.parentSupportKey || orderData.parent_support_key || '';
  // V1 and V2 use separate IDs for the parent/port_request. Completion is V1-only;
  // comments stay on V2. Keep v1PortRequestId distinct from orderId (V2).
  let v1PortRequestId = '';
  let completionSuccess = false;
  let commentSuccess = false;
  let log = [];

  // Resolve the V1 port_request_id for the completion endpoint.
  // The completion route is V1-only (/porting/v1/): its parent id differs from the
  // V2 order id, while sub_request_id is shared across V1/V2.
  // Bridge: V2 parent_support_key (pr_xxx) → V1 search → filter by support_key → V1 id.
  if (orderId && subRequestId) {
    try {
      if (!parentSupportKey && srId) {
        const fresh = await fetchOrderViaAPI(srId, telnyxApiKey);
        if (fresh && fresh.parentSupportKey) parentSupportKey = fresh.parentSupportKey;
      }
      if (parentSupportKey) {
        log.push('Resolving V1 port_request_id via ' + parentSupportKey);
        const v1SearchUrl = 'https://' + INTERNAL_HOST + '/porting/v1/port_requests?search=' + encodeURIComponent(parentSupportKey);
        const v1Resp = await fetch(v1SearchUrl, { headers: { 'Authorization': 'Bearer ' + telnyxApiKey } });
        if (v1Resp.ok) {
          const v1List = await v1Resp.json();
          const match = Array.isArray(v1List) ? v1List.find(p => p.support_key === parentSupportKey) : null;
          if (match && match.id) {
            v1PortRequestId = match.id;
            log.push('V1 port_request_id: ' + v1PortRequestId);
          } else {
            log.push('V1 parent lookup: no match for ' + parentSupportKey);
          }
        } else {
          log.push('V1 parent lookup HTTP ' + v1Resp.status);
        }
      } else {
        log.push('No parent_support_key — completion will fall back to order id');
      }
    } catch (e) {
      log.push('V1 parent lookup error: ' + e.message);
    }
  }

  // ─── Step 1: Trigger port via /completion (api-internal.telnyx.com) ─────────────────────
  // POST /porting/v1/port_requests/{parent_order_id}/sub_requests/{sub_request_id}/completion
  // Auth: Bearer API key (confirmed by Patrick — standard TELNYX_API_KEY, no impersonation)
  // Body: {} (never leave comments in the body)
  // Same route as the "Mark as Ported" button in PortingAdmin UI
  log.push('Step 1: Trigger port (foc_date)');
  // Use V1 id for completion; fall back to orderId only if V1 lookup failed.
  const compParentId = v1PortRequestId || orderId;
  if (compParentId && subRequestId) {
    const compUrl = 'https://' + INTERNAL_HOST + '/porting/v1/port_requests/' + compParentId + '/sub_requests/' + subRequestId + '/completion';
    log.push('POST ' + compUrl);
    try {
      const resp = await fetch(compUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + telnyxApiKey,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      log.push('HTTP ' + resp.status);
      console.log('[Auto-Port] Completion POST →', resp.status, compUrl);
      if (resp.ok || resp.status === 204) {
        completionSuccess = true;
        log.push('OK Port triggered');
      } else {
        const text = await resp.text();
        console.log('[Auto-Port] Completion response body:', text);
        log.push('Response: ' + text.substring(0, 300));
      }
    } catch (e) {
      console.log('[Auto-Port] Completion fetch error:', e.message);
      log.push('Completion fetch error: ' + e.message);
    }
  } else {
    log.push('Missing v1PortRequestId or subRequestId — skipping completion');
  }

  // ─── Step 2: Post Comment ──────────────────────────────────────────────────
  log.push('Step 2: Post Comment');
  if (orderId) {
    const focComment = orderData.comment || orderData.fullComment || '';
    let hoursText = 'up to 3 hours';
    const durMatch = focComment.match(/(\d+)\s*(hour|hr|minute|min)/i);
    if (durMatch) {
      const num = parseInt(durMatch[1]);
      const unit = durMatch[2].toLowerCase();
      if (unit.startsWith('min')) hoursText = num + ' minute' + (num > 1 ? 's' : '');
      else hoursText = num + ' hour' + (num > 1 ? 's' : '');
    }

    const commentBody = 'Hi there,\n\n'
      + 'This port request has now been triggered with the losing communications provider. The status of this port will change to ported.\n\n'
      + 'However, please allow up to ' + hoursText + ' from now, for the routing to fully update.\n\n'
      + 'Please wait until you receive our confirmation via the comments of the request before confirming port completion with the end-user.\n\n'
      + "We'd love to hear your feedback on this order—your input helps us improve and serve you better. Please take a moment to fill out our quick survey!\n\n"
      + 'Best,\n'
      + 'Telnyx Porting Team';

    try {
      const resp = await fetch(API_BASE + '/private/v2/porting_orders/' + orderId + '/comments', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + telnyxApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: commentBody })
      });
      log.push('Comment POST HTTP ' + resp.status);
      if (resp.ok) {
        commentSuccess = true;
        log.push('OK Comment posted');
      } else {
        const text = await resp.text();
        log.push('Response: ' + text.substring(0, 300));
      }
    } catch (e) {
      log.push('Comment error: ' + e.message);
    }
  } else {
    log.push('Missing orderId — skipping comment');
  }

  // ─── Update job status ─────────────────────────────────────────────────────
  const { autoPortJobs } = await chrome.storage.local.get('autoPortJobs');
  const jobs = autoPortJobs || {};
  if (jobs[srId]) {
    jobs[srId].executed = true;
    jobs[srId].executedAt = new Date().toISOString();
    jobs[srId].completionSuccess = completionSuccess;
    jobs[srId].commentSuccess = commentSuccess;
    jobs[srId].log = log;
    await chrome.storage.local.set({ autoPortJobs: jobs });
  }

  const status = completionSuccess && commentSuccess ? 'OK' : (completionSuccess || commentSuccess ? 'PARTIAL' : 'FAIL');
  try {
    chrome.notifications?.create('autoport_' + srId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: status + ' Auto-Port: ' + srId,
      message: 'Completion: ' + (completionSuccess ? 'OK' : 'FAIL') + ' | Comment: ' + (commentSuccess ? 'OK' : 'FAIL') + '\nFOC: ' + (orderData.focDate || 'N/A')
    });
  } catch (e) {}

  console.log('[Auto-Port] Done for', srId, 'comp=' + completionSuccess, 'comment=' + commentSuccess);
  return { completionSuccess: completionSuccess, commentSuccess: commentSuccess, log: log };
}
