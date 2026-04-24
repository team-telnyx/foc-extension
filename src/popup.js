// Popup logic
let orderData = null;
let backgroundTabId = null;

const srInput = document.getElementById('srInput');
const fetchBtn = document.getElementById('fetchBtn');
const createBtn = document.getElementById('createBtn');
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const detectedBadge = document.getElementById('detectedBadge');

// ─── On load: check if any PortingAdmin tab is open ─────────────────────────
chrome.tabs.query({ url: 'https://portingadmin.telnyx.com/*' }, (tabs) => {
  if (tabs && tabs.length > 0) {
    detectedBadge.style.display = 'inline';
    detectedBadge.textContent = 'PortingAdmin open ✓';
  }
});

chrome.storage.session.get('detectedSrId', (data) => {
  if (data && data.detectedSrId) {
    srInput.value = data.detectedSrId;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
  statusEl.className = 'status visible ' + type;
  statusEl.innerHTML = (type === 'loading')
    ? '<span class="spinner"></span>' + msg
    : msg;
}

function hideStatus() {
  statusEl.className = 'status';
}

function formatDateTime(isoString) {
  if (!isoString) return 'Not found';
  var floating = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (floating) {
    var yr = floating[1], mo = floating[2], dy = floating[3];
    var hr = parseInt(floating[4]), mn = floating[5];
    var ampm = hr >= 12 ? 'PM' : 'AM';
    var h12 = hr % 12 || 12;
    var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var d = new Date(yr, parseInt(mo)-1, parseInt(dy));
    return days[d.getDay()] + ', ' + months[parseInt(mo)-1] + ' ' + parseInt(dy) + ', ' + yr +
           ', ' + h12 + ':' + mn + ' ' + ampm + ' CT';
  }
  var d2 = new Date(isoString);
  if (isNaN(d2)) return 'Invalid date';
  return d2.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
    hour12: true, timeZoneName: 'short'
  });
}

function parseDuration(comment) {
  if (!comment) return 1;
  const match = comment.match(/(\d+)\s*(hour|hr|minute|min)/i);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('min')) return Math.max(num / 60, 0.5);
    return num;
  }
  return 1;
}

// ─── Fetch button: look up SR order ───────────────────────────────────────────
fetchBtn.addEventListener('click', async () => {
  fetchBtn.disabled = true;
  createBtn.style.display = 'none';
  previewEl.classList.remove('visible');
  orderData = null;

  const srId = srInput.value.trim();
  if (!srId) {
    fetchBtn.disabled = false;
    showStatus('❌ Enter an SR Order ID above.', 'error');
    return;
  }

  showStatus('Looking up ' + srId + '...', 'loading');

  // Tell background to look up the order
  const response = await chrome.runtime.sendMessage({ type: 'LOOKUP_AND_READ', srId: srId });

  fetchBtn.disabled = false;

  if (!response || response.error) {
    var debugMsg = '';
    if (response && response.debug) {
      debugMsg = '<br><small style="color:#999">' + response.debug.join(' → ') + '</small>';
    }
    showStatus('❌ ' + (response ? response.error : 'Lookup failed') + debugMsg, 'error');
    return;
  }

  const order = response.order;
  // Track background tab for cleanup later
  if (response.tabId) backgroundTabId = response.tabId;
  if (!order || !order.focDate || isNaN(new Date(order.focDate))) {
    showStatus('❌ No FOC date found on ' + srId + '. FOC must be confirmed first.', 'error');
    return;
  }

  // Show preview
  orderData = order;
  const hrs = parseDuration(order.comment);
  const countryLabel = order.country || '??';

  document.getElementById('previewTitle').textContent = countryLabel + ' ACT: ' + order.srId;
  document.getElementById('previewDate').textContent = formatDateTime(order.focDate);
  document.getElementById('previewDuration').textContent =
    hrs === 1 ? '1 hour (default)' :
    hrs < 1   ? (hrs * 60) + ' minutes' :
                hrs + ' hours';
  
  // Show order status badge
  var statusEl = document.getElementById('previewStatus');
  var orderStatus = (order.status || 'unknown').toLowerCase().replace(/\s+/g, '-');
  var statusLabel = order.status || 'Unknown';
  statusEl.innerHTML = '<span class="status-badge ' + orderStatus + '">' + statusLabel + '</span>';
  previewEl.classList.add('visible');
  // Show debug info on success too
  var debugHtml = '';
  if (response.debug) {
    debugHtml = '<br><small style="color:#999">' + response.debug.join(' → ') + '</small>';
  }
  if (order._debugLog) {
    debugHtml += '<br><small style="color:#999">' + order._debugLog.join(' → ') + '</small>';
  }
  if (debugHtml) {
    var debugEl = document.getElementById('debugInfo');
    if (debugEl) debugEl.innerHTML = debugHtml;
  }
  hideStatus();
  createBtn.style.display = 'block';
});

// ─── Enter key on SR input triggers fetch ────────────────────────────────────
srInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchBtn.click();
});

// ─── Create button: create calendar event then close ─────────────────────────
createBtn.addEventListener('click', async () => {
  if (!orderData) return;

  createBtn.disabled = true;
  showStatus('Creating calendar event...', 'loading');

  const durationHours = parseDuration(orderData.comment);
  const createResponse = await chrome.runtime.sendMessage({
    type: 'CREATE_EVENT',
    eventData: Object.assign({}, orderData, { durationHours: durationHours })
  });

  if (!createResponse || createResponse.error) {
    createBtn.disabled = false;
    showStatus('❌ ' + (createResponse ? createResponse.error : 'No response'), 'error');
    return;
  }

  // Close the background tab silently
  if (backgroundTabId) {
    chrome.tabs.remove(backgroundTabId).catch(() => {});
    backgroundTabId = null;
  }

  showStatus('✅ Event created! <a href="' + createResponse.eventLink + '" target="_blank" style="color:#68d391">Open in Calendar →</a>', 'success');
  // Auto-close disabled for debugging
  // setTimeout(() => window.close(), 800);
});

// ─── Settings ────────────────────────────────────────────────────────────────
document.getElementById('settingsLink').addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    alert('Settings coming soon');
  }
});
