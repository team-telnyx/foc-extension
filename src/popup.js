// Popup logic
// Manages UI, settings (API key), and message passing to background script

let orderData = null;

const srInput = document.getElementById('srInput');
const fetchBtn = document.getElementById('fetchBtn');
const createBtn = document.getElementById('createBtn');
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const detectedBadge = document.getElementById('detectedBadge');
const versionBadge = document.getElementById('versionBadge');

// Display version from manifest
if (versionBadge && chrome.runtime.getManifest) {
  versionBadge.textContent = 'v' + chrome.runtime.getManifest().version;
}

// ─── Settings panel toggle ──────────────────────────────────────────────────
const settingsLink = document.getElementById('settingsLink');
const settingsPanel = document.getElementById('settingsPanel');
const apiKeyInput = document.getElementById('apiKeyInput');
const emailInput = document.getElementById('emailInput');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const signInBtn = document.getElementById('signInBtn');
const dateFmtLink = document.getElementById('dateFmtLink');
const dateFmtLabel = document.getElementById('dateFmtLabel');
let dateFmt = 'DD/MM'; // default

// ─── Date format toggle ─────────────────────────────────────────────────────
if (dateFmtLink) {
  dateFmtLink.addEventListener('click', () => {
    if (dateFmt === 'DD/MM') {
      dateFmt = 'MM/DD';
    } else {
      dateFmt = 'DD/MM';
    }
    if (dateFmtLabel) dateFmtLabel.textContent = dateFmt;
    chrome.storage.sync.set({ dateFormat: dateFmt });
  });
}

if (settingsLink) {
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (settingsPanel) {
      settingsPanel.classList.toggle('visible');
      // Load current settings when panel opens
      if (settingsPanel.classList.contains('visible')) {
        chrome.storage.sync.get(['telnyxApiKey', 'userEmail', 'dateFormat'], (data) => {
          if (data && data.telnyxApiKey && apiKeyInput) {
            apiKeyInput.value = data.telnyxApiKey;
          }
          if (data && data.userEmail && emailInput) {
            emailInput.value = data.userEmail;
            // Show signed-in state if email is already saved
            if (signInBtn) {
              signInBtn.textContent = '✓ Signed in as ' + data.userEmail;
              signInBtn.classList.remove('btn-primary');
              signInBtn.classList.add('btn-success');
            }
          }
          if (data && data.dateFormat) {
            dateFmt = data.dateFormat;
            if (dateFmtLabel) dateFmtLabel.textContent = dateFmt;
          }
        });
      }
    }
  });
}

if (saveSettingsBtn) {
  saveSettingsBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    const email = emailInput.value.trim();
    if (!key) {
      showStatus('❌ Enter an API key first.', 'error');
      return;
    }
    if (!email) {
      showStatus('❌ Enter your Google email first.', 'error');
      return;
    }

    saveSettingsBtn.disabled = true;
    saveSettingsBtn.textContent = 'Signing in...';

    // Save API key and email locally
    chrome.storage.sync.set({ telnyxApiKey: key, userEmail: email });

    // Trigger Google sign-in
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SIGN_IN' });
      if (response && response.success) {
        // If Google returned a different email, use that instead
        if (response.email && emailInput) {
          emailInput.value = response.email;
          chrome.storage.sync.set({ userEmail: response.email });
        }
        saveSettingsBtn.textContent = '✓ Saved & Signed in';
        saveSettingsBtn.classList.remove('btn-primary');
        saveSettingsBtn.classList.add('btn-success');
      } else {
        saveSettingsBtn.textContent = '❌ ' + (response && response.error ? response.error : 'Sign-in failed');
      }
    } catch (e) {
      saveSettingsBtn.textContent = '❌ Sign-in failed';
    }

    saveSettingsBtn.disabled = false;
    setTimeout(() => {
      saveSettingsBtn.textContent = 'Save Settings';
      saveSettingsBtn.classList.add('btn-primary');
      saveSettingsBtn.classList.remove('btn-success');
    }, 3000);
  });
}

// ─── Auto-fill SR ID from content script detection ──────────────────────────
chrome.storage.session.get('detectedSrId', (data) => {
  if (data && data.detectedSrId) {
    srInput.value = data.detectedSrId;
  }
});

