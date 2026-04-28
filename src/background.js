// Background service worker
// Handles API calls (Telnyx + Google Calendar)

let lastDetectedSrId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SR_DETECTED') {
    lastDetectedSrId = msg.srId;
    chrome.storage.session.set({ detectedSrId: msg.srId });
  }

  if (msg.type === 'LOOKUP_AND_READ') {
    lookupAndRead(msg.srId).then(sendResponse);
    return true;
  }

  if (msg.type === 'CREATE_EVENT') {
    createCalendarEvent(msg.eventData).then(sendResponse);
    return true;
  }
});

// ─── Main flow ──────────────────────────────────────────────────────────────

async function lookupAndRead(srId) {
  let debug = [];

  debug.push('opening queue tab');
  const tabResult = await fetchViaTabApi(srId);
  if (tabResult && !tabResult.error) {
    debug.push('got data, focDate=' + (tabResult.focDate || 'null'));
    // Propagate readDOM debug info to main debug
    if (tabResult._debugLog) {
      var keyLogs = tabResult._debugLog.filter(function(l) {
        return /DIRECT SCHED MATCH|fullComment (before|after|source|final|stripped)|cBlock\[|admin block\[|commentBlocks count|adminBlocks count|Priority|Admin NL|Admin AM|Any block|DOM schedule|tz time|country regex/i.test(l);
      });
      if (keyLogs.length > 0) debug.push.apply(debug, keyLogs);
    }
    if (tabResult.focDate) {
      // ── Fetch latest comment via API for accurate D&T Verify ──
      var ltSource = tabResult.fullComment || tabResult.comment;
      debug.push('uuids: ' + JSON.stringify(tabResult._uuids));
      if (tabResult._uuids && tabResult._uuids.subRequestId) {
        try {
          var apiResult = await fetchLatestCommentViaApi(tabResult._uuids);
          if (apiResult && apiResult.debug) debug.push.apply(debug, apiResult.debug);
          if (apiResult && apiResult.text) {
            debug.push('API comment used: ' + apiResult.text.substring(0, 300));
            ltSource = apiResult.text;  // Prefer API-sourced latest comment
          } else {
            debug.push('API returned no text, using rawText fallback');
          }
        } catch (e) {
          debug.push('API comment fetch failed: ' + e.message);
        }
      } else {
        debug.push('no uuids available, skipping API fetch');
      }
      // ── LT → CST comparison ──
      var ltTime = parseLocalTimeFromComment(ltSource, tabResult.country);
      if (ltTime && tabResult.country) {
        var comparison = compareLtWithFoc(tabResult.focDate, ltTime, tabResult.country);
        tabResult.ltComparison = comparison;
        debug.push('LT comparison: ' + (comparison.match === true ? 'MATCH' : comparison.match === false ? 'MISMATCH' : 'N/A') + ' (' + ltSource.substring(0, 60) + ')');
      }
      return { order: tabResult, debug };
    }
    return { error: 'No FOC date found on ' + (tabResult.srId || srId) + '. FOC must be confirmed first.', debug };
  } else {
    debug.push('tab error: ' + (tabResult ? tabResult.error : 'null'));
    if (tabResult && tabResult._debugLog) {
      debug.push('tab debug: ' + tabResult._debugLog.join(' | '));
    }
  }
  return { error: 'Could not find ' + srId + '. Make sure you are logged in to PortingAdmin.', debug };
}

// ─── Open background tab and search/navigate from within PortingAdmin ──────

async function fetchViaTabApi(srId) {
  return new Promise((resolve) => {
    chrome.tabs.create({
      url: 'https://portingadmin.telnyx.com/#!/queue?statuses=all',
      active: false
    }, function(tab) {
      const tabId = tab.id;
      let done = false;

      function cleanup(result) {
        if (done) return;
        done = true;
        // Auto-close the background tab after getting results
        chrome.tabs.remove(tabId).catch(function() {});
        resolve(result);
      }

      // Track loading progress for debugging
      var loadLog = [];

      chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
        if (updatedTabId !== tabId) return;
        loadLog.push(info.status + (info.url ? ' -> ' + info.url : ''));
        if (info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);

        // Wait for PortingAdmin Angular app to boot
        setTimeout(function() {
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: fetchOrderFromPageContext,
            args: [srId]
          }, function(results) {
            if (chrome.runtime.lastError || !results || !results[0]) {
              cleanup({ error: 'Could not execute script in PortingAdmin context.', _debugLog: ['execute failed: ' + (chrome.runtime.lastError?.message || 'no results'), 'loadLog: ' + loadLog.join(', ')] });
              return;
            }
            cleanup(results[0].result);
          });
        }, 5000);
      });

      setTimeout(function() {
        cleanup({ error: 'Timed out connecting to PortingAdmin.', _debugLog: ['60s timeout', 'loadLog: ' + loadLog.join(', ')] });
      }, 60000);
    });
  });
}

