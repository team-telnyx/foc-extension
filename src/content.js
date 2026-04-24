// Content script: runs on portingadmin.telnyx.com
// Extracts FOC order data from the current page and URL

function extractUUIDsFromURL() {
  // URL pattern: /#!/sub-request/{port_request_uuid}/{sub_request_uuid}
  const match = window.location.hash.match(
    /sub-request\/([a-f0-9-]{36})\/([a-f0-9-]{36})/i
  );
  if (match) return { portRequestId: match[1], subRequestId: match[2] };
  return null;
}

function extractSrIdFromPage() {
  // Check URL first
  const urlMatch = window.location.href.match(/\/(sr_[a-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];

  // PortingAdmin shows "Sub Request sr_xxx" as a heading
  var allH = document.querySelectorAll('h1, h2, h3, h4, .panel-title, .page-header, [class*="title"]');
  for (var i = 0; i < allH.length; i++) {
    var srMatch = allH[i].textContent.match(/sub\s+request\s+(sr_[a-z0-9]+)/i);
    if (srMatch) return srMatch[1];
  }
  // Try any heading for sr_
  for (var j = 0; j < allH.length; j++) {
    var srM2 = allH[j].textContent.match(/\b(sr_[a-z0-9]+)\b/i);
    if (srM2) return srM2[1];
  }
  return null;
}

function parseCSTDate(dateStr) {
  var clean = dateStr.replace(/^CST:\s*/i, '').trim();
  var m = clean.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    var month = parseInt(m[1]), day = parseInt(m[2]), year = parseInt(m[3]);
    var hour = parseInt(m[4]), min = parseInt(m[5]), ampm = m[6].toUpperCase();
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    var pad = function(n) { return String(n).padStart(2, '0'); };
    return year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hour) + ':' + pad(min) + ':00';
  }
  var d = new Date(clean);
  return isNaN(d) ? null : d.toISOString();
}

function extractFromAngularScope() {
  try {
    const selectors = ['[ng-controller]', '[data-ng-controller]', '.sub-request', '.port-request', '.order-details', 'body'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const scope = window.angular?.element(el)?.scope?.();
      if (!scope) continue;
      const sr = scope.subRequest || scope.portRequest || scope.order
        || scope.sr || scope.request || scope.vm?.subRequest
        || scope.vm?.portRequest || scope.ctrl?.subRequest;
      if (sr) {
        const focDate = sr.foc_date || sr.focDate || sr.foc_date_confirmed_at
          || sr.actual_foc_date || sr.firm_order_commit_date;
        const country = (sr.country_code || sr.country || sr.jurisdiction || '').toUpperCase().slice(0, 2);
        const srId = sr.sr_number || sr.reference || sr.sr_id;
        const comments = sr.comments || sr.carrier_comments || [];
        const comment = Array.isArray(comments)
          ? (comments.find(c => /hour|release|foc/i.test(c?.body || c))?.body || comments[0]?.body || '')
          : (typeof comments === 'string' ? comments : '');
        if (focDate || srId) return { srId, country: country || null, focDate: focDate || null, comment, source: 'angular' };
      }
    }
  } catch (e) {}
  return null;
}

