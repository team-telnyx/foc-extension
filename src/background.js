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
      url: 'https://portingadmin.telnyx.com/#!/queue?statuses=in-process&statuses=submitted&statuses=exception&statuses=foc-date-confirmed',
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
      debugLog.push('total text length: ' + rawText.length);
      // Search for description value in full text
      var descSearch = rawText.match(/\b([A-Z]{2})\s+(local|national|international|tollfree|mobile)\b/i);
      debugLog.push('country regex on full text: ' + (descSearch ? descSearch[0] : 'NO MATCH'));

      var result = { srId: srNum, country: country, focDate: focDate, comment: comment };
      if (uuids) result._uuids = uuids;
      return result;
    }

    // ─── Step 1: Navigate to queue if not already there ────────────
    debugLog.push('current hash: ' + window.location.hash.substring(0, 80));
    if (!window.location.hash.includes('queue')) {
      window.location.hash = '#!/queue?statuses=in-process&statuses=submitted&statuses=exception&statuses=foc-date-confirmed';
      await new Promise(function(r) { setTimeout(r, 4000); });
      debugLog.push('navigated to queue, hash: ' + window.location.hash.substring(0, 80));
    }

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
    // Log to console so we can see it in DevTools
    console.log('[FOC Extension] Result:', JSON.stringify(result));
    console.log('[FOC Extension] Debug:', debugLog.join(' | '));
    return result;
  })();
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
