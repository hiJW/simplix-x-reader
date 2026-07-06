const DEFAULT_SETTINGS = {
    apiKey: '',
    enabled: true,
    rewritePrompt: '',   // '' = 用 prompts.js 里的默认改写提示词
};

const enabledEl = document.getElementById('enabled');
const apiKeyEl = document.getElementById('apiKey');
const saveEl = document.getElementById('save');
const clearEl = document.getElementById('clear');
const statusEl = document.getElementById('status');
const rewritePromptEl = document.getElementById('rewritePrompt');
const rewritePromptStateEl = document.getElementById('rewritePromptState');
const savePromptsEl = document.getElementById('savePrompts');
const resetPromptsEl = document.getElementById('resetPrompts');

init();

async function init() {
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    enabledEl.checked = settings.enabled !== false;
    apiKeyEl.value = settings.apiKey || '';

    // 文本框始终显示「当前生效」的提示词：自定义值，否则默认值
    rewritePromptEl.value = settings.rewritePrompt || SIMPLIX_PROMPTS.REWRITE_DEFAULT;
    updatePromptState();

    saveEl.addEventListener('click', save);
    clearEl.addEventListener('click', clearKey);
    enabledEl.addEventListener('change', save);
    savePromptsEl.addEventListener('click', savePrompts);
    resetPromptsEl.addEventListener('click', resetPrompts);
    rewritePromptEl.addEventListener('input', updatePromptState);
}

async function save() {
    const settings = {
        apiKey: apiKeyEl.value.trim(),
        enabled: enabledEl.checked,
    };
    await chrome.storage.local.set(settings);
    await notifyActiveTab({ type: 'simplix.settingsChanged', settings });
    setStatus(settings.apiKey ? '已保存。当前 X 页面会即时同步。' : '已保存；尚未设置 API Key。');
}

async function clearKey() {
    apiKeyEl.value = '';
    await save();
}

// 与默认相同（或清空）就存 ''：这样以后升级默认提示词，用户能自动跟上
function normalizePrompt(value, defaultValue) {
    const v = String(value || '').trim();
    return (v === '' || v === defaultValue.trim()) ? '' : v;
}

async function savePrompts() {
    const settings = {
        rewritePrompt: normalizePrompt(rewritePromptEl.value, SIMPLIX_PROMPTS.REWRITE_DEFAULT),
    };
    await chrome.storage.local.set(settings);
    if (!rewritePromptEl.value.trim()) rewritePromptEl.value = SIMPLIX_PROMPTS.REWRITE_DEFAULT;
    updatePromptState();
    const notified = await notifyActiveTab({ type: 'simplix.settingsChanged', settings });
    setStatus(notified
        ? '提示词已保存。当前 X 页面会用新提示词重新改写。'
        : '提示词已保存。刷新 X 页面后生效。');
}

async function resetPrompts() {
    rewritePromptEl.value = SIMPLIX_PROMPTS.REWRITE_DEFAULT;
    await savePrompts();
    setStatus('已恢复默认提示词。');
}

function updatePromptState() {
    rewritePromptStateEl.textContent =
        normalizePrompt(rewritePromptEl.value, SIMPLIX_PROMPTS.REWRITE_DEFAULT) ? '（自定义）' : '（默认）';
}

async function notifyActiveTab(message) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return false;
    try {
        await chrome.tabs.sendMessage(tab.id, message);
        return true;
    } catch (e) {
        return false;
    }
}

function setStatus(text) {
    statusEl.textContent = text;
}
