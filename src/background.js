// Background service worker
// Handles API calls (Porting Query API + Porting Admin API + Google Calendar)
// No tab scraping — all data fetched via direct API calls

let lastDetectedSrId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SR_DETECTED') {
    lastDetectedSrId = msg.srId;
    chrome.storage.session.set({ detectedSrId: msg.srId });
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
});

// ─── Sign in ──────────────────────────────────────────────────────────────────

async function handleSignIn() {
  try {
    var token = await getGoogleToken();
    var email = await detectAndSaveEmail(token);
    if (email) {
      return { success: true, email: email };
    }
    return { success: true, email: null };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Get current user (silent — no popup if already signed in) ──────────────────

async function getCurrentUser() {
  try {
    // Try silent first (no popup if token exists and is valid)
    var token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(t);
        }
      });
    });
    var email = await detectAndSaveEmail(token);
    if (email) {
      return { success: true, email: email };
    }
    return { success: false, error: 'No email returned from Google' };
  } catch (e) {
    // Not signed in — silent failure, popup stays empty
    return { success: false, error: e.message };
  }
}

// ─── Main flow ──────────────────────────────────────────────────────────────

async function lookupAndRead(srId, dateFormat) {
  let debug = [];

  // 1. Get API key from chrome.storage.sync
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

  // 2. Run LT → CST comparison using the comment from the API
  const ltSource = orderResult.fullComment || orderResult.comment;
  if (ltSource) {
    debug.push('comment for LT comparison: ' + ltSource.substring(0, 200));
  } else {
    debug.push('no comment available for LT comparison');
  }

  if (orderResult.country && ltSource) {
    const ltTime = parseLocalTimeFromComment(ltSource, orderResult.country, dateFormat);
    if (ltTime) {
      const comparison = compareLtWithFoc(orderResult.focDate, ltTime, orderResult.country);
      orderResult.ltComparison = comparison;
      debug.push('LT comparison: ' +
        (comparison.match === true ? 'MATCH' :
         comparison.match === false ? 'MISMATCH' : 'N/A') +
        ' (' + (comparison.ltLabel || '') + ' → ' + (comparison.cstLabel || '') + ')');
    } else {
      debug.push('LT parse: no local time found in comment');
    }
  } else {
    debug.push('skipping LT comparison: country=' + (orderResult.country || 'null') + ' comment=' + (ltSource ? 'yes' : 'no'));
  }

  return { order: orderResult, debug };
}

// ─── API-based order lookup ──────────────────────────────────────────────────

