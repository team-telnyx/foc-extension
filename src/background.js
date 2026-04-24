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
    if (tabResult.focDate) {
      // ── LT → CST comparison ──
      var ltSource = tabResult.fullComment || tabResult.comment;
      var ltTime = parseLocalTimeFromComment(ltSource);
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

      chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
        if (updatedTabId !== tabId) return;
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
              cleanup({ error: 'Could not execute script in PortingAdmin context.', _debugLog: ['execute failed: ' + (chrome.runtime.lastError?.message || 'no results')] });
              return;
            }
            cleanup(results[0].result);
          });
        }, 5000);
      });

      setTimeout(function() {
        cleanup({ error: 'Timed out connecting to PortingAdmin.', _debugLog: ['30s timeout'] });
      }, 30000);
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
      for (var fi = 0; fi < lines.length; fi++) {
        if (/actual\s+foc/i.test(lines[fi])) {
          for (var fj = fi; fj <= Math.min(fi + 3, lines.length - 1); fj++) {
            var dm = lines[fj].match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
            if (dm) { focDate = dm[1]; break; }
          }
          if (focDate) break;
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
      var commentElements = document.querySelectorAll('.comment-text, .note-text, [ng-if*="comment"], [ng-bind*="comment"]');
      for (var cei = 0; cei < commentElements.length; cei++) {
        var cText = (commentElements[cei].textContent || '').trim();
        if (cText.length > comment.length && new RegExp('\\d+\\s*(am|pm)\\s*(' + tzAbbrRe + ')', 'i').test(cText)) {
          fullComment = cText;
          break;
        }
      }
      
      // If no dedicated element, search the full page text for time + timezone patterns
      if (!fullComment) {
        // Look for the sentence containing "X AM/PM [TZ_ABBREV]"
        var ltSentence = rawText.match(new RegExp('[^.!?]*\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)\\s*(?:' + tzAbbrRe + ')[^.!?]*[.!?]', 'i'));
        if (ltSentence) {
          fullComment = ltSentence[0];
        }
      }
      
      // Broader fallback: any sentence with a time (AM/PM) near a timezone keyword
      if (!fullComment) {
        var broadRe = new RegExp("[^.!?]{10,}\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)[^.!?]{0,30}(?:AEST|AEDT|CEST|CET|JST|KST|SGT|HKT|NZST|NZDT|LT)[^.!?]*", "i");
        var broadMatch = rawText.match(broadRe);
        if (broadMatch) {
          fullComment = broadMatch[0];
        }
      }
      
      // Final fallback: any sentence with AM/PM + timezone abbreviation
      if (!fullComment && country) {
        var anyTimeRe = new RegExp("[^.!?]{5,}\\b\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)\\s*(?:LT|AEST|AEDT|CEST|CET|JST|KST|SGT|HKT|NZST|NZDT|ACST|ACDT|AWST|WET|WEST|EET|EEST|BST|GMT|IST|GST|SAST|AST|PHT|ICT|MYT|TWT|MET|MEST)\\b[^.!?]{0,50}", "i");
        var anyTimeMatch = rawText.match(anyTimeRe);
        if (anyTimeMatch) {
          fullComment = anyTimeMatch[0];
        }
      }
      
      // Bare time fallback: no TZ abbreviation found, but "X AM/PM" exists in comment text
      // Assume it's local time for the detected country
      if (!fullComment && country) {
        // Look for a time like "8:00 AM" or "10 AM" in a sentence that mentions
        // carrier confirmation, FOC, or release — signals it's a local time
        var bareTimeRe = new RegExp('[^.!?]*\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM)[^.!?]*', 'i');
        var bareTimeMatch = rawText.match(bareTimeRe);
        if (bareTimeMatch) {
          // Only use if the sentence looks like it's about FOC/porting timing
          var sentence = bareTimeMatch[0];
          if (/(?:confirmation|confirm|FOC|release|port|trigger|carrier|schedule)/i.test(sentence)) {
            fullComment = sentence + ' LT';  // Append LT so parseLocalTimeFromComment matches it
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
      debugLog.push('country detected: ' + (country || 'NULL'));
      debugLog.push('fullComment: ' + (fullComment ? fullComment.substring(0, 100) : 'NULL'));
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
    await new Promise(function(r) { setTimeout(r, 5000); });
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
    // Use document.execCommand('insertText') which simulates actual keyboard input
    // This is the most reliable way to trigger Angular's model update
    searchInput.focus();
    searchInput.select(); // select any existing text
    
    // Try execCommand first (most reliable for Angular)
    var inserted = false;
    try {
      inserted = document.execCommand('insertText', false, srId);
    } catch(e) {
      debugLog.push('execCommand failed: ' + e.message);
    }
    
    if (!inserted || searchInput.value !== srId) {
      debugLog.push('execCommand didn\'t work (value="' + searchInput.value + '"), trying native setter');
      // Fallback: native setter + events
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(searchInput, srId);
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: srId }));
    } else {
      debugLog.push('execCommand inserted value="' + searchInput.value + '"');
    }
    
    // Also try Angular scope if available
    try {
      var ngScope = window.angular && window.angular.element(searchInput).scope();
      if (ngScope) {
        var ngModel = searchInput.getAttribute('ng-model');
        if (ngModel) {
          debugLog.push('also setting via ng-model: ' + ngModel);
          var parts = ngModel.split('.');
          var obj = ngScope;
          for (var pi = 0; pi < parts.length - 1; pi++) {
            obj = obj[parts[pi]];
            if (!obj) break;
          }
          if (obj) {
            obj[parts[parts.length - 1]] = srId;
            try { ngScope.$apply(); } catch(e) {}
            debugLog.push('set via scope + $apply');
          }
        }
      }
    } catch(e) {
      debugLog.push('angular scope attempt: ' + e.message);
    }

    debugLog.push('search input value after set: "' + searchInput.value + '"');

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
      debugLog.push('no Search button found near input');
      // Try pressing Enter instead
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    } else {
      searchBtn.click();
      debugLog.push('clicked Search button');
    }

    if (searchBtn) {
      searchBtn.click();
      debugLog.push('clicked Search button');
    } else {
      // Try Enter key
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
      debugLog.push('no Search button, pressed Enter');
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
      var sample = document.body.innerText.substring(0, 500).replace(/\n/g, ' | ');
      debugLog.push('no link found. page sample: ' + sample);
      debugLog.push('search input value: "' + searchInput.value + '"');
      return { error: 'Could not find ' + srId + ' in search results.', _debugLog: debugLog };
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
      debugLog.push('FOC not found on first read, waiting and retrying...');
      await new Promise(function(r) { setTimeout(r, 4000); });
      result = readDOM(srId);
    }
    if (!result.focDate) {
      debugLog.push('FOC still not found, waiting more...');
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

// ─── LT → CST Comparison ──────────────────────────────────────────────────────

function parseLocalTimeFromComment(comment) {
  if (!comment) return null;
  
  // Extract the date from the comment text first
  // Patterns: "04/24/2026", "04/24/26", "4/24/2026", "2026-04-24"
  var dateMatch = comment.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  var commentYear = null, commentMonth = null, commentDay = null;
  if (dateMatch) {
    commentMonth = parseInt(dateMatch[1]);
    commentDay = parseInt(dateMatch[2]);
    commentYear = parseInt(dateMatch[3]);
    if (commentYear < 100) commentYear += 2000; // 26 → 2026
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
  // Then format that same UTC time in CST
  var targetHour = ltTime.hour;
  var targetMin = ltTime.minute;
  
  // Search for the UTC time on the local date (+/- 1 day to handle timezone wrapping)
  var utcBase = Date.UTC(ltYear, ltMo - 1, ltDy, 0, 0, 0);
  var foundUtc = null;
  
  // Check UTC times from 12h before to 24h after (covers all timezone offsets)
  var countryFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false
  });
  
  // Step 1: Coarse search (every 30 min) to find the approximate UTC hour
  for (var utcOff = -12; utcOff <= 24; utcOff++) {
    var testMs = utcBase + utcOff * 3600000;
    var formatted = countryFmt.format(new Date(testMs));
    var fmtMatch = formatted.match(/(\d{1,2}):(\d{2})/);
    if (fmtMatch) {
      var fmtH = parseInt(fmtMatch[1]);
      if (fmtH === 24) fmtH = 0;
      // Check if we're within 1 hour of the target
      var diff = Math.abs(fmtH - targetHour);
      if (diff === 0 || diff === 23) {
        // Step 2: Fine search (every 1 min) within this hour
        for (var fineOff = 0; fineOff < 60; fineOff++) {
          var fineMs = testMs + fineOff * 60000;
          var fineFmt = countryFmt.format(new Date(fineMs));
          var fineMatch = fineFmt.match(/(\d{1,2}):(\d{2})/);
          if (fineMatch) {
            var fH = parseInt(fineMatch[1]);
            if (fH === 24) fH = 0;
            var fM = parseInt(fineMatch[2]);
            if (fH === targetHour && fM === targetMin) {
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
  var yr = parseInt(parts[1]), mo = parseInt(parts[2]), dy = parseInt(parts[3]);
  var h = parseInt(parts[4]) + Math.floor(hours);
  var m = parseInt(parts[5]) + Math.round((hours % 1) * 60);
  if (m >= 60) { h++; m -= 60; }
  if (h >= 24) {
    h -= 24;
    var d = new Date(Date.UTC(yr, mo - 1, dy + 1));
    yr = d.getUTCFullYear(); mo = d.getUTCMonth() + 1; dy = d.getUTCDate();
  }
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return yr + '-' + pad(mo) + '-' + pad(dy) + 'T' + pad(h) + ':' + pad(m) + ':00';
}

async function createCalendarEvent(eventData) {
  try {
    var token = await getGoogleToken();
    var srId = eventData.srId, country = eventData.country, focDate = eventData.focDate, comment = eventData.comment;
    var durationHours = eventData.durationHours || parseDuration(comment);

    var startDateTime = focDate;
    var endDateTime = addHoursToFloating(focDate, durationHours);

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
