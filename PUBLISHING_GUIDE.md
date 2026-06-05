# FOC Calendar Sync — Chrome Web Store Publishing Guide

## What This Extension Does
Looks up Telnyx porting order SR IDs in PortingAdmin, reads the FOC date, country, and duration from comments, and creates a Google Calendar event. Built for the PortingOps team.

## Package Ready to Upload
- **Zip file:** `foc-extension-release.zip` (687KB)
- **Version:** 1.0.35
- **Manifest V3** (current standard)

## Step-by-Step: Publish to Chrome Web Store

### 1. Go to the Developer Dashboard
- https://chrome.google.com/webstore/devconsole
- Log in with the Telnyx developer account

### 2. Click "New Item" → Upload the ZIP
- Upload `foc-extension-release.zip`

### 3. Fill in Store Listing

**Basic Info:**
| Field | Value |
|-------|-------|
| Name | FOC Calendar Sync |
| Short description | Create Google Calendar events for Telnyx porting FOC dates |
| Detailed description | See below |

**Detailed description (copy/paste):**
```
FOC Calendar Sync helps Telnyx PortingOps team members track FOC (Firm Order Confirmation) dates by automatically creating Google Calendar events.

How it works:
1. Enter an SR order ID (e.g., sr_abc123) or navigate to a PortingAdmin order page
2. The extension looks up the order details in PortingAdmin
3. Reads the FOC date, country code, and estimated duration from order comments
4. Creates a Google Calendar event with the format: [COUNTRY] ACT: [sr_id]

Features:
• Auto-detects SR IDs on PortingAdmin pages
• Parses FOC date and activation duration from scheduling comments
• Creates calendar events with 30min and 10min reminders
• Handles timezone conversion (UTC → local)
• Supports rescheduled FOC dates

This extension requires access to PortingAdmin (portingadmin.telnyx.com) and a Google account for Calendar integration.
```

**Category:** Productivity

**Language:** English

### 4. Upload Images

| Image | File | Size |
|-------|------|------|
| Icon (128x128) | `icons/icon128.png` | 128×128 |
| Small promo tile | `promo/promo_small.png` | 440×280 |
| Marquee promo | `promo/promo_marquee.png` | 1400×560 |

### 5. Privacy & Permissions

**Privacy Practices (required by Google):**
- ✅ User data is not sold
- ✅ User data is not used for purposes unrelated to the extension's core functionality
- ✅ User data is not transferred or disclosed unless required for the extension's core functionality
- ✅ User data is not used to determine creditworthiness or for lending purposes

**Justification for permissions:**
| Permission | Reason |
|-----------|--------|
| `identity` | Google OAuth sign-in to create calendar events |
| `storage` | Store user preferences (API key, settings) |
| `activeTab` | Detect SR IDs on the current PortingAdmin tab |
| `tabs` | Open/search PortingAdmin in background tabs |
| `cookies` | Authenticate with PortingAdmin session |
| `scripting` | Read FOC data from PortingAdmin page DOM |
| `host_permissions: portingadmin.telnyx.com` | Core functionality — reads order data |
| `host_permissions: api.telnyx.com` | API calls to look up orders |
| `host_permissions: api-internal.telnyx.com` | Internal API fallback |
| `host_permissions: googleapis.com` | Google Calendar API for event creation |

### 6. OAuth Consent Screen

⚠️ **Important:** The Google Cloud project `foc-event-creator` (ID: `745476448516`) has an OAuth consent screen in "Testing" mode. 

**For teammates to use the extension, you must either:**

**Option A — Add teammates as test users (quick):**
- Go to Google Cloud Console → `foc-event-creator` → OAuth consent screen
- Add each teammate's email as a test user
- Up to 100 users in testing mode

**Option B — Publish the consent screen (proper):**
- Submit for Google verification (the `calendar.events` scope is "sensitive")
- Requires: privacy policy URL, verified domain, ~1 week review
- No user limit after approval

### 7. Visibility

- **Unlisted** (recommended) — Only people with the link can install
- Or **Public** — Searchable in the Chrome Web Store

For an internal tool, Unlisted is fine.

### 8. Submit for Review

- Click "Submit for review"
- First submission: 1-3 business days
- Updates: usually faster (hours to 1 day)

## Future Updates

When a new version is ready:
1. Bump `version` in `manifest.json`
2. Re-zip: `zip -r foc-extension-release.zip manifest.json popup.html icons/ src/`
3. Upload the new ZIP in the Developer Dashboard
4. Submit for review
5. Teammates auto-update once approved ✅

## Contact
Built by the PortingOps team. Questions → #portingops-bots on Slack.