async function fetchOrderViaAPI(srId, apiKey) {
  // 1. Call Porting Query API to get order details
  const queryUrl = `http://porting.query.prod.telnyx.io:4000/private/v2/porting_orders?filter%5Bsupport_key%5D=${srId}`;
  const resp = await fetch(queryUrl, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!resp.ok) throw new Error(`Porting Query API: ${resp.status}`);
  const data = await resp.json();
  if (!data.data || data.data.length === 0) throw new Error(`Order ${srId} not found`);

  const order = data.data[0];
  const focDate = order.activation_settings?.foc_datetime_actual || null;
  const country = order.country_code || null;
  const status = order.status?.value || null;
  const orderId = order.id;
  const subRequestId = order.sub_request_id;

  // 2. Fetch comments via Porting Query API
  let comment = '';
  let fullComment = '';
  try {
    const commentsUrl = `http://porting.query.prod.telnyx.io:4000/private/v2/porting_orders/${orderId}/comments`;
    console.log('[FOC Extension] Fetching comments from:', commentsUrl);
    const cResp = await fetch(commentsUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    console.log('[FOC Extension] Comments response status:', cResp.status);
    if (cResp.ok) {
      const cData = await cResp.json();
      const comments = cData.data || cData;
      console.log('[FOC Extension] Comments count:', Array.isArray(comments) ? comments.length : 'not array');
      if (Array.isArray(comments) && comments.length > 0) {
        // Sort by created_at (newest first)
        if (comments.length > 1) {
          comments.sort((a, b) => {
            const aTime = a.created_at || a.createdAt || a.inserted_at || a.updated_at || '';
            const bTime = b.created_at || b.createdAt || b.inserted_at || b.updated_at || '';
            if (aTime && bTime) return new Date(bTime) - new Date(aTime);
            return 0;
          });
        }
        
        // Find the comment with scheduling/duration info (not just the latest)
        // Search for keywords: hours, minutes, release, scheduled, confirmed, AM/PM + TZ
        const scheduleRe = /(\d+\s*(?:hours?|hrs?|minutes?|mins?)\s+(?:to\s+)?(?:release|complete|process|port|trigger))|(?:scheduled|rescheduled|confirmed.*(?:FOC|date|port)|carrier.*confirm)|(\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*(?:AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT|CEST|CET|WET|WEST|EEST|EET|GMT|BST|IST|SGT|HKT|JST|KST|TWT|CST|PHT|ICT|MYT|LT))/i;
        
        let selectedComment = null;
        // First: try to find a Telnyx Admin comment with scheduling keywords
        for (const c of comments) {
          const body = c.body || c.text || c.content || '';
          if (c.user_type === 'admin' && scheduleRe.test(body)) {
            selectedComment = c;
            break;
          }
        }
        // Fallback: any comment with scheduling keywords
        if (!selectedComment) {
          for (const c of comments) {
            const body = c.body || c.text || c.content || '';
            if (scheduleRe.test(body)) {
              selectedComment = c;
              break;
            }
          }
        }
        // Last resort: just take the latest comment
        if (!selectedComment) {
          selectedComment = comments[0];
        }
        
        fullComment = selectedComment.body || selectedComment.text || selectedComment.content || '';
        comment = fullComment;
        console.log('[FOC Extension] Selected comment (created:', selectedComment.created_at, ', type:', selectedComment.user_type, '):', fullComment.substring(0, 200));
      }
    } else {
      console.error('[FOC Extension] Comments fetch failed with status:', cResp.status);
    }
  } catch (e) {
    // Comments are nice-to-have, not critical — but log the error for debugging
    console.error('[FOC Extension] Comments fetch exception:', e.message);
  }

  return {
    srId: srId,
    country: country,
    focDate: focDate,
    comment: comment,
    fullComment: fullComment,
    status: status,
    _uuids: { portRequestId: orderId, subRequestId: subRequestId }
  };
}

// ─── Country → IANA Timezone Map ─────────────────────────────────────────────

const COUNTRY_TIMEZONES = {
  // Europe
  AT: 'Europe/Vienna',    // Austria
  BE: 'Europe/Brussels',  // Belgium
  BG: 'Europe/Sofia',     // Bulgaria
  HR: 'Europe/Zagreb',    // Croatia
  CY: 'Asia/Nicosia',     // Cyprus
  CZ: 'Europe/Prague',    // Czech Republic
  DK: 'Europe/Copenhagen',// Denmark
  EE: 'Europe/Tallinn',   // Estonia
  FI: 'Europe/Helsinki',  // Finland
  FR: 'Europe/Paris',     // France
  DE: 'Europe/Berlin',    // Germany
  GR: 'Europe/Athens',    // Greece
  HU: 'Europe/Budapest',  // Hungary
  IE: 'Europe/Dublin',    // Ireland
  IT: 'Europe/Rome',      // Italy
  LV: 'Europe/Riga',      // Latvia
  LT: 'Europe/Vilnius',   // Lithuania
  LU: 'Europe/Luxembourg',// Luxembourg
  MT: 'Europe/Malta',     // Malta
  NL: 'Europe/Amsterdam', // Netherlands
  NO: 'Europe/Oslo',      // Norway
  PL: 'Europe/Warsaw',    // Poland
  PT: 'Europe/Lisbon',    // Portugal
  RO: 'Europe/Bucharest', // Romania
  SK: 'Europe/Bratislava',// Slovakia
  SI: 'Europe/Ljubljana', // Slovenia
  ES: 'Europe/Madrid',    // Spain
  SE: 'Europe/Stockholm', // Sweden
  CH: 'Europe/Zurich',   // Switzerland
  GB: 'Europe/London',    // United Kingdom
  // Asia-Pacific
  AU: 'Australia/Sydney', // Australia (eastern)
  NZ: 'Pacific/Auckland', // New Zealand
  SG: 'Asia/Singapore',   // Singapore
  HK: 'Asia/Hong_Kong',   // Hong Kong
  JP: 'Asia/Tokyo',       // Japan
  KR: 'Asia/Seoul',       // South Korea
  TW: 'Asia/Taipei',      // Taiwan
  IN: 'Asia/Kolkata',     // India
  PH: 'Asia/Manila',      // Philippines
  TH: 'Asia/Bangkok',     // Thailand
  MY: 'Asia/Kuala_Lumpur',// Malaysia
  // Africa / Middle East
  ZA: 'Africa/Johannesburg', // South Africa
  AE: 'Asia/Dubai',       // UAE
  IL: 'Asia/Jerusalem',   // Israel
  SA: 'Asia/Riyadh',      // Saudi Arabia
};

// ─── Timezone Abbreviation → IANA Map ─────────────────────────────────────────

const TZ_ABBREV = {
  // Europe
  CET:  'Europe/Paris',       // Central European Time (winter)
  CEST: 'Europe/Amsterdam',   // Central European Summer Time
  WET:  'Europe/Lisbon',       // Western European Time (winter)
  WEST: 'Europe/Lisbon',       // Western European Summer Time
  EET:  'Europe/Athens',       // Eastern European Time (winter)
  EEST: 'Europe/Athens',       // Eastern European Summer Time
  GMT:  'Europe/London',       // Greenwich Mean Time (winter)
  BST:  'Europe/London',       // British Summer Time
  IST:  'Europe/Dublin',       // Irish Standard Time (summer)
  MET:  'Europe/Paris',        // Middle European Time
  MEST: 'Europe/Paris',       // Middle European Summer Time
  // Asia-Pacific
  AEST: 'Australia/Sydney',    // Australian Eastern Standard/Summer Time
  AEDT: 'Australia/Sydney',    // Australian Eastern Daylight Time
  ACST: 'Australia/Adelaide', // Australian Central Standard/Summer Time
  ACDT: 'Australia/Adelaide', // Australian Central Daylight Time
  AWST: 'Australia/Perth',    // Australian Western Standard Time
  NZST: 'Pacific/Auckland',   // New Zealand Standard Time
  NZDT: 'Pacific/Auckland',   // New Zealand Daylight Time
  SGT:  'Asia/Singapore',     // Singapore Time
  HKT:  'Asia/Hong_Kong',     // Hong Kong Time
  JST:  'Asia/Tokyo',         // Japan Standard Time
  KST:  'Asia/Seoul',         // Korea Standard Time
  TWT:  'Asia/Taipei',        // Taiwan Time
  CST:  'Asia/Shanghai',      // China Standard Time (note: different from US CST)
  IST_IN: 'Asia/Kolkata',     // India Standard Time
  PHT:  'Asia/Manila',        // Philippine Time
  ICT:  'Asia/Bangkok',       // Indochina Time
  MYT:  'Asia/Kuala_Lumpur',  // Malaysia Time
  // Africa / Middle East
  SAST: 'Africa/Johannesburg', // South Africa Standard Time
  GST:  'Asia/Dubai',         // Gulf Standard Time
  IST_IL: 'Asia/Jerusalem',   // Israel Standard Time
  AST:  'Asia/Riyadh',        // Arabia Standard Time
};

// ─── LT → CST Comparison ──────────────────────────────────────────────────────

function parseLocalTimeFromComment(comment, country, dateFormatOverride) {
  if (!comment) return null;

  // Date format override from user settings (DD/MM or MM/DD)
  // If set, this takes priority over the country-based default
  var useMonthFirst;
  if (dateFormatOverride === 'MM/DD') {
    useMonthFirst = true;
  } else if (dateFormatOverride === 'DD/MM') {
    useMonthFirst = false;
  } else {
    // Fall back to country-based default
    var MMDD_COUNTRIES = ['US', 'PH', 'CA', 'PR', 'GU', 'MP', 'AS', 'FM', 'MH', 'PW'];
    useMonthFirst = country && MMDD_COUNTRIES.indexOf(country) !== -1;
  }

  // Extract the date from the comment text first
  // Patterns: "04/24/2026", "04/24/26", "4/24/2026", "24/4/26", "2026-04-24"
  var dateMatch = comment.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  var commentYear = null, commentMonth = null, commentDay = null;

  // Handle malformed date like "29/42026" (missing slash between month and year)
  // This happens when people type "29/4/2026" as "29/42026" by mistake
  if (!dateMatch) {
    var malformedDate = comment.match(/(\d{1,2})\/(\d{1,2})(\d{4})/);
    if (malformedDate) {
      var a = parseInt(malformedDate[1]);
      var b = parseInt(malformedDate[2]);
      var yr = parseInt(malformedDate[3]);
      // Reconstruct as if properly formatted
      dateMatch = [malformedDate[0], String(a), String(b), String(yr)];
    }
  }
  if (dateMatch) {
    var a = parseInt(dateMatch[1]);
    var b = parseInt(dateMatch[2]);
    var yr = parseInt(dateMatch[3]);
    if (yr < 100) yr += 2000; // 26 → 2026
    commentYear = yr;
    // Smart detection: if first number > 12, it must be DD/MM (day first)
    // If second number > 12, it must be MM/DD (month first)
    // If both <= 12, use country-based default
    if (a > 12) {
      // First number can't be a month → DD/MM format
      commentDay = a;
      commentMonth = b;
    } else if (b > 12) {
      // Second number can't be a month → MM/DD format
      commentMonth = a;
      commentDay = b;
    } else {
      // Both <= 12, ambiguous — use country-based default
      if (useMonthFirst) {
        commentMonth = a;
        commentDay = b;
      } else {
        commentDay = a;
        commentMonth = b;
      }
    }
  }
  // Also try ISO format: "2026-04-24"
  if (!dateMatch) {
    var isoDate = comment.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoDate) {
      commentYear = parseInt(isoDate[1]);
      commentMonth = parseInt(isoDate[2]);
      commentDay = parseInt(isoDate[3]);
    }
  }

  // Also try natural language date: "29th of April", "April 29th", "29 April"
  if (!dateMatch && !isoDate) {
    var monthNames = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
    var nlPatterns = [
      // "29th of April", "29th of April 2026"
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})?\b/i,
      // "April 29th", "April 29, 2026"
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?\b/i
    ];
    for (var nli = 0; nli < nlPatterns.length; nli++) {
      var nlMatch = comment.match(nlPatterns[nli]);
      if (nlMatch) {
        if (nli === 0) {
          // "29th of April" pattern
          commentDay = parseInt(nlMatch[1]);
          commentMonth = monthNames[nlMatch[2].toLowerCase()];
          if (nlMatch[3]) commentYear = parseInt(nlMatch[3]);
        } else {
          // "April 29th" pattern
          commentMonth = monthNames[nlMatch[1].toLowerCase()];
          commentDay = parseInt(nlMatch[2]);
          if (nlMatch[3]) commentYear = parseInt(nlMatch[3]);
        }
        break;
      }
    }
  }

  // If we have a date but no time, assume midnight LT for comparison purposes
  // This handles comments like "scheduled for the 29th of April"
  if (commentDay && commentMonth && !dateMatch && !isoDate) {
    // No numeric date was found, but we have a natural language date
    // Default to midnight local time so the date comparison works
    var tz = COUNTRY_TIMEZONES[country] || 'UTC';
    var yr = commentYear || new Date().getFullYear();
    return { hour: 0, minute: 0, tzAbbr: 'LT', year: yr, month: commentMonth, day: commentDay, dateOnly: true };
  }

  // Try timezone abbreviations first: "10 AM AEST", "3:00 PM CEST", "10am JST"
  var abbrevs = Object.keys(TZ_ABBREV).sort(function(a, b) { return b.length - a.length; }); // longest first
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
  // Fallback: "LT" (Local Time) — will use detected country for timezone
  var match = comment.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*LT/i);
  if (!match) return null;
  var hour = parseInt(match[1]);
  var minute = match[2] ? parseInt(match[2]) : 0;
  var ampm = match[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return { hour: hour, minute: minute, tzAbbr: 'LT', year: commentYear, month: commentMonth, day: commentDay };
}