// ─── Auto-load saved email on popup open ──────────────────────────────────────
chrome.storage.sync.get(['userEmail', 'dateFormat'], (data) => {
  if (data && data.userEmail && emailInput) {
    emailInput.value = data.userEmail;
  }
  if (data && data.dateFormat) {
    dateFmt = data.dateFormat;
    if (dateFmtLabel) dateFmtLabel.textContent = dateFmt;
  }
});

// ─── Auto-detect email from current Google session ──────────────────────────────
// If the user is already signed in to Google, fetch their email and fill the field.
// This keeps the email populated every time the extension opens.
chrome.runtime.sendMessage({ type: 'GET_CURRENT_USER' }, (response) => {
  if (response && response.success && response.email && emailInput) {
    emailInput.value = response.email;
    // Save to storage so it persists
    chrome.storage.sync.set({ userEmail: response.email });
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

  // Get date format preference
  const { dateFormat } = await chrome.storage.sync.get('dateFormat');

  // Tell background to look up the order via API
  const response = await chrome.runtime.sendMessage({ type: 'LOOKUP_AND_READ', srId: srId, dateFormat: dateFormat || 'DD/MM' });

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

  // Show D&T → CST comparison if available
  var ltRow = document.getElementById('previewLtRow');
  var ltEl = document.getElementById('previewLt');
  if (order.ltComparison && order.ltComparison.ltLabel) {
    var cmp = order.ltComparison;
    var bgColor, borderColor, textColor, icon, text;
    if (cmp.match === true) {
      // Full match: date + time both match → GREEN
      icon = '✅'; bgColor = 'rgba(104,211,145,0.15)'; borderColor = '#68d391'; textColor = '#68d391';
      text = icon + ' ' + cmp.ltLabel + ' = ' + cmp.cstLabel;
    } else if (cmp.match === false) {
      if (cmp.dateMatch === false) {
        // Date mismatch — but does time match?
        if (cmp.timeDiffMin !== undefined && cmp.timeDiffMin <= 2) {
          // Date wrong, time right → YELLOW (partial match)
          icon = '⚠️'; bgColor = 'rgba(237,183,61,0.15)'; borderColor = '#edb73d'; textColor = '#edb73d';
          text = icon + ' ' + cmp.ltLabel + ' → ' + cmp.cstLabel + ' (date mismatch)';
        } else {
          // Both date and time wrong → RED
          icon = '❌'; bgColor = 'rgba(252,92,101,0.15)'; borderColor = '#fc5c65'; textColor = '#fc5c65';
          text = icon + ' ' + cmp.ltLabel + ' → ' + cmp.cstLabel + ' (date & time mismatch)';
        }
      } else {
        // Date matches but time differs → YELLOW (partial match)
        icon = '⚠️'; bgColor = 'rgba(237,183,61,0.15)'; borderColor = '#edb73d'; textColor = '#edb73d';
        text = icon + ' ' + cmp.ltLabel + ' ≠ ' + cmp.cstLabel + ' (time off by ' + cmp.timeDiffMin + ' min)';
      }
    } else {
      icon = '❓'; bgColor = 'transparent'; borderColor = 'transparent'; textColor = '#a0aec0';
      text = icon + ' ' + (cmp.error || 'Unknown');
    }
    ltEl.innerHTML = '<span style="color:' + textColor + ';background:' + bgColor + ';border-left:3px solid ' + borderColor + ';padding:4px 8px;border-radius:4px;display:inline-block">' + text + '</span>';
    ltRow.style.display = 'flex';
  } else {
    ltRow.style.display = 'none';
  }

  previewEl.classList.add('visible');
  // Show debug info on success too
  var debugHtml = '';
  if (response.debug) {
    debugHtml = '<br><small style="color:#999">' + response.debug.join(' → ') + '</small>';
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

// ─── Create button: create calendar event ────────────────────────────────────
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

  showStatus('✅ Event created! <a href="' + createResponse.eventLink + '" target="_blank" style="color:#68d391">Open in Calendar →</a>', 'success');
});

// ─── Logs toggle ─────────────────────────────────────────────────────────────
document.getElementById('logsLink').addEventListener('click', (e) => {
  e.preventDefault();
  var debugEl = document.getElementById('debugInfo');
  if (debugEl) {
    debugEl.style.display = debugEl.style.display === 'none' ? 'block' : 'none';
  }
});
