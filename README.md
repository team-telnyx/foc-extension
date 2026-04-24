# FOC Calendar Sync — Browser Extension

Creates Google Calendar events for APAC porting orders when FOC is set.

## Setup

### 1. Add Google OAuth Client ID
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → Enable **Google Calendar API**
3. Credentials → Create → **OAuth 2.0 Client ID** → Type: **Chrome Extension**
4. Add your extension ID (found after loading unpacked)
5. Copy the `client_id` → paste into `manifest.json` → replace `GOOGLE_OAUTH_CLIENT_ID_HERE`

### 2. Configure Telnyx API Key
After loading the extension, go to Settings and enter your Telnyx API key.

Or set it directly in Chrome DevTools console:
```js
chrome.storage.sync.set({ telnyxApiKey: 'YOUR_KEY_HERE' })
```

### 3. Load Extension in Chrome/Edge
1. Open `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked**
4. Select this folder: `/Users/phen/foc-extension`

## Usage
1. Navigate to any PortingAdmin order page — SR ID auto-detected ✅
2. Or click the extension icon and paste the SR ID manually
3. Click **Fetch Order Details**
4. Review the preview (title, FOC date, duration from comment)
5. Click **Create Calendar Event** ✅

## Event Format
- **Title:** `AU ACT: sr_abc123xyz`
- **Date/Time:** FOC date from order
- **Duration:** Parsed from comment (e.g., "3 hours to release" → 3h event; default 1h)
- **Reminders:** 30min + 10min popup

## Files
```
foc-extension/
├── manifest.json        # Extension config
├── popup.html           # Extension popup UI
├── icons/               # Extension icons
└── src/
    ├── popup.js         # Popup logic
    ├── content.js       # Auto-detect SR ID from PortingAdmin page
    └── background.js    # API calls (Telnyx + Google Calendar)
```