function getTzOffsetDiff(countryTz, year, month, day) {
  // Returns the offset difference (country - CST) in minutes at the given date
  // Positive means country is ahead of CST
  var utcMs = Date.UTC(year, month - 1, day, 12, 0, 0);
  var countryFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: countryTz, hour: 'numeric', minute: 'numeric', hour12: false
  });
  var cstFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hour12: false
  });
  var countryStr = countryFmt.format(new Date(utcMs));
  var cstStr = cstFmt.format(new Date(utcMs));
  var cMatch = countryStr.match(/(\d{1,2}):(\d{2})/);
  var cstMatch = cstStr.match(/(\d{1,2}):(\d{2})/);
  if (!cMatch || !cstMatch) return null;
  var countryMin = parseInt(cMatch[1]) * 60 + parseInt(cMatch[2]);
  var cstMin = parseInt(cstMatch[1]) * 60 + parseInt(cstMatch[2]);
  return countryMin - cstMin;
}

function compareLtWithFoc(focDateStr, ltTime, country) {
  // focDateStr = "2026-04-29T03:00:00" (CST floating)
  // ltTime = { hour: 8, minute: 0, tzAbbr: 'AEST', tzIana: 'Australia/Sydney', year: 2026, month: 4, day: 24 }
  // country = "AU"
  // Returns { match: true/false, dateMatch: bool, ltLabel: "Apr 24, 8:00 AM AEST (AU)", cstLabel: "Apr 23, 5:00 PM CST" }

  // Use explicit timezone from abbreviation if available, otherwise fall back to country map
  var tz = (ltTime.tzIana) ? ltTime.tzIana : COUNTRY_TIMEZONES[country];
  var tzLabel = (ltTime.tzAbbr && ltTime.tzAbbr !== 'LT') ? ltTime.tzAbbr : 'LT';
  if (!tz) return { match: null, ltLabel: null, cstLabel: null, error: 'No timezone for ' + country };

  // Parse FOC date — API returns UTC (e.g., "2026-08-18T12:00:00Z")
  // We need to convert it to CST (America/Chicago) for comparison
  var focUtcMatch = focDateStr.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!focUtcMatch) return { match: null, error: 'Invalid FOC date format' };

  // Create a UTC Date object from the FOC date
  var focUtcYear = parseInt(focUtcMatch[1]), focUtcMo = parseInt(focUtcMatch[2]), focUtcDy = parseInt(focUtcMatch[3]);
  var focUtcHour = parseInt(focUtcMatch[4]), focUtcMin = parseInt(focUtcMatch[5]);
  var focDateObj = new Date(Date.UTC(focUtcYear, focUtcMo - 1, focUtcDy, focUtcHour, focUtcMin));

  // Format FOC date in CST (America/Chicago) to get the actual CST time
  var focCstFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: 'short', day: 'numeric',
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

  // Get FOC year in CST (could differ from UTC year near Jan 1)
  var focYearFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' });
  var focYear = parseInt(focYearFmt.format(focDateObj));
  var focMo = parseInt(focDateObj.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'numeric' }));

  // Determine the local date from the comment, or fall back to FOC date
  var ltYear = (ltTime.year) ? ltTime.year : focYear;
  var ltMo = (ltTime.month) ? ltTime.month : focMo;
  var ltDy = (ltTime.day) ? ltTime.day : focDy;

  // Convert local time to CST using Intl.DateTimeFormat
  // Strategy: find the UTC time that, when formatted in the country TZ, gives us the local time
  // If we only have a date (no time), just compare the dates directly
  if (ltTime.dateOnly) {
    var dateMatch = (ltYear === focYear && ltMo === focMo && ltDy === focDy);
    var monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var ltLabel = monthNames[ltMo] + ' ' + ltDy + ', ' + ltYear + ' (date only, ' + country + ')';
    var cstLabel = monthNames[focMo] + ' ' + focDy + ', ' + focYear + ' CST';
    return {
      match: dateMatch,
      dateMatch: dateMatch,
      ltLabel: ltLabel,
      cstLabel: cstLabel,
      note: 'Date-only comparison (no time in comment)'
    };
  }

  // Then format that same UTC time in CST
  var targetHour = ltTime.hour;
  var targetMin = ltTime.minute;

  // Search for the UTC time on the local date (+/- 1 day to handle timezone wrapping)
  var utcBase = Date.UTC(ltYear, ltMo - 1, ltDy, 0, 0, 0);
  var foundUtc = null;

  // Check UTC times from 12h before to 24h after (covers all timezone offsets)
  var countryFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false
  });

  // Step 1: Coarse search (every 30 min) to find the approximate UTC hour
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
      // Check if we're within 1 hour of the target AND the date matches
      var dateMatches = (fmtYr === ltYear && fmtMo === ltMo && fmtDy === ltDy);
      var diff = Math.abs(fmtH - targetHour);
      if (dateMatches && (diff === 0 || diff === 23)) {
        // Step 2: Fine search (every 1 min) within this hour
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

  // Now format this UTC moment in CST
  var cstDateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: true
  });
  var cstStr = cstDateFmt.format(new Date(foundUtc));
  // Parse: "Apr 23, 5:00 PM"
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

  // Get the CST year (should be same as FOC year in most cases)
  var cstYearFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric'
  });
  var cstYear = parseInt(cstYearFmt.format(new Date(foundUtc)));

  // Format labels
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

  // Compare the full datetime (date + time) with FOC
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
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(token2);
        }
      });
    });
  });
}

