# Privacy

SimpliX is a local browser tool for X/Twitter reading assistance.

## Data Sent to DeepSeek

When SimpliX rewrites a post or explains selected text, it sends the relevant X/Twitter text and nearby context to the DeepSeek API. This is required for the rewriting and translation features.

## API Key Storage

- Chrome extension: the DeepSeek API key is stored in `chrome.storage.local`.
- Userscript: the DeepSeek API key is stored through the userscript manager's value storage.

The repository does not contain any API key.

## Project Server

SimpliX does not use a project-owned backend server. Network requests go directly from the browser runtime to `https://api.deepseek.com/`.

## Permissions

The Chrome extension requests access to:

- `x.com`, `twitter.com`, and `mobile.twitter.com` for page rewriting.
- `api.deepseek.com` for API requests.
- `storage` for local settings.
- `activeTab` to notify the current tab when popup settings change.

## User Control

Users can disable SimpliX from the popup or from the in-page floating button. Disabling restores rewritten page content where SimpliX has saved the original HTML.