function extractFromDOM() {
  // Angular scope first
  const angularData = extractFromAngularScope();
  if (angularData && angularData.focDate) return angularData;

  const rawText = document.body.innerText;
  const lines = rawText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
  const uuids = extractUUIDsFromURL();

  // SR ID from page heading
  var srId = extractSrIdFromPage();
  if (!srId) {
    const srMatch = rawText.match(/\b(sr_[a-z0-9]+)\b/i);
    srId = srMatch ? srMatch[1] : null;
  }

  // Country from input fields or page text
  var country = null;
  var inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
  var descPattern = /^([A-Z]{2})\s+(local|national|international|tollfree|toll.free|mobile)/i;
  for (var ii = 0; ii < inputs.length; ii++) {
    var val = (inputs[ii].value || '').trim();
    var inputMatch = val.match(descPattern);
    if (inputMatch) { country = inputMatch[1].toUpperCase(); break; }
  }
  if (!country) {
    for (var ci = 0; ci < lines.length; ci++) {
      var descMatch = lines[ci].match(descPattern);
      if (descMatch) { country = descMatch[1].toUpperCase(); break; }
    }
  }

  // Actual FOC date: try DOM structure first, then text scan
  var focDate = null;

  // Strategy 1: Find "Actual FOC" label and walk siblings for date
  var allLabels = document.querySelectorAll('label, th, td, .control-label, [class*="label"], [class*="field"]');
  for (var li = 0; li < allLabels.length; li++) {
    var label = allLabels[li];
    if (!/actual\s+foc/i.test(label.textContent)) continue;
    // Walk next siblings
    var sibling = label.nextElementSibling;
    for (var w = 0; w < 5 && sibling; w++) {
      var sibText = (sibling.value || sibling.textContent || '').trim();
      var dateMatch = sibText.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
      if (dateMatch) { focDate = parseCSTDate(dateMatch[1]); break; }
      sibling = sibling.nextElementSibling;
    }
    // Check parent's next sibling
    if (!focDate && label.parentElement) {
      var parentSib = label.parentElement.nextElementSibling;
      for (var pw = 0; pw < 3 && parentSib; pw++) {
        var pText = (parentSib.value || parentSib.textContent || '').trim();
        var pMatch = pText.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
        if (pMatch) { focDate = parseCSTDate(pMatch[1]); break; }
        parentSib = parentSib.nextElementSibling;
      }
    }
    if (focDate) break;
  }

  // Strategy 2: Check all input fields near "Actual FOC" parent context
  if (!focDate) {
    var allInputs = document.querySelectorAll('input, textarea');
    for (var ai = 0; ai < allInputs.length; ai++) {
      var iVal = (allInputs[ai].value || '').trim();
      var iMatch = iVal.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
      if (iMatch) {
        var parent = allInputs[ai].parentElement;
        for (var pi = 0; pi < 4 && parent; pi++) {
          if (/actual\s+foc/i.test(parent.textContent)) {
            focDate = parseCSTDate(iMatch[1]);
            break;
          }
          parent = parent.parentElement;
        }
        if (focDate) break;
      }
    }
  }

  // Strategy 3: Text line scan for "Actual FOC" label + date on same/next lines
  if (!focDate) {
    for (var fi = 0; fi < lines.length; fi++) {
      if (/actual\s+foc/i.test(lines[fi])) {
        for (var fj = fi; fj <= Math.min(fi + 3, lines.length - 1); fj++) {
          var dm = lines[fj].match(/CST:\s*(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i)
                 || lines[fj].match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/i);
          if (dm) { focDate = parseCSTDate(dm[1]); break; }
        }
        if (focDate) break;
      }
    }
  }

  // Comment: lines mentioning hours/release/carrier
  var comment = null;
  for (var comi = 0; comi < lines.length; comi++) {
    var ln = lines[comi];
    if (/\d+\s*hours?.*release|release.*\d+\s*hours?|carrier.{0,20}comment/i.test(ln) && ln.length < 300) {
      comment = ln;
      break;
    }
  }

  return { srId: srId, country: country, focDate: focDate, comment: comment, uuids: uuids };
}

// Fetch order data using UUIDs via internal API (same-origin cookies)
async function fetchOrderByUUIDs(portRequestId, subRequestId) {
  try {
    const url = `https://api-internal.telnyx.com/porting/v1/port_requests/${portRequestId}/sub_requests/${subRequestId}?include_phone_numbers=true`;
    const resp = await fetch(url, { credentials: 'include', mode: 'cors' });
    if (resp.ok) {
      const data = await resp.json();
      return { type: 'sub', data };
    }
  } catch (e) {}
  try {
    const url2 = `https://api-internal.telnyx.com/porting/v1/port_requests/${portRequestId}?include_phone_numbers=false`;
    const resp2 = await fetch(url2, { credentials: 'include', mode: 'cors' });
    if (resp2.ok) {
      const data2 = await resp2.json();
      return { type: 'port', data: data2 };
    }
  } catch (e) {}
  return null;
}