// Auto-detect email from authenticated Google account and save to chrome.storage.sync
async function detectAndSaveEmail(token) {
  try {
    var res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.ok) {
      var info = await res.json();
      if (info.email) {
        chrome.storage.sync.set({ userEmail: info.email });
        return info.email;
      }
    }
  } catch (e) {
    // Non-critical — email detection is best-effort
  }
  return null;
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
  // Use proper Date arithmetic to handle multi-day durations
  var yr = parseInt(parts[1]), mo = parseInt(parts[2]), dy = parseInt(parts[3]);
  var h = parseInt(parts[4]), m = parseInt(parts[5]);
  // Add hours and minutes using UTC Date object
  var dt = new Date(Date.UTC(yr, mo - 1, dy, h, m) + hours * 3600000);
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()) + 'T' + pad(dt.getUTCHours()) + ':' + pad(dt.getUTCMinutes()) + ':00';
}

async function createCalendarEvent(eventData) {
  try {
    var token = await getGoogleToken();

    // Auto-detect and save the authenticated user's email to chrome.storage.sync
    await detectAndSaveEmail(token);

    var srId = eventData.srId, country = eventData.country, focDate = eventData.focDate, comment = eventData.comment;
    var durationHours = eventData.durationHours || parseDuration(comment);

    var startDateTime = focDate.includes('+') || focDate.includes('Z') ? focDate : focDate + '-05:00';  // CST offset
    var endDateTime = addHoursToFloating(focDate, durationHours);
    if (!endDateTime.includes('+') && !endDateTime.includes('Z')) endDateTime += '-05:00';  // CST offset

    var event = {
      summary: (country || '??') + ' ACT: ' + srId,
      description: [
        'Porting order FOC',
        '',
        'SR ID: ' + srId,
        'Country: ' + (country || 'N/A'),
        'Comment: ' + (comment || 'N/A'),
        '',
        'PortingAdmin: https://portingadmin.telnyx.com/#!/sub-request/' + (eventData._uuids ? eventData._uuids.portRequestId + '/' + eventData._uuids.subRequestId : 'queue?search=' + srId)
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
