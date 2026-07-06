# SimpliX

[中文说明](README.zh-CN.md)

![SimpliX logo and wordmark](docs/images/hero.png)

**Read English on X/Twitter, with simpler English.**

SimpliX does not translate or localize the whole page out of English. It rewrites difficult English posts into **clearer, easier-to-read English**, so you can keep reading in English instead of leaving the English environment.

When you select a word, phrase, or sentence, the inline `译` button can also explain it using the surrounding post context (currently Chinese only; more explanation languages can be added later).

> Note: SimpliX currently uses your own DeepSeek API key as its model provider. Text that needs rewriting or explanation, plus necessary context, is sent directly from your browser to the DeepSeek API. API usage is charged to your own DeepSeek account. Other providers can be added later.

![Before and after using SimpliX](docs/images/before-after-musk.png)

![Before and after using SimpliX on a longer post](docs/images/before-after-long-post.png)

## Why not translate everything?

Many translation extensions localize English webpages directly into another language. That is convenient, but it can also pull you out of the English reading environment.

SimpliX is not meant to help you avoid English. It is meant to help you **keep reading English**:

- difficult sentences become clearer English;
- long posts become easier to understand;
- words, phrases, or sentences you do not understand can be explained through the `译` button (currently Chinese only);
- links, @mentions, #hashtags, emoji, and line breaks are preserved as much as possible.

**SimpliX is for English learners who do not want to rely completely on translation, but still want to lower the difficulty of reading English on X/Twitter.**

## Features

- Automatically processes English X/Twitter content as it appears on screen.
- Skips non-English-first posts and very short English posts.
- Rewrites English posts in place into easier English while preserving the original meaning, tone, and context as much as possible.
- Preserves links, @mentions, #hashtags, emoji, and line breaks.
- Supports X longform article text.
- Skips images, media, embedded posts, quoted posts, and code blocks.
- Shows an inline `译` button after selecting an English word, phrase, or sentence (selected-text explanations are currently Chinese only).
- Uses your own DeepSeek API key as the current model provider. No public key is bundled.
- Has no project-owned backend server. Requests are sent directly from your browser to the DeepSeek API.
- The Chrome extension includes an editable rewrite prompt panel for advanced customization.

## Repository layout

```text
SimpliX/
├─ chrome-extension/   # Chrome Manifest V3 extension
├─ userscript/         # Tampermonkey / Violentmonkey userscript
├─ docs/images/        # README images
├─ PRIVACY.md          # Privacy notes
├─ LICENSE             # MIT License
├─ README.md           # English README
└─ README.zh-CN.md     # Chinese README
```

The two builds can coexist:

- use the **Chrome extension** on desktop;
- use the **userscript** on mobile with Firefox + Violentmonkey if needed.

## How to use

If you do not want to read and understand the whole project structure manually, you can also give this repository to your preferred AI assistant and ask it to help you install or explain it.

For example:

- download the project or copy the GitHub link;
- tell your AI assistant: "This is a Chrome extension / userscript project. Help me install and run it step by step.";
- ask it to explain a file, change configuration, or help with further development.

The SimpliX project structure is intentionally simple and AI-friendly, so an AI assistant can usually read it and produce actionable installation steps.

### 1. Chrome extension

1. Download or clone this repository.
2. Open the Chrome extensions page:

```text
chrome://extensions/
```

3. Enable "Developer mode" in the top-right corner.
4. Click "Load unpacked".
5. Select the `chrome-extension/` folder in this project.
6. Open `x.com` or `twitter.com`.
7. Click the SimpliX icon in the browser toolbar and enter your DeepSeek API key (currently the supported provider).

After installation, a floating `易 / 关` button appears in the lower-left corner of the page, letting you quickly enable or disable SimpliX.

### 2. Userscript

1. Install Tampermonkey or Violentmonkey.
2. Create a new userscript.
3. Copy the contents of `userscript/simplix.user.js` and save it.
4. Open `x.com` or `twitter.com`.
5. Set your DeepSeek API key from the userscript manager menu (currently the supported provider).

For mobile use, the recommended setup is:

```text
Firefox + Violentmonkey
```

More userscript notes:

```text
userscript/README.md
```

## API key and cost

SimpliX currently calls the DeepSeek API, so you need your own DeepSeek API key. DeepSeek is the current supported provider; the codebase can support more providers in the future.

API usage is charged to your DeepSeek account. This project does not provide, bundle, or share any public API key.

Local API key storage:

- Chrome extension: stored in `chrome.storage.local`.
- Userscript: stored in the userscript manager's local value storage.

## Privacy

SimpliX has no project-owned backend server.

When you use rewriting or explanation features, the browser sends relevant X/Twitter text and necessary context directly to:

```text
https://api.deepseek.com/
```

That content is used to generate easier English rewrites or to explain the selected word, phrase, or sentence (currently Chinese only for selected-text explanations).

## Known limitations

- X/Twitter often changes its page structure, so SimpliX may occasionally fail to recognize or process some content.
- Very short English posts, non-English-first posts, code blocks, images, media, embedded content, and quoted posts are skipped.
- Rewrite results are generated by AI and may occasionally be inaccurate.
- For important, professional, or sensitive content, rely on the original text.
- If the DeepSeek API is unavailable, your balance is insufficient, or your API key is configured incorrectly, SimpliX cannot rewrite or explain text.
- Selected-text explanations are currently returned in Chinese only.

## License

MIT. See `LICENSE`.
