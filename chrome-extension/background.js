const API_URL = 'https://api.deepseek.com/chat/completions';
const API_MODEL = 'deepseek-chat';
const DEFAULT_SETTINGS = {
    apiKey: '',
    enabled: true,
    rewritePrompt: '',   // 自定义改写提示词；'' = 用 prompts.js 里的默认
};

chrome.runtime.onInstalled.addListener(async () => {
    const current = await storageGet(DEFAULT_SETTINGS);
    await storageSet({ enabled: current.enabled !== false });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type || !message.type.startsWith('simplix.')) return false;

    handleMessage(message, sender)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({
            ok: false,
            error: error && error.message ? error.message : String(error),
        }));

    return true;
});

async function handleMessage(message) {
    if (message.type === 'simplix.getSettings') {
        return { ok: true, settings: await getSettings() };
    }

    if (message.type === 'simplix.setSettings') {
        const settings = await setSettings(message.settings || {});
        return { ok: true, settings };
    }

    if (message.type === 'simplix.rewrite') {
        const raw = await postDeepSeek({
            temperature: 1.0,
            messages: [
                { role: 'system', content: String(message.systemPrompt || '') },
                { role: 'user', content: String(message.userContent || '') },
            ],
        });
        return { ok: true, rewritten: parseRewritten(raw) };
    }

    if (message.type === 'simplix.translateSelection') {
        const raw = await postDeepSeek({
            temperature: 0.3,
            messages: [
                { role: 'system', content: String(message.systemPrompt || '') },
                {
                    role: 'user',
                    content: 'CONTEXT (the whole post):\n"""' + (message.context || '(none)') +
                        '"""\n\nSELECTED:\n"""' + (message.text || '') + '"""',
                },
            ],
        });
        const parsed = parseSelection(raw);
        return {
            ok: true,
            meaning: parsed.meaning,
            phonetic: parsed.phonetic,
        };
    }

    return { ok: false, error: 'unknown_message' };
}

async function getSettings() {
    const data = await storageGet(DEFAULT_SETTINGS);
    return {
        apiKey: data.apiKey || '',
        enabled: data.enabled !== false,
        rewritePrompt: data.rewritePrompt || '',
    };
}

async function setSettings(input) {
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
        patch.apiKey = String(input.apiKey || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(input, 'enabled')) {
        patch.enabled = input.enabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'rewritePrompt')) {
        patch.rewritePrompt = String(input.rewritePrompt || '').trim();
    }
    if (Object.keys(patch).length) await storageSet(patch);
    return getSettings();
}

async function postDeepSeek({ messages, temperature }) {
    const { apiKey } = await getSettings();
    if (!apiKey) throw new Error('missing_api_key');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify({
                model: API_MODEL,
                temperature,
                stream: false,
                response_format: { type: 'json_object' },
                messages,
            }),
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error('http_' + response.status + ': ' + text.slice(0, 200));
        }
        return text;
    } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('timeout');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function parseRewritten(raw) {
    const content = messageContent(raw);
    if (!content) return null;
    const obj = parseEmbeddedJson(content);
    const rewritten = obj && obj.rewritten;
    return (typeof rewritten === 'string' && rewritten.trim()) ? rewritten.trim() : null;
}

function parseSelection(raw) {
    const content = messageContent(raw);
    const obj = content ? parseEmbeddedJson(content) : null;
    return {
        meaning: obj && obj.meaning ? String(obj.meaning).trim() : null,
        phonetic: obj && obj.phonetic ? String(obj.phonetic).trim() : '',
    };
}

function messageContent(raw) {
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    return data && data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
}

function parseEmbeddedJson(content) {
    const match = String(content || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (e) { return null; }
}

function storageGet(defaults) {
    return chrome.storage.local.get(defaults);
}

function storageSet(values) {
    return chrome.storage.local.set(values);
}