function normalizeAPIResponse(apiResult) {
  if (!apiResult) return null;
  const raw = apiResult.data;
  const d = raw?.data || raw;
  if (!d) return null;
  const attr = d.attributes || d;
  const focDate = attr.foc_date || attr.foc_date_confirmed_at
    || attr.actual_foc_date || attr.firm_order_commit_date
    || attr.requested_foc_date || attr.foc;
  const country = (attr.country_code || attr.country || attr.jurisdiction || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  const comments = attr.comments || attr.carrier_comments || attr.foc_comments || [];
  const allComments = Array.isArray(comments) ? comments : [comments];
  const focComment = allComments.find(c => {
    const text = (c?.body || c?.text || c || '').toLowerCase();
    return text.includes('hour') || text.includes('release') || text.includes('foc') || text.includes('carrier');
  });
  const comment = focComment
    ? (focComment?.body || focComment?.text || focComment)
    : (allComments[0]?.body || allComments[0]?.text || allComments[0] || '');
  const srId = attr.sr_number || attr.reference || attr.sr_id || d.id;
  return { srId, country: country || null, focDate: focDate || null, comment: comment || '' };
}

// Read order from the current page (API + DOM)
async function readOrderFromCurrentPage(requestedSrId) {
  const uuids = extractUUIDsFromURL();
  let result = null;

  // Try API first
  if (uuids) {
    try {
      const apiData = await fetchOrderByUUIDs(uuids.portRequestId, uuids.subRequestId);
      if (apiData) {
        result = normalizeAPIResponse(apiData);
      }
    } catch (e) {}
  }

  // Fill gaps from DOM
  const domData = extractFromDOM();
  if (result) {
    const apiSrId = result.srId;
    result = { ...result, ...domData };
    if (apiSrId) result.srId = apiSrId; // API srId is more accurate
  } else {
    result = domData;
  }

  // If popup specified an SR ID, use that
  if (requestedSrId && result) {
    result.srId = requestedSrId;
  }

  return result;
}

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_ORDER_FROM_PAGE') {
    (async () => {
      try {
        if (!window.location.href.includes('portingadmin.telnyx.com')) {
          sendResponse({ error: 'Not on PortingAdmin page' });
          return;
        }
        const result = await readOrderFromCurrentPage(msg.srId || null);
        if (!result) {
          sendResponse({ error: 'Could not read order data. Make sure you are on an order detail page.' });
          return;
        }
        sendResponse({ success: true, order: result });
      } catch (e) {
        sendResponse({ error: `Extraction failed: ${e.message}` });
      }
    })();
    return true;
  }

  // Navigate to an SR order in the current tab and read it
  // Used when background.js opens a tab to the search page
  if (msg.type === 'NAVIGATE_AND_READ') {
    (async () => {
      var srId = msg.srId;
      var ref = srId.replace(/^sr_/i, '');

      // Check if we're already on the detail page
      var uuids = extractUUIDsFromURL();
      if (uuids) {
        // Wait a moment for Angular to finish rendering
        await new Promise(r => setTimeout(r, 1500));
        var result = await readOrderFromCurrentPage(srId);
        if (result && result.focDate) {
          sendResponse({ success: true, order: result });
          return;
        }
      }

      // We're on a search/list page — find and click the matching result
      // Try multiple selector strategies to find a link to the order
      var clickTargets = document.querySelectorAll(
        'a[href*="' + ref + '"], ' +
        'a[href*="' + srId + '"], ' +
        'tr a, td a, tbody a, ' +
        '[class*="result"] a, [class*="row"] a'
      );

      var detailLink = null;
      for (var ci = 0; ci < clickTargets.length; ci++) {
        var text = (clickTargets[ci].textContent || '').toLowerCase();
        var href = clickTargets[ci].getAttribute('href') || '';
        if (text.includes(srId.toLowerCase()) || href.includes(ref)) {
          detailLink = clickTargets[ci];
          break;
        }
      }

      // If no specific match, try the first link in a table row
      if (!detailLink) {
        var firstLink = document.querySelector('tbody a, table a, .table a');
        if (firstLink) detailLink = firstLink;
      }

      if (detailLink) {
        detailLink.click();

        // Wait for the detail page to load (hash change + Angular render)
        var checkInterval = setInterval(async function() {
          var uuids2 = extractUUIDsFromURL();
          if (uuids2) {
            clearInterval(checkInterval);
            await new Promise(r => setTimeout(r, 1500));
            var detailResult = await readOrderFromCurrentPage(srId);
            sendResponse({ success: true, order: detailResult || { srId: srId } });
          }
        }, 500);

        setTimeout(function() {
          clearInterval(checkInterval);
          sendResponse({ error: 'Timed out waiting for order detail to load.' });
        }, 10000);
        return true;
      }

      sendResponse({ error: 'Could not find ' + srId + ' in search results. Make sure you are logged in to PortingAdmin.' });
    })();
    return true;
  }

  if (msg.type === 'GET_PAGE_SR') {
    const uuids = extractUUIDsFromURL();
    const srId = extractSrIdFromPage();
    sendResponse({ srId, uuids, url: window.location.href });
    return true;
  }
});

// Broadcast SR ID when page loads or navigates (for auto-fill in popup)
function broadcastSrId() {
  setTimeout(() => {
    const uuids = extractUUIDsFromURL();
    const srId = extractSrIdFromPage();
    if (uuids || srId) {
      chrome.runtime.sendMessage({
        type: 'SR_DETECTED',
        srId: srId,
        uuids,
        url: window.location.href
      });
    }
  }, 1000);
}

window.addEventListener('load', broadcastSrId);
window.addEventListener('hashchange', broadcastSrId);