// This function runs INSIDE the PortingAdmin page context
// It searches for the SR order, clicks the result, and reads the FOC date
function fetchOrderFromPageContext(srId) {
  return (async function() {
    var debugLog = [];

    // ─── Inline helper: read order from current page DOM ─────────────
    function readDOM(srId) {
      var rawText = document.body.innerText;
      var srMatch = rawText.match(/sub\s+request\s+(sr_[a-z0-9]+)/i);
      var srNum = srMatch ? srMatch[1] : srId;

      // Find the Description field value — it contains the country code like "AT national" or "ES local"
      var country = null;
      var lines = rawText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      
      // ── Primary: Read country from the Description INPUT FIELD ──
      // The Description field is a read-only input with value like "AT national" or "ES local"
      // We only need the first 2 letters (the country code)
      var descInput = null;
      var allInputs = document.querySelectorAll('input[type="text"], input:not([type]), input[readonly]');
      for (var inp = 0; inp < allInputs.length; inp++) {
        var inpNgModel = allInputs[inp].getAttribute('ng-model') || '';
        var inpPlaceholder = (allInputs[inp].placeholder || '').toLowerCase();
        // The Description field has ng-model containing "description"
        if (inpNgModel.toLowerCase().includes('description') || inpPlaceholder.includes('description')) {
          descInput = allInputs[inp];
          break;
        }
      }
      // If no ng-model match, try finding the input near a "Description" label
      if (!descInput) {
        var allLabels = document.querySelectorAll('label, th, td, span, div');
        for (var lb = 0; lb < allLabels.length; lb++) {
          if ((allLabels[lb].textContent || '').trim().toLowerCase() === 'description') {
            // Find the nearest input
            var container = allLabels[lb].parentElement;
            for (var wl = 0; wl < 5; wl++) {
              if (!container) break;
              var nearInputs = container.querySelectorAll('input');
              for (var ni = 0; ni < nearInputs.length; ni++) {
                if (nearInputs[ni].value && nearInputs[ni].value.trim().length > 0) {
                  descInput = nearInputs[ni];
                  break;
                }
              }
              if (descInput) break;
              container = container.parentElement;
            }
            if (descInput) break;
          }
        }
      }
      
      if (descInput) {
        var descVal = (descInput.value || '').trim();
        // Extract first 2-letter country code from the description value
        var ccMatch = descVal.match(/^([A-Z]{2})\b/i);
        if (ccMatch) {
          country = ccMatch[1].toUpperCase();
        }
      }
      
      // Fallback: search innerText for "XX national/local/tollfree/mobile" pattern
      if (!country) {
        var pageMatch = rawText.match(/\b([A-Z]{2})\s+(local|national|international|tollfree|mobile|shared-cost)\b/i);
        if (pageMatch) { country = pageMatch[1].toUpperCase(); }
      }

      var focDate = null;
      // Method 1: Find "Actual FOC" label and grab the date from next lines
      for (var fi = 0; fi < lines.length; fi++) {
        if (/actual\s+foc/i.test(lines[fi])) {
          for (var fj = fi; fj <= Math.min(fi + 3, lines.length - 1); fj++) {
            var dm = lines[fj].match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
            if (dm) { focDate = dm[1]; break; }
          }
          if (focDate) break;
        }
      }
      // Method 2: If not found, search rawText directly for FOC date patterns
      if (!focDate) {
        // Look for a date near "FOC" text in the raw text
        var focNearby = rawText.match(/actual\s+foc[^]*?(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
        if (focNearby) { focDate = focNearby[1]; }
      }
      // Method 3: Try reading from Angular scope or input fields
      if (!focDate) {
        // Look for any element with ng-model containing "foc" or "actualFoc"
        var focInputs = document.querySelectorAll('input, span, div, td');
        for (var fii = 0; fii < focInputs.length; fii++) {
          var ngm = (focInputs[fii].getAttribute('ng-model') || '').toLowerCase();
          var txt = (focInputs[fii].textContent || focInputs[fii].value || '').trim();
          if ((ngm.includes('foc') || ngm.includes('actual_foc')) && /\d{1,2}\/\d{1,2}\/\d{4}/.test(txt)) {
            var dm2 = txt.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
            if (dm2) { focDate = dm2[1]; break; }
          }
        }
      }
      if (focDate) {
        var m = focDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (m) {
          var mo = parseInt(m[1]), dy = parseInt(m[2]), yr = parseInt(m[3]);
          var hr = parseInt(m[4]), mn = parseInt(m[5]), ap = m[6].toUpperCase();
          if (ap === 'PM' && hr !== 12) hr += 12;
          if (ap === 'AM' && hr === 12) hr = 0;
          var pad = function(n) { return String(n).padStart(2, '0'); };
          focDate = yr + '-' + pad(mo) + '-' + pad(dy) + 'T' + pad(hr) + ':' + pad(mn) + ':00';
        }
      }

      var uuidMatch = window.location.hash.match(/sub-request\/([a-f0-9-]{36})\/([a-f0-9-]{36})/i);
      var uuids = uuidMatch ? { portRequestId: uuidMatch[1], subRequestId: uuidMatch[2] } : null;
      var comment = '';
      var fullComment = '';  // Full comment text for LT time parsing
      
      // Build a regex that matches any timezone abbreviation or "LT"
      var tzAbbrList = ['LT', 'AEST', 'AEDT', 'ACST', 'ACDT', 'AWST', 'NZST', 'NZDT',
        'CEST', 'CET', 'WET', 'WEST', 'EEST', 'EET', 'GMT', 'BST', 'IST',
        'SGT', 'HKT', 'JST', 'KST', 'TWT', 'CST', 'PHT', 'ICT', 'MYT',
        'SAST', 'GST', 'AST', 'MET', 'MEST'];
      var tzAbbrRe = tzAbbrList.join('|');
      
      // Try to get the full comment/note text from the page
      // ── Strategy: find comment blocks in the DOM, prefer the LATEST with a time pattern ──
      var commentElements = document.querySelectorAll('.comment-text, .note-text, [ng-if*="comment"], [ng-bind*="comment"]');
      if (commentElements.length === 0) {
        // Broader: look for comment list items or card-like containers
        commentElements = document.querySelectorAll('.comment, .note, .activity-item, .timeline-item, [class*="comment"], [class*="note"]');
      }
      // ── Split rawText into comment blocks using timestamp delimiters ──
      // DOM commentElements don't respect chronological order; rawText splitting does
      var commentSplitRe = /(?=(?:User|Telnyx Admin)\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+at\s+\d{1,2}:\d{2}(?:AM|PM)?)/gi;
      var commentBlocks = rawText.split(commentSplitRe).filter(function(b) { return b.trim().length > 5 && /^(?:User|Telnyx Admin)\s/i.test(b.trim()); });
      debugLog.push('commentBlocks split: ' + commentBlocks.length);
      if (commentBlocks.length > 0) {
        debugLog.push('first block (80): ' + commentBlocks[0].substring(0, 80));
        debugLog.push('last block (80): ' + commentBlocks[commentBlocks.length - 1].substring(0, 80));
      }
      
      // ── NEW: Direct rawText search for scheduling sentence with time+TZ ──
      // Search EACH commentBlock individually (not entire rawText) to prevent
      // regex from spanning across comment boundaries and picking wrong block
      var schedKwPattern = '(?:scheduled|rescheduled|updated\\s+the\\s+(?:date|FOC)\\s+to|confirmed\\s+(?:the\\s+)?(?:FOC|date|port)|FOC\\s+confirmed|date\\s+confirmed|carrier\\s+(?:has\\s+)?(?:given\\s+)?confirm|confirmation\\s+for)';
      var directRe1 = new RegExp('\\b' + schedKwPattern + '\\b[\\s\\S]*?\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)\\s*(?:' + tzAbbrRe + ')\\b', 'i');
      var directRe2 = new RegExp('\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)\\s*(?:' + tzAbbrRe + ')\\b[\\s\\S]*?(?:' + schedKwPattern + ')', 'i');
      var directRe3 = new RegExp('\\b' + schedKwPattern + '\\b[\\s\\S]*?\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)\\b', 'i');
      // commentBlocks are in REVERSE chronological order (newest first at lower indices)
      // So iterate FORWARD (0 → length-1) to find the newest matching block
      // ALSO validate the extracted date against FOC date — skip matches for old rescheduled dates
      var directSchedMatch = null;
      var directSchedBlockIdx = -1;
      // Parse FOC date for comparison
      var focDateObj = null;
      if (focDate) {
        var focDateParts = focDate.match(/(\d{4})-(\d{2})-(\d{2})T/);
        if (focDateParts) {
          focDateObj = { year: parseInt(focDateParts[1]), month: parseInt(focDateParts[2]), day: parseInt(focDateParts[3]) };
        }
      }
      for (var dbi = 0; dbi < commentBlocks.length; dbi++) {
        var matchedRe = null;
        if (directRe1.test(commentBlocks[dbi])) matchedRe = 're1';
        else { directRe1.lastIndex = 0; if (directRe2.test(commentBlocks[dbi])) matchedRe = 're2'; }
        if (!matchedRe) { directRe2.lastIndex = 0; if (directRe3.test(commentBlocks[dbi])) matchedRe = 're3'; }
        if (!matchedRe) { directRe3.lastIndex = 0; continue; }
        // Found a match — validate date against FOC date if possible
        var blockDateMatch = commentBlocks[dbi].match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
        // Handle malformed date like "29/42026"
        if (!blockDateMatch) {
          var malformedDate = commentBlocks[dbi].match(/(\d{1,2})\/(\d{1,2})(\d{4})/);
          if (malformedDate) blockDateMatch = [malformedDate[0], malformedDate[1], malformedDate[2], malformedDate[3]];
        }
        if (focDateObj && blockDateMatch) {
          // Check ALL dates in the block — if none are within 3 days of FOC, skip (rescheduled)
          var allBlockDates = [];
          var bdRe = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
          var bdM;
          while ((bdM = bdRe.exec(commentBlocks[dbi])) !== null) {
            allBlockDates.push({ a: parseInt(bdM[1]), b: parseInt(bdM[2]), yr: parseInt(bdM[3]) });
          }
          // Also check malformed dates like "29/42026"
          var bdM2;
          var bdRe2 = /(\d{1,2})\/(\d{1,2})(\d{4})/g;
          while ((bdM2 = bdRe2.exec(commentBlocks[dbi])) !== null) {
            // Avoid double-counting if already matched by the normal regex
            var isDupe = allBlockDates.some(function(d) { return d.a === parseInt(bdM2[1]) && d.b === parseInt(bdM2[2]); });
            if (!isDupe) allBlockDates.push({ a: parseInt(bdM2[1]), b: parseInt(bdM2[2]), yr: parseInt(bdM2[3]) });
          }
          var anyDateClose = false;
          for (var bdi2 = 0; bdi2 < allBlockDates.length; bdi2++) {
            var bd = allBlockDates[bdi2];
            if (bd.yr < 100) bd.yr += 2000;
            var bDay2, bMo2;
            if (bd.a > 12) { bDay2 = bd.a; bMo2 = bd.b; }
            else if (bd.b > 12) { bMo2 = bd.a; bDay2 = bd.b; }
            else { bDay2 = bd.b; bMo2 = bd.a; } // DD/MM default for non-US
            var bdMs = Date.UTC(bd.yr, bMo2 - 1, bDay2);
            var fMs = Date.UTC(focDateObj.year, focDateObj.month - 1, focDateObj.day);
            var dd = Math.abs(bdMs - fMs) / 86400000;
            if (dd <= 3) { anyDateClose = true; break; }
          }
          if (!anyDateClose) {
            debugLog.push('DIRECT SCHED MATCH (' + matchedRe + ') block[' + dbi + '] SKIPPED: no date within 3 days of FOC');
            directRe1.lastIndex = 0; directRe2.lastIndex = 0; directRe3.lastIndex = 0;
            continue; // skip this old comment, keep looking
          }
        }
        directSchedMatch = commentBlocks[dbi];
        directSchedBlockIdx = dbi;
        debugLog.push('DIRECT SCHED MATCH (' + matchedRe + ') block[' + dbi + ']: ' + directSchedMatch.substring(0, 150));
        break;
      }
      if (directSchedMatch) {
        fullComment = directSchedMatch.trim();
        debugLog.push('DIRECT SCHED MATCH final: ' + fullComment.substring(0, 150));
      }
      
      // Filter to ONLY Telnyx Admin blocks that contain scheduling keywords
      // These are the authoritative date confirmations, not user requests
      var scheduleKeywords = /(?:scheduled|rescheduled|updated\s+the\s+(?:date|FOC)\s+to|confirmed\s+(?:the\s+)?(?:FOC|date|port)|FOC\s+confirmed|date\s+confirmed|carrier\s+(?:has\s+)?(?:given\s+)?confirm|confirmation\s+for)/i;
      var adminBlocks = commentBlocks.filter(function(b) {
        return /^Telnyx Admin\s/i.test(b.trim()) && scheduleKeywords.test(b);
      });
      
      // Sort admin blocks by their timestamp so [0]=oldest, [N]=newest
      // Parse "Telnyx Admin MM/DD/YY at H:MMAMPM" prefix from each block
      adminBlocks.sort(function(a, b) {
        var tsRe = /^(?:Telnyx Admin|User)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+at\s+(\d{1,2}):(\d{2})(AM|PM)?/i;
        var mA = a.match(tsRe), mB = b.match(tsRe);
        if (!mA || !mB) return 0;
        var parseTs = function(m) {
          var mo = parseInt(m[1]), dy = parseInt(m[2]), yr = parseInt(m[3]);
          if (yr < 100) yr += 2000;
          var hr = parseInt(m[4]), mn = parseInt(m[5]), ap = (m[6] || '').toUpperCase();
          if (ap === 'PM' && hr !== 12) hr += 12;
          if (ap === 'AM' && hr === 12) hr = 0;
          return yr * 100000000 + mo * 1000000 + dy * 10000 + hr * 100 + mn;
        };
        return parseTs(mA) - parseTs(mB);
      });
      
      // ── Before priorities: log all comment blocks for debugging ──
      debugLog.push('commentBlocks count: ' + commentBlocks.length);
      for (var cbi = 0; cbi < Math.min(commentBlocks.length, 10); cbi++) {
        debugLog.push('cBlock[' + cbi + ']: ' + commentBlocks[cbi].substring(0, 80).replace(/\n/g, ' '));
      }
      debugLog.push('adminBlocks count: ' + adminBlocks.length);
      if (adminBlocks.length > 0) {
        for (var abdi = 0; abdi < adminBlocks.length; abdi++) {
          debugLog.push('admin block[' + abdi + '] (80): ' + adminBlocks[abdi].substring(0, 80).replace(/\n/g, ' '));
        }
      }
      debugLog.push('fullComment before priorities: "' + (fullComment || 'EMPTY') + '"');
      
      // ── Priority 1: Latest Telnyx Admin schedule comment with NL date ──
      if (!fullComment && adminBlocks.length > 0) {
        var monthNames = 'january|february|march|april|may|june|july|august|september|october|november|december';
        var nlDateRe = new RegExp('(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:' + monthNames + ')|(?:' + monthNames + ')\\s+\\d{1,2}(?:st|nd|rd|th)?)', 'i');
        for (var adi = adminBlocks.length - 1; adi >= 0; adi--) {
          if (nlDateRe.test(adminBlocks[adi])) {
            fullComment = adminBlocks[adi].trim();
            debugLog.push('Admin NL date [' + adi + ']: ' + fullComment.substring(0, 120));
            break;
          }
        }
      }
      
      // ── Priority 2: Latest Telnyx Admin schedule comment with AM/PM + TZ ──
      if (!fullComment && adminBlocks.length > 0) {
        for (var adi2 = adminBlocks.length - 1; adi2 >= 0; adi2--) {
          if (new RegExp('\\d+\\s*(am|pm)\\s*(' + tzAbbrRe + ')', 'i').test(adminBlocks[adi2])) {
            fullComment = adminBlocks[adi2].trim();
            debugLog.push('Admin AM/PM+TZ [' + adi2 + ']: ' + fullComment.substring(0, 120));
            break;
          }
        }
      }
      
      // ── Priority 3: Latest Telnyx Admin schedule comment with AM/PM (no TZ) ──
      if (!fullComment && adminBlocks.length > 0) {
        for (var adi3 = adminBlocks.length - 1; adi3 >= 0; adi3--) {
          if (/\d{1,2}(?::\d{2})?\s*(?:AM|PM)/i.test(adminBlocks[adi3])) {
            fullComment = adminBlocks[adi3].trim();
            debugLog.push('Admin AM/PM only [' + adi3 + ']: ' + fullComment.substring(0, 120));
            break;
          }
        }
      }
      
      // ── Priority 4: Fallback to ALL comment blocks (incl. User) with AM/PM + TZ ──
      if (!fullComment && commentBlocks.length > 0) {
        for (var adi4 = commentBlocks.length - 1; adi4 >= 0; adi4--) {
          if (new RegExp('\\d+\\s*(am|pm)\\s*(' + tzAbbrRe + ')', 'i').test(commentBlocks[adi4])) {
            fullComment = commentBlocks[adi4].trim();
            debugLog.push('Any block AM/PM+TZ [' + adi4 + ']: ' + fullComment.substring(0, 120));
            break;
          }
        }
      }
      
      // ── Priority 5: Fallback to ALL comment blocks with NL date ──
      if (!fullComment && commentBlocks.length > 0) {
        var monthNames2 = 'january|february|march|april|may|june|july|august|september|october|november|december';
        var nlDateRe2 = new RegExp('(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:' + monthNames2 + ')|(?:' + monthNames2 + ')\\s+\\d{1,2}(?:st|nd|rd|th)?)', 'i');
        for (var nbi = commentBlocks.length - 1; nbi >= 0; nbi--) {
          if (nlDateRe2.test(commentBlocks[nbi])) {
            fullComment = commentBlocks[nbi].trim();
            debugLog.push('Any block NL date [' + nbi + ']: ' + fullComment.substring(0, 120));
            break;
          }
        }
      }
      
      // ── Priority 3: DOM-based fallback (only if commentBlocks splitting failed) ──
      // Only consider DOM elements that have scheduling keywords
      if (!fullComment && commentElements.length > 0) {
        var domScheduleKeywords = /(?:scheduled|rescheduled|updated\s+the\s+(?:date|FOC)\s+to|confirmed\s+(?:the\s+)?(?:FOC|date|port)|FOC\s+confirmed|date\s+confirmed|carrier\s+(?:has\s+)?(?:given\s+)?confirm|confirmation\s+for)/i;
        for (var cei = commentElements.length - 1; cei >= 0; cei--) {
          var cText = (commentElements[cei].textContent || '').trim();
          if (cText.length > comment.length && domScheduleKeywords.test(cText) && new RegExp('\\d+\\s*(am|pm)\\s*(' + tzAbbrRe + ')', 'i').test(cText)) {
            fullComment = cText;
            debugLog.push('DOM schedule+AM/PM+TZ [' + cei + ']: ' + fullComment.substring(0, 120));
            break;
          }
        }
      }
      // ── Priority 4: DOM-based any AM/PM time with schedule keyword ──
      if (!fullComment && commentElements.length > 0) {
        var domScheduleKeywords2 = /(?:scheduled|rescheduled|updated\s+the\s+(?:date|FOC)\s+to|confirmed\s+(?:the\s+)?(?:FOC|date|port)|FOC\s+confirmed|date\s+confirmed|carrier\s+(?:has\s+)?(?:given\s+)?confirm|confirmation\s+for)/i;
        for (var cei2 = commentElements.length - 1; cei2 >= 0; cei2--) {
          var cText2 = (commentElements[cei2].textContent || '').trim();
          if (cText2.length > comment.length && domScheduleKeywords2.test(cText2) && /\d{1,2}(?::\d{2})?\s*(?:AM|PM)/i.test(cText2)) {
            fullComment = cText2;
            debugLog.push('DOM schedule+AM/PM [' + cei2 + ']: ' + fullComment.substring(0, 120));
            break;
          }
        }
      }
      
      if (!fullComment) {
        // Look for the sentence containing "X AM/PM [TZ_ABBREV]" — prefer LAST (newest) match
        var ltRe = new RegExp('[^.!?]*\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)\\s*(?:' + tzAbbrRe + ')[^.!?]*[.!?]', 'gi');
        var ltAll = rawText.match(ltRe);
        if (ltAll && ltAll.length > 0) {
          fullComment = ltAll[ltAll.length - 1];
        }
      }
      
      // Broader fallback: any sentence with a time (AM/PM) near a timezone keyword
      if (!fullComment) {
        var broadRe = new RegExp("[^.!?]{10,}\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)[^.!?]{0,30}(?:AEST|AEDT|CEST|CET|JST|KST|SGT|HKT|NZST|NZDT|LT)[^.!?]*", "gi");
        var broadAll = rawText.match(broadRe);
        if (broadAll && broadAll.length > 0) {
          fullComment = broadAll[broadAll.length - 1];
        }
      }
      
      // Final fallback: any sentence with AM/PM + timezone abbreviation
      if (!fullComment && country) {
        var anyTimeRe = new RegExp("[^.!?]{5,}\\b\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)\\s*(?:LT|AEST|AEDT|CEST|CET|JST|KST|SGT|HKT|NZST|NZDT|ACST|ACDT|AWST|WET|WEST|EET|EEST|BST|GMT|IST|GST|SAST|AST|PHT|ICT|MYT|TWT|MET|MEST)\\b[^.!?]{0,50}", "gi");
        var anyTimeAll = rawText.match(anyTimeRe);
        if (anyTimeAll && anyTimeAll.length > 0) {
          fullComment = anyTimeAll[anyTimeAll.length - 1];
        }
      }
      
      // Bare time fallback: no TZ abbreviation found, but "X AM/PM" exists in comment text
      // Assume it's local time for the detected country
      if (!fullComment && country) {
        // Look for a time like "8:00 AM" or "10 AM" in a sentence that mentions
        // carrier confirmation, FOC, or release — signals it's a local time
        var bareTimeRe = new RegExp('[^.!?]*\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)[^.!?]*', 'gi');
        var bareTimeAll = rawText.match(bareTimeRe);
        if (bareTimeAll && bareTimeAll.length > 0) {
          // Only use if the sentence looks like it's about FOC/porting timing
          // Check from last match first (newest)
          for (var bti = bareTimeAll.length - 1; bti >= 0; bti--) {
            var sentence = bareTimeAll[bti];
            if (/(?:confirmation|confirm|FOC|release|port|trigger|carrier|schedule)/i.test(sentence)) {
              fullComment = sentence + ' LT';  // Append LT so parseLocalTimeFromComment matches it
              break;
            }
          }
        }
      }
      
      // Search for duration info in comments
      // Common patterns: "2 hours to release", "30 minutes to release", "3 hrs to complete"
      var durMatch = rawText.match(/(\d+)\s*(?:hours?|hrs?|minutes?|mins?)\s+(?:to\s+)?(?:release|complete|process|port|trigger)/i);
      if (durMatch) {
        comment = durMatch[0];
      }
      if (!comment) {
        // "will then have X hours/minutes"
        var willMatch = rawText.match(/(?:have|will|then\s+have)\s+(\d+)\s*(?:hours?|hrs?|minutes?|mins?)\b/i);
        if (willMatch) {
          comment = willMatch[0];
        }
      }
      if (!comment) {
        // Generic: any "X hours/minutes" on page
        var anyMatch = rawText.match(/(\d+)\s*(?:hours?|hrs?|minutes?|mins?)\b/i);
        if (anyMatch) {
          comment = anyMatch[0];
        }
      }

      // Dump a sample of the page text for debugging
      var pageSample = rawText.substring(0, 2000).replace(/\n/g, ' | ');
      debugLog.push('page text (2k): ' + pageSample);
      debugLog.push('commentElements count: ' + commentElements.length);
      // Dump comment element class names and text snippets for debugging
      if (commentElements.length === 0) {
        // Try to find what elements contain comment-like text
        var allEls = document.querySelectorAll('div, p, span, li, td');
        var commentLike = [];
        for (var ali = 0; ali < allEls.length && commentLike.length < 10; ali++) {
          var elTxt = (allEls[ali].textContent || '').trim();
          if (elTxt.length > 50 && elTxt.length < 2000 && /\d{1,2}\/\d{1,2}\/\d{2,4}|AM|PM/i.test(elTxt)) {
            commentLike.push(allEls[ali].tagName + '.' + (allEls[ali].className || '').toString().substring(0, 40) + ': ' + elTxt.substring(0, 80));
          }
        }
        debugLog.push('comment-like elements: ' + commentLike.length);
        for (var cli = 0; cli < commentLike.length; cli++) {
          debugLog.push('  el[' + cli + ']: ' + commentLike[cli]);
        }
      }
      // Track where fullComment came from
      var fullCommentSource = 'none';
      if (directSchedMatch && directSchedMatch.length > 0) {
        fullCommentSource = 'DIRECT_SCHED_MATCH';
      }
      debugLog.push('fullComment source: ' + (fullComment ? (fullCommentSource !== 'none' ? fullCommentSource : 'PRIORITY_OR_DOM') : 'none'));
      debugLog.push('country detected: ' + (country || 'NULL'));
      // Strip "Telnyx Admin/User MM/DD/YY at H:MMAMPM" prefix from fullComment
      // so the timestamp's numeric date doesn't override NL dates in the body
      debugLog.push('fullComment after all priorities: "' + (fullComment ? fullComment.substring(0, 120) : 'EMPTY') + '"');
      if (fullComment) {
        var stripped = fullComment.replace(/^(?:Telnyx Admin|User)\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+at\s+\d{1,2}:\d{2}(?:AM|PM)?\s*/i, '');
        debugLog.push('fullComment stripped: ' + stripped.substring(0, 120));
        fullComment = stripped || fullComment;  // Don't empty it if strip fails
      }
      debugLog.push('fullComment final: ' + (fullComment ? fullComment.substring(0, 100) : 'NULL'));
      // Check if AEST/CEST etc. appears in rawText
      var tzInText = rawText.match(/\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*(?:AEST|AEDT|CEST|CET|JST|KST|SGT|HKT|NZST|NZDT|LT)/i);
      debugLog.push('tz time in rawText: ' + (tzInText ? tzInText[0] : 'NULL'));
      debugLog.push('total text length: ' + rawText.length);
      // Search for description value in full text
      var descSearch = rawText.match(/\b([A-Z]{2})\s+(local|national|international|tollfree|mobile)\b/i);
      debugLog.push('country regex on full text: ' + (descSearch ? descSearch[0] : 'NO MATCH'));

      var result = { srId: srNum, country: country, focDate: focDate, comment: comment, fullComment: fullComment, status: null };
      
      // ── Read the order status badge from the detail page ──
      // The status appears as a badge next to "Sub Request sr_xxx"
      // e.g., "Submitted", "FOC Date Confirmed", "Exception", "Ported", "Cancelled"
      var statusBadges = document.querySelectorAll('.label, .badge, span[class*="label"], span[class*="badge"], span[class*="status"], span[class*="tag"]');
      for (var sbi = 0; sbi < statusBadges.length; sbi++) {
        var sbText = (statusBadges[sbi].textContent || '').trim();
        if (/^(in process|submitted|exception|foc date confirmed|ported|cancelled|cancel pending|new)$/i.test(sbText)) {
          result.status = sbText;
          break;
        }
      }
      // Fallback: look for status text in the heading area
      if (!result.status) {
        var headingArea = rawText.substring(0, rawText.indexOf('Port Request'));
        if (headingArea) {
          var statusMatch = headingArea.match(/\b(In Process|Submitted|Exception|FOC Date Confirmed|Ported|Cancelled|Cancel Pending|New)\b/i);
          if (statusMatch) {
            result.status = statusMatch[1];
          }
        }
      }
      
      if (uuids) result._uuids = uuids;
      return result;
    }

    // ─── Step 1: Navigate to queue with ALL statuses ────────────
    debugLog.push('current hash: ' + window.location.hash.substring(0, 80));
    // Navigate to queue with ALL statuses — ?statuses=all does the job
    window.location.hash = '#!/queue?statuses=all';
    await new Promise(function(r) { setTimeout(r, 8000); });  // Increased from 5s to 8s
    debugLog.push('navigated to queue (statuses=all), hash: ' + window.location.hash.substring(0, 80));

    // ─── Step 2: Find and fill the search input ────────────────────
    var searchInput = null;
    // Search ALL inputs including those with type="search" and hidden inputs
    var allInputs = document.querySelectorAll('input');
    debugLog.push('total inputs: ' + allInputs.length);
    
    // Log all inputs with their placeholders for debugging
    var inputDebug = [];
    for (var ii = 0; ii < allInputs.length; ii++) {
      var ph = allInputs[ii].placeholder || '';
      var tp = allInputs[ii].type || 'text';
      var ngm = allInputs[ii].getAttribute('ng-model') || '';
      if (ph || ngm) {
        inputDebug.push('[' + ii + '] type=' + tp + ' placeholder="' + ph + '" ng-model=' + ngm);
      }
    }
    debugLog.push('inputs with attrs: ' + inputDebug.length + ' → ' + inputDebug.slice(0, 5).join(' | '));

    // Find the "ID or partial number" field specifically
    for (var ii2 = 0; ii2 < allInputs.length; ii2++) {
      var ph2 = (allInputs[ii2].placeholder || '').toLowerCase();
      if (ph2.includes('id') || ph2.includes('partial number')) {
        searchInput = allInputs[ii2];
        debugLog.push('found ID search input: placeholder="' + allInputs[ii2].placeholder + '"');
        break;
      }
    }
    if (!searchInput) {
      debugLog.push('no ID search input found');
      return { error: 'Could not find "ID or partial number" search field.', _debugLog: debugLog };
    }

    // ─── Step 3: Type into the search field ────────────────────────
    // Strategy: Set via Angular's own model controller + force digest via $rootScope
    searchInput.focus();
    searchInput.select();

    // Method 1: Angular ngModelController.$setViewValue — proper AngularJS API
    var ngModelSetOk = false;
    try {
      var ngModelCtrl = window.angular && window.angular.element(searchInput).controller('ngModel');
      if (ngModelCtrl) {
        ngModelCtrl.$setViewValue(srId);
        ngModelCtrl.$render();
        ngModelSetOk = true;
        debugLog.push('ngModelController.$setViewValue ok');
      } else {
        debugLog.push('no ngModelController found');
      }
    } catch(e) {
      debugLog.push('ngModelController error: ' + e.message);
    }

    // Method 2: Direct scope assignment — walk ng-model path and set on scope
    try {
      var ngScope = window.angular && window.angular.element(searchInput).scope();
      var ngModel = searchInput.getAttribute('ng-model');
      if (ngScope && ngModel) {
        var parts = ngModel.split('.');
        var obj = ngScope;
        for (var pi = 0; pi < parts.length - 1; pi++) {
          obj = obj[parts[pi]];
          if (!obj) { debugLog.push('scope path broke at ' + parts[pi]); break; }
        }
        if (obj) {
          obj[parts[parts.length - 1]] = srId;
          debugLog.push('scope path set: ' + ngModel + ' = ' + srId);
        }
      }
    } catch(e) {
      debugLog.push('scope path error: ' + e.message);
    }

    // Method 3: Force $rootScope.$apply() to flush all pending digest work
    try {
      var inj = window.angular && window.angular.element(document.body).injector();
      if (inj) {
        var $rootScope = inj.get('$rootScope');
        if ($rootScope.$$phase) {
          // Already in digest — schedule apply for next tick
          $rootScope.$applyAsync();
          await new Promise(function(r) { setTimeout(r, 100); });
          debugLog.push('$applyAsync scheduled (was in $$phase)');
        } else {
          $rootScope.$apply();
          debugLog.push('$rootScope.$apply() done');
        }
      } else {
        debugLog.push('no $injector found');
      }
    } catch(e) {
      debugLog.push('$rootScope apply error: ' + e.message);
    }

    // Method 4: Native setter + events as final fallback
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(searchInput, srId);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    debugLog.push('native setter fallback, value="' + searchInput.value + '"');

    // Verify Angular model picked it up
    try {
      var ngScopeVerify = window.angular && window.angular.element(searchInput).scope();
      var ngModelVerify = searchInput.getAttribute('ng-model') || '';
      var verifyObj = ngScopeVerify;
      ngModelVerify.split('.').forEach(function(p) { verifyObj = verifyObj ? verifyObj[p] : null; });
      debugLog.push('Angular model after set: "' + verifyObj + '"');
    } catch(e) { debugLog.push('verify error: ' + e.message); }

    // Small delay to let Angular's digest cycle pick up the new value
    await new Promise(function(r) { setTimeout(r, 2000); });  // Increased from 1s to 2s

    // ─── Step 4: Click the Search button ──────────────────────────
    // Find the Search button that's a sibling of this specific input
    var searchBtn = null;
    // The Search button should be in the same parent container as the input
    // Walk up a few levels and look for a button
    var walkEl = searchInput;
    for (var wl = 0; wl < 5; wl++) {
      walkEl = walkEl.parentElement;
      if (!walkEl) break;
      var btns = walkEl.querySelectorAll('button');
      for (var bwi = 0; bwi < btns.length; bwi++) {
        if ((btns[bwi].textContent || '').trim().toLowerCase() === 'search') {
          searchBtn = btns[bwi];
          debugLog.push('found Search button near input (level ' + wl + ')');
          break;
        }
      }
      if (searchBtn) break;
    }
    
    if (!searchBtn) {
      debugLog.push('no Search button found near input, pressing Enter');
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    } else {
      searchBtn.click();
      debugLog.push('clicked Search button');
    }

    // ─── Step 4: Wait for results and find the right link ──────────
    await new Promise(function(r) { setTimeout(r, 4000); });
    debugLog.push('looking for results...');

    // The queue page shows results as cards/rows with:
    // - SR ID as small gray text (e.g., "sr_9edc7b")
    // - Description as a blue clickable link (e.g., "AT national")
    // Find the element with the exact SR ID text, then find its associated link

    var srShortId = srId.replace(/^sr_/i, '');
    var foundLink = null;

    // Strategy: scan all text nodes for the SR ID, then walk up to find an anchor
    var allElements = document.querySelectorAll('*');
    var srElement = null;
    for (var ei = 0; ei < allElements.length; ei++) {
      var elText = (allElements[ei].textContent || '').trim();
      // Match exact SR ID or just the reference part
      if (elText.toLowerCase() === srId.toLowerCase() || elText.toLowerCase() === srShortId.toLowerCase()) {
        srElement = allElements[ei];
        debugLog.push('found SR text element: tag=' + srElement.tagName + ' text="' + elText.substring(0, 30) + '"');
        break;
      }
    }

    if (srElement) {
      // Walk up the DOM to find a container that has an anchor linking to a sub-request
      var walkEl = srElement;
      for (var wi = 0; wi < 12; wi++) {
        walkEl = walkEl.parentElement;
        if (!walkEl) break;
        var anchors = walkEl.querySelectorAll('a');
        for (var ai = 0; ai < anchors.length; ai++) {
          var href = anchors[ai].getAttribute('href') || '';
          if (/sub-request\/[a-f0-9-]{36}/i.test(href)) {
            foundLink = anchors[ai];
            debugLog.push('found link via SR text walk: text="' + (foundLink.textContent || '').substring(0, 40).trim() + '"');
            break;
          }
        }
        if (foundLink) break;
      }
    }

    if (!foundLink) {
      // Fallback: look for any element whose text contains the SR ID and find nearby link
      debugLog.push('exact SR text not found, trying contains search...');
      var allSpans = document.querySelectorAll('span, small, div, p');
      for (var si = 0; si < allSpans.length; si++) {
        if ((allSpans[si].textContent || '').toLowerCase().includes(srShortId.toLowerCase())) {
          var parent3 = allSpans[si];
          for (var wj = 0; wj < 8; wj++) {
            parent3 = parent3.parentElement;
            if (!parent3) break;
            var links = parent3.querySelectorAll('a');
            for (var li = 0; li < links.length; li++) {
              var lHref = links[li].getAttribute('href') || '';
              if (/sub-request\/[a-f0-9-]{36}/i.test(lHref)) {
                foundLink = links[li];
                debugLog.push('found link via contains: text="' + (foundLink.textContent || '').substring(0, 40).trim() + '"');
                break;
              }
            }
            if (foundLink) break;
          }
          if (foundLink) break;
        }
      }
    }

    if (!foundLink) {
      // Last resort: log page contents
      var sample = document.body.innerText.substring(0, 500).replace(/n/g, ' | ');
      debugLog.push('no link found. page sample: ' + sample);
      debugLog.push('search input value: "' + searchInput.value + '"');
      
      // ── Retry: wait longer and search again ──
      debugLog.push('retrying search in 5s...');
      await new Promise(function(r) { setTimeout(r, 5000); });
      
      // Re-type and re-click
      searchInput.focus();
      searchInput.select();
      try { document.execCommand('insertText', false, srId); } catch(e) {}
      if (searchInput.value !== srId) {
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(searchInput, srId);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // Trigger Angular
      try {
        var ngScope2 = window.angular && window.angular.element(searchInput).scope();
        if (ngScope2) { ngScope2.$apply(); }
      } catch(e) {}
      
      if (searchBtn) { searchBtn.click(); }
      else { searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); }
      debugLog.push('retry: clicked search again');
      await new Promise(function(r) { setTimeout(r, 6000); });
      
      // Try finding SR again
      var retryElements = document.querySelectorAll('*');
      for (var rei = 0; rei < retryElements.length; rei++) {
        var ret = (retryElements[rei].textContent || '').trim();
        if (ret.toLowerCase() === srId.toLowerCase() || ret.toLowerCase() === srShortId.toLowerCase()) {
          var walkR = retryElements[rei];
          for (var rwi = 0; rwi < 12; rwi++) {
            walkR = walkR.parentElement;
            if (!walkR) break;
            var retryAnchors = walkR.querySelectorAll('a');
            for (var rai = 0; rai < retryAnchors.length; rai++) {
              if (/sub-request\/[a-f0-9-]{36}/i.test(retryAnchors[rai].getAttribute('href') || '')) {
                foundLink = retryAnchors[rai];
                debugLog.push('retry: found link!');
                break;
              }
            }
            if (foundLink) break;
          }
          if (foundLink) break;
        }
      }
      
      if (!foundLink) {
        debugLog.push('retry also failed, trying direct URL navigation...');
        // Try navigating directly to the sub-request page using the SR ID
        // The PortingAdmin URL format is: #!/sub-request/{portRequestId}/{subRequestId}
        // We don't have the UUIDs yet, but we can try a different approach:
        // Navigate to the queue page with a search parameter in the URL hash
        var directUrl = '#!/queue?statuses=all&search=' + encodeURIComponent(srId);
        debugLog.push('trying direct URL: ' + directUrl);
        window.location.hash = directUrl;
        await new Promise(function(r) { setTimeout(r, 6000); });
        
        // Try one more time to find the link
        var directElements = document.querySelectorAll('*');
        for (var dei = 0; dei < directElements.length; dei++) {
          var det = (directElements[dei].textContent || '').trim();
          if (det.toLowerCase() === srId.toLowerCase() || det.toLowerCase() === srShortId.toLowerCase()) {
            var walkD = directElements[dei];
            for (var dwi = 0; dwi < 12; dwi++) {
              walkD = walkD.parentElement;
              if (!walkD) break;
              var directAnchors = walkD.querySelectorAll('a');
              for (var dai = 0; dai < directAnchors.length; dai++) {
                if (/sub-request\/[a-f0-9-]{36}/i.test(directAnchors[dai].getAttribute('href') || '')) {
                  foundLink = directAnchors[dai];
                  debugLog.push('direct URL nav found link!');
                  break;
                }
              }
              if (foundLink) break;
            }
            if (foundLink) break;
          }
        }
        
        if (!foundLink) {
          debugLog.push('all search methods failed');
          return { error: 'Could not find ' + srId + ' in search results.', _debugLog: debugLog };
        }
      }
    }

    // ─── Step 5: Click the result link ─────────────────────────────
    foundLink.click();
    debugLog.push('clicked result link');
    await new Promise(function(r) { setTimeout(r, 4000); });

    // Check if we're on the detail page
    if (!/sub-request\/[a-f0-9-]{36}/i.test(window.location.hash)) {
      debugLog.push('not on detail page after click, hash=' + window.location.hash.substring(0, 80));
      return { error: 'Failed to navigate to detail page.', _debugLog: debugLog };
    }

    // ─── Step 6: Read FOC data from detail page ────────────────────
    debugLog.push('on detail page, reading...');
    var result = readDOM(srId);
    
    // If FOC date not found, the page might not be fully rendered yet — retry
    if (!result.focDate) {
      debugLog.push('FOC not found on first read, waiting 6s and retrying...');
      await new Promise(function(r) { setTimeout(r, 6000); });
      result = readDOM(srId);
    }
    if (!result.focDate) {
      debugLog.push('FOC still not found, waiting 5s more...');
      await new Promise(function(r) { setTimeout(r, 5000); });
      result = readDOM(srId);
    }
    if (!result.focDate) {
      debugLog.push('FOC still not found after 3 attempts, trying scroll...');
      // Scroll down and retry in case FOC date is below the fold
      window.scrollTo(0, document.body.scrollHeight / 2);
      await new Promise(function(r) { setTimeout(r, 3000); });
      result = readDOM(srId);
    }
    
    result._debugLog = debugLog;
    debugLog.push('country found: ' + (result.country || 'null'));
    debugLog.push('focDate found: ' + (result.focDate || 'null'));
    debugLog.push('srId found: ' + (result.srId || 'null'));
    debugLog.push('comment found: ' + (result.comment || 'null'));
    debugLog.push('status found: ' + (result.status || 'null'));
    // Log to console so we can see it in DevTools
    console.log('[FOC Extension] Result:', JSON.stringify(result));
    console.log('[FOC Extension] Debug:', debugLog.join(' | '));
    return result;
  })();
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

// ─── Fetch latest comment via PortingAdmin API ──────────────────────────────
// Uses the sub-request UUID to call the API and get the most recent comment.
// This avoids parsing rawText which contains ALL old comments.
async function fetchLatestCommentViaApi(uuids) {
  // Returns { text, debug } where debug is an array of log strings
  var subUuid = uuids.subRequestId;
  var portUuid = uuids.portRequestId;
  var apiDebug = [];
  if (!subUuid) return { text: null, debug: apiDebug };
  
  // Try the sub-request comments endpoint
  var apiUrl = 'https://api-internal.telnyx.com/api/porting/v1/sub_requests/' + subUuid + '/comments';
  
  try {
    var cookies = await chrome.cookies.getAll({ domain: '.telnyx.com' });
    var cookieHeader = cookies.map(function(c) { return c.name + '=' + c.value; }).join('; ');
    
    var resp = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    apiDebug.push('API status: ' + resp.status + ' url: ' + apiUrl.substring(0, 80));
    
    if (!resp.ok) {
      // Try alternate endpoint pattern
      apiUrl = 'https://api-internal.telnyx.com/api/porting/v1/port_requests/' + portUuid + '/sub_requests/' + subUuid + '/comments';
      resp = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Cookie': cookieHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      apiDebug.push('API alt status: ' + resp.status);
    }
    
    if (!resp.ok) return { text: null, debug: apiDebug };
    
    var data = await resp.json();
    apiDebug.push('API resp keys: ' + Object.keys(data).join(','));
    
    // Comments are usually in data.data or data as an array
    var comments = data.data || data;
    if (!Array.isArray(comments) || comments.length === 0) {
      apiDebug.push('API no comments array');
      return { text: null, debug: apiDebug };
    }
    
    apiDebug.push('API comments count: ' + comments.length);
    apiDebug.push('API first keys: ' + Object.keys(comments[0]).join(','));
    apiDebug.push('API first: ' + JSON.stringify(comments[0]).substring(0, 150));
    apiDebug.push('API last: ' + JSON.stringify(comments[comments.length - 1]).substring(0, 150));
    
    // Simply take the LAST comment (APIs almost always return newest-last)
    // We also try sorting by date if available, but last-item is the reliable fallback
    if (comments.length > 1) {
      comments.sort(function(a, b) {
        var aTime = a.created_at || a.createdAt || a.created_at_date || a.inserted_at || a.updated_at || '';
        var bTime = b.created_at || b.createdAt || b.created_at_date || b.inserted_at || b.updated_at || '';
        if (aTime && bTime) {
          return new Date(bTime) - new Date(aTime);  // newest first
        }
        return 0;
      });
    }
    
    // Check if sorting actually worked (has valid date fields)
    var hasDateField = comments[0] && (comments[0].created_at || comments[0].createdAt || comments[0].created_at_date || comments[0].inserted_at || comments[0].updated_at);
    
    // Always take comments[0] after sort (newest first), OR last item if no dates (newest last)
    var latest = hasDateField ? comments[0] : comments[comments.length - 1];
    
    var text = latest.body || latest.text || latest.content || latest.comment || null;
    apiDebug.push('API selected (hasDate=' + hasDateField + '): ' + (text || '').substring(0, 200));
    
    return { text: text, debug: apiDebug };
  } catch (e) {
    return null;
  }
}

// ─── LT → CST Comparison ──────────────────────────────────────────────────────

function parseLocalTimeFromComment(comment, country) {
  if (!comment) return null;
  
  // Countries that use MM/DD format (month first) — default assumption
  // All others default to DD/MM (day first) when ambiguous
  var MMDD_COUNTRIES = ['US', 'PH', 'CA', 'PR', 'GU', 'MP', 'AS', 'FM', 'MH', 'PW'];
  var useMonthFirst = country && MMDD_COUNTRIES.indexOf(country) !== -1;
  
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
  
  var focParts = focDateStr.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!focParts) return { match: null, error: 'Invalid FOC date format' };
  
  var focYear = parseInt(focParts[1]), focMo = parseInt(focParts[2]), focDy = parseInt(focParts[3]);
  var focHourCST = parseInt(focParts[4]), focMinCST = parseInt(focParts[5]);
  
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
        'PortingAdmin: https://portingadmin.telnyx.com/#!/sub-requests?q=' + srId
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
