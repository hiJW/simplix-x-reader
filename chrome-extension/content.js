// SimpliX Chrome Extension content script.
// The original Tampermonkey/Violentmonkey script remains at ../userscript/simplix.user.js.

/* ============================================================================
 * SimpliX（Chrome Extension）
 *
 *  - 触发：进入视口自动改写（不靠点击），整条推文为单位。
 *  - 替换：原地替换原文，但用「占位符保护」把链接/@/#/emoji 原节点保下来 → 仍可点。
 *  - 过滤：只动「英文为主且够长」的推文；中文为主 / ≤3 词 一律跳过。
 *  - 网络：交给 background service worker 调 DeepSeek，绕过 x.com 的 CORS。
 *  - 成本：只处理视口附近 + 按推文文本缓存，滚走再回不重复花钱。
 * ========================================================================== */

(async function () {
    'use strict';

    /* ---------------- 配置 ---------------- */
    const LATIN_RATIO = 0.8;   // 字母里拉丁占比 ≥ 此值才算「英文为主」，否则按中文为主跳过
    const MIN_WORDS = 4;       // 少于 4 个英文词（即 ≤3）直接忽略
    const MAX_CONCURRENCY = 3; // 同时在飞的接口请求上限
    const PRELOAD_MARGIN = '400px 0px'; // 视口外提前这么多就开始处理
    const MAX_RETRY = 3;      // 单条推文改写失败后的重试次数（退避 1.5/3/4.5 秒）
    const LONG_CHARS = 1500;  // 正文超过这么多字符就「分段改写」（每段单独请求 + 带全文上下文 + 局部失败只丢该段）
    // 处理对象：推文正文 + X 长文章(longform)的每个段落块。X 文章用 Draft.js 渲染，段落＝[data-block]。
    // 文章里的 SECTION[data-block] 常是图片、markdown-code-block、嵌入帖等 atomic block，必须跳过。
    const ARTICLE_HOST_SELECTOR = '[data-testid="longformRichTextComponent"]';
    const ARTICLE_BLOCK_SELECTOR = ARTICLE_HOST_SELECTOR + ' [data-block]';
    const SEGMENT_SELECTOR = '[data-testid="tweetText"],' + ARTICLE_BLOCK_SELECTOR;
    const ART_CHUNK_CHARS = 1200; // X 文章：相邻 [data-block] 凑到约这么多字符为一组，一次请求翻译
    const ARTICLE_EMBED_SELECTOR = [
        'article',
        'blockquote',
        'figure',
        'iframe',
        'pre',
        'code',
        'kbd',
        'samp',
        'video',
        '[role="code"]',
        '[data-testid="tweet"]',
        '[data-testid="tweetText"]',
        '[data-testid="tweetPhoto"]',
        '[data-testid="videoComponent"]',
        '[data-testid="developerBuiltCardContainer"]',
        '[data-testid*="card."]',
        '[data-testid*="markdown-code-block"]',
        '[data-testid*="code-block"]',
        '[data-testid*="embed"]',
    ].join(',');

    // 提示词全部集中在 prompts.js（manifest 里先于本文件注入）。
    // 换行：已验证 X 用 white-space:pre-wrap + 文本里的 \n（不是 <br>）。tokenize 把 <br> 和 pre-wrap 的 \n
    //   都转成 [[n]] 占位符（背后是 <br> 节点），与链接/@/#/emoji 同等保护，AI 不能合并/删除 → 换行结构稳定。
    //   残余失败：AI 偶尔把占位符合并/丢失/挪越界 → validateTokens 不过 → 退避重试（temp=1.0，重试可能换来正确结果），
    //   仍失败则 giveup（浅红竖线、保留原文）。
    // rewritePrompt 是用户在 popup 里自定义的改写提示词，空 = 用 REWRITE_DEFAULT；
    // TOKEN_RULES / FORMAT_RULES 是技术规则，始终按需自动追加，不受自定义影响。
    // 划词翻译提示词(SELECTION_DEFAULT)固定用默认，不在 popup 里开放编辑。
    function systemPromptFor(tokenized) {
        let p = rewritePrompt || SIMPLIX_PROMPTS.REWRITE_DEFAULT;
        if (/\[\[\d+\]\]/.test(tokenized)) p += SIMPLIX_PROMPTS.TOKEN_RULES;
        if (/<[bi]>/.test(tokenized)) p += SIMPLIX_PROMPTS.FORMAT_RULES;
        return p;
    }

    /* ---------------- 状态 ---------------- */
    let apiKey = '';
    let enabled = true;
    let rewritePrompt = '';   // 自定义改写提示词（'' = 用 SIMPLIX_PROMPTS.REWRITE_DEFAULT）
    let fab = null;
    let toastEl = null;
    let toastTimer = null;
    const toastedOnce = new Set();

    const SEEN = new WeakSet();        // 已挂上观察的 tweetText，避免重复 observe
    const cache = new Map();           // tokenized文本 -> 改写结果(含占位符)
    const inflight = new Map();        // tokenized文本 -> Promise（同文去重）
    const queue = [];                  // 待处理的 tweetText 元素
    let active = 0;                    // 在飞请求数
    const originals = new WeakMap();   // tweetText -> 原始 innerHTML（关闭 SimpliX 时还原）
    let lastSel = null;                // 最近一次选区 {text, context}
    let selBtn = null, selPop = null, selTimer = 0;

    function sendToBackground(message) {
        return new Promise((resolve, reject) => {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
                reject(new Error('extension_unavailable'));
                return;
            }
            chrome.runtime.sendMessage(message, (response) => {
                const err = chrome.runtime.lastError;
                if (err) reject(new Error(err.message || 'extension_message_failed'));
                else resolve(response);
            });
        });
    }

    async function extensionGetSettings() {
        try {
            const res = await sendToBackground({ type: 'simplix.getSettings' });
            return (res && res.ok && res.settings) ? res.settings : {};
        } catch (e) {
            return {};
        }
    }

    function extensionSetSettings(settings) {
        sendToBackground({ type: 'simplix.setSettings', settings }).catch(() => {});
    }

    function bindExtensionMessages() {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
        chrome.runtime.onMessage.addListener((message) => {
            if (!message || !message.type) return false;
            if (message.type === 'simplix.settingsChanged') {
                applySettings(message.settings || {}, { persist: false });
                return false;
            }
            if (message.type === 'simplix.toggle') {
                toggle();
                return false;
            }
            if (message.type === 'simplix.setKey') {
                setKey();
                return false;
            }
            return false;
        });
    }

    function applySettings(settings, opts) {
        if (Object.prototype.hasOwnProperty.call(settings, 'apiKey')) {
            const nextApiKey = settings.apiKey || '';
            const changed = nextApiKey !== apiKey;
            apiKey = nextApiKey;
            if (apiKey && changed) rescanAll();
        }
        // 改写提示词变了 → 清缓存 + 还原已改写内容 + 重跑，让用户立刻看到新提示词的效果
        if (Object.prototype.hasOwnProperty.call(settings, 'rewritePrompt') &&
            (settings.rewritePrompt || '') !== rewritePrompt) {
            rewritePrompt = settings.rewritePrompt || '';
            cache.clear();
            if (enabled) {
                revertAll();
                rescanAll();
                toast('SimpliX：提示词已更新，正在重新改写');
            }
        }
        if (Object.prototype.hasOwnProperty.call(settings, 'enabled') && settings.enabled !== enabled) {
            setEnabled(settings.enabled !== false, opts);
        } else {
            updateFab();
        }
    }

    /* ---------------- 初始化 ---------------- */
    const settings = await extensionGetSettings();
    apiKey = settings.apiKey || '';
    enabled = settings.enabled !== false;
    rewritePrompt = settings.rewritePrompt || '';
    bindExtensionMessages();

    injectStyle();
    createFab();

    const io = new IntersectionObserver(onIntersect, { rootMargin: PRELOAD_MARGIN });
    const mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    scan(document);

    // 选中文字 → 冒出「译」按钮（基于上下文翻译选中词/句）
    document.addEventListener('selectionchange', () => {
        clearTimeout(selTimer);
        selTimer = setTimeout(updateSelBtn, 200);
    });

    // 点翻译卡片以外的任何地方 → 自动关闭它（× 太小不好点）。捕获阶段，先于页面自身处理。
    document.addEventListener('click', (e) => {
        if (!selPop || !selPop.classList.contains('show')) return;
        const t = e.target;
        if (t && t.closest && (t.closest('#simplix-sel-pop') || t.closest('#simplix-sel'))) return;
        selPop.classList.remove('show');
    }, true);

    if (!apiKey) toastOnce('SimpliX：请在扩展弹窗里设置 DeepSeek API Key');

    /* ---------------- 发现推文 / 文章段落 ---------------- */
    function scan(root) {
        (root || document).querySelectorAll(SEGMENT_SELECTOR).forEach(observe);
    }

    function observe(el) {
        if (SEEN.has(el)) return;
        if (isInsideArticle(el) && !isTranslatableArticleBlock(el)) {
            el.setAttribute('data-simplix', 'skip');
            return;
        }
        SEEN.add(el);
        io.observe(el);
    }

    function onMutations(muts) {
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== Node.ELEMENT_NODE) continue;
                if (n.matches && n.matches(SEGMENT_SELECTOR)) observe(n);
                if (n.querySelectorAll) n.querySelectorAll(SEGMENT_SELECTOR).forEach(observe);
            }
        }
    }

    function onIntersect(entries) {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            queue.push(e.target);
        }
        pump();
    }

    /* ---------------- 处理队列（限并发） ---------------- */
    function pump() {
        while (enabled && active < MAX_CONCURRENCY && queue.length) {
            const el = queue.shift();
            active++;
            process(el).catch(() => {}).finally(() => { active--; pump(); });
        }
    }

    async function process(el) {
        if (!enabled) return;
        if (!el.isConnected) return;
        const st = el.getAttribute('data-simplix');
        if (st === 'done' || st === 'skip' || st === 'giveup' || st === 'busy') return;

        // X 文章段落：相邻块成组、一次请求翻译
        if (isInsideArticle(el)) {
            if (!isTranslatableArticleBlock(el)) { el.setAttribute('data-simplix', 'skip'); return; }
            if (!apiKey) { toastOnce('请在扩展弹窗里设置 DeepSeek API Key'); return; }
            await processArticleChunk(el);
            return;
        }

        const { tokenized, entities } = tokenize(el);
        const prose = tokenized.replace(/\[\[\d+\]\]/g, ' ');
        if (!shouldProcess(prose)) { el.setAttribute('data-simplix', 'skip'); return; }
        if (!apiKey) { toastOnce('请在扩展弹窗里设置 DeepSeek API Key'); return; }

        // 长帖：按段落（\n 换行）拆开，每段单独请求 + 带前后段上下文，局部失败只丢该段
        if (prose.length > LONG_CHARS && entities.some((e) => e && e.tagName === 'BR')) {
            await processLong(el, tokenized, entities);
            return;
        }
        let out = cache.get(tokenized);
        if (out == null) {
            let p = inflight.get(tokenized);
            if (!p) {
                p = callAPI(tokenized);
                inflight.set(tokenized, p);
                p.finally(() => inflight.delete(tokenized));
            }
            try { out = await p; } catch (e) {
                retryLater(el); return;   // 网络失败 → 退避重试
            }
            if (out) cache.set(tokenized, out);
        }
        if (!out) { retryLater(el); return; }  // AI 返回空 → 退避重试
        if (!enabled || !el.isConnected || el.getAttribute('data-simplix') === 'done') return;
        const cleaned = validateTokens(out, entities.length);
        if (cleaned == null) {
            retryLater(el); return;
        }

        rebuild(el, cleaned, entities);
        el.setAttribute('data-simplix', 'done');
    }

    // 失败后退避重试：1.5s / 3s / 4.5s 三次，仍失败则标记 giveup（保留原文 + 浅红竖线）
    function retryLater(el) {
        if (!enabled || !el.isConnected) return;
        if (el.getAttribute('data-simplix') === 'done') return;
        const n = +el.getAttribute('data-simplix-retry') || 0;
        if (n >= MAX_RETRY) {
            el.setAttribute('data-simplix', 'giveup');
            return;
        }
        el.setAttribute('data-simplix-retry', String(n + 1));
        const delay = 1500 * (n + 1);
        setTimeout(() => {
            if (!enabled) return;
            if (!el.isConnected) return;
            if (el.getAttribute('data-simplix') === 'done') return;
            if (el.getAttribute('data-simplix') === 'giveup') return;
            queue.push(el);
            pump();
        }, delay);
    }

    /* ---------------- 占位符保护：抽取 / 校验 / 重建 ---------------- */
    // 把推文正文里的「实体」（链接/@/#/emoji 图片）换成 [[n]] 占位符，留住原节点引用；
    // 普通文字（可能裹在 span 里）递归取出。
    function tokenize(root) {
        let tokenized = '';
        const entities = [];
        const cs = getComputedStyle(root);
        // 容器是否「保留换行符」(pre/pre-wrap/pre-line)。X 的推文正文常用 pre-wrap，
        // 此时文本节点里的 \n 才是真实换行——必须把它们也当作换行实体保护，否则改写后揉成一段。
        const wsPreserves = /^(pre|pre-wrap|pre-line|break-spaces)$/.test(cs.whiteSpace);
        // 加粗/斜体识别：比正文基准字重明显更重、或字形为斜体，即视为强调。继承状态避免给嵌套 span 重复包标签。
        const baseWeight = parseInt(cs.fontWeight, 10) || 400;
        const isBoldEl = (el) => { const w = parseInt(getComputedStyle(el).fontWeight, 10) || baseWeight; return w >= 600 && w > baseWeight; };
        const isItalicEl = (el) => /italic|oblique/.test(getComputedStyle(el).fontStyle || '');
        (function walk(node, inB, inI) {
            node.childNodes.forEach((ch) => {
                if (ch.nodeType === Node.TEXT_NODE) {
                    const txt = ch.textContent;
                    if (wsPreserves && txt.indexOf('\n') >= 0) {
                        // 每个 \n 拆出来变成一个 <br> 占位符（与原生 <br> 同等保护，AI 不能合并）
                        txt.split('\n').forEach((seg, i) => {
                            if (i > 0) { tokenized += '[[' + entities.length + ']]'; entities.push(document.createElement('br')); }
                            tokenized += seg;
                        });
                    } else {
                        tokenized += txt;
                    }
                } else if (ch.nodeType === Node.ELEMENT_NODE) {
                    if (isEntity(ch)) {
                        // <br> / 链接 / @ / # / emoji 图片 一律作为实体保护成 [[n]] 占位符，
                        // AI 只能原样保留占位符、不能合并丢失；rebuild 把原始节点塞回 → 换行与链接都真正可点
                        tokenized += '[[' + entities.length + ']]';
                        entities.push(ch);
                    } else {
                        // 加粗/斜体的文字段用 <b>…</b> / <i>…</i> 包起来发给 AI（要它在改写里保留），rebuild 再包回
                        const b = !inB && isBoldEl(ch);
                        const it = !inI && isItalicEl(ch);
                        if (b) tokenized += '<b>';
                        if (it) tokenized += '<i>';
                        walk(ch, inB || b, inI || it);
                        if (it) tokenized += '</i>';
                        if (b) tokenized += '</b>';
                    }
                }
            });
        })(root, false, false);
        return { tokenized, entities };
    }

    function isEntity(el) {
        const tag = el.tagName;
        if (tag === 'BR') return true;   // <br> 换行也作为实体保护 → 不再依赖 AI 保留 \n
        if (tag === 'A') return true;    // 链接 / @提及 / #话题
        if (tag === 'IMG') return true;  // emoji 图片
        if (/^(PRE|CODE|KBD|SAMP|IFRAME|VIDEO|FIGURE|BLOCKQUOTE|ARTICLE)$/.test(tag)) return true;
        if (el.matches && el.matches(ARTICLE_EMBED_SELECTOR)) return true;
        return false;
    }

    // 校验+清洗：返回「可直接用于 rebuild 的 out」，不可用返回 null。
    // 仅做占位符计数校验与越界 token 剥离。换行已作为 <br> 实体被占位符保护，不再以 \n 字符形式出现在文本里，
    // 所以这里不再有任何 \n 保留逻辑——清洗空白时一律当普通空白处理。
    function validateTokens(out, n) {
        if (n === 0) {
            return out.replace(/\s*\[\[\d+\]\]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }
        const found = [...out.matchAll(/\[\[(\d+)\]\]/g)].map((m) => +m[1]);
        const valid = found.filter((k) => k >= 0 && k < n);
        if (valid.length !== n) return null;          // 实体数不对 → fail
        const set = new Set(valid);
        if (set.size !== n) return null;              // 有重复 → fail
        for (let i = 0; i < n; i++) if (!set.has(i)) return null;
        if (found.length === n) return out;
        return out.replace(/\s*\[\[(\d+)\]\]\s*/g, (m, k) =>
            (+k >= n) ? ' ' : m).replace(/\s{2,}/g, ' ').trim();
    }

    // 「改写结果(含占位符) + 实体数组」→ DocumentFragment（文字段→文本节点，占位符→原始实体节点）
    function buildFrag(out, entities) {
        const frag = document.createDocumentFragment();
        const stack = [frag];                       // 栈顶 = 当前容器（用于 <b>/<i> 嵌套）
        const cur = () => stack[stack.length - 1];
        const pushText = (t) => { if (t) cur().appendChild(document.createTextNode(t)); };
        const re = /(\[\[\d+\]\]|<\/?[bi]>)/g;      // 切出占位符与成对加粗/斜体标签
        let last = 0, m;
        while ((m = re.exec(out)) !== null) {
            pushText(out.slice(last, m.index));
            last = re.lastIndex;
            const tok = m[1];
            if (tok[0] === '[') {
                const e = entities[+tok.slice(2, -2)];
                if (e) cur().appendChild(e);        // 原始 <a>/<img>/<br> 节点塞回
            } else if (tok === '<b>' || tok === '<i>') {
                const w = document.createElement(tok === '<b>' ? 'strong' : 'em');
                cur().appendChild(w);
                stack.push(w);
            } else if (stack.length > 1) {            // </b> / </i>：闭合（容错：多余的闭合忽略）
                stack.pop();
            }
        }
        pushText(out.slice(last));
        return frag;
    }
    function rebuild(root, out, entities) {
        if (!originals.has(root)) originals.set(root, root.innerHTML); // 存原文，供「关闭 SimpliX」还原
        root.textContent = '';     // 清掉残余（实体已移走，安全）
        root.appendChild(buildFrag(out, entities));
    }

    /* ---------------- 长帖：分段改写（每段单独请求 + 前后段上下文 + 局部失败只丢该段） ---------------- */
    // 按「换行占位符(<br>)」把 tokenized 切成多段，每段重编本地占位符索引。
    // 返回 { paragraphs:[{tokenized,entities}], separators:[<br>...] }，separators[i] 夹在第 i、i+1 段之间。
    function splitParagraphs(tokenized, entities) {
        const paragraphs = [];
        const separators = [];
        let curText = '', curEnts = [], last = 0, m;
        const re = /\[\[(\d+)\]\]/g;
        const flush = () => { paragraphs.push({ tokenized: curText, entities: curEnts }); curText = ''; curEnts = []; };
        while ((m = re.exec(tokenized)) !== null) {
            curText += tokenized.slice(last, m.index);
            last = re.lastIndex;
            const node = entities[+m[1]];
            if (node && node.tagName === 'BR') { flush(); separators.push(node); }
            else { curText += '[[' + curEnts.length + ']]'; curEnts.push(node); }
        }
        curText += tokenized.slice(last);
        flush();
        return { paragraphs, separators };
    }

    async function processLong(el, tokenized, entities) {
        if (!originals.has(el)) originals.set(el, el.innerHTML);
        const { paragraphs, separators } = splitParagraphs(tokenized, entities);
        const proseOf = (p) => p.tokenized.replace(/\[\[\d+\]\]/g, ' ').trim();
        const frags = [];
        for (let i = 0; i < paragraphs.length; i++) {
            if (!enabled) return;
            const prev = i > 0 ? proseOf(paragraphs[i - 1]) : '';
            const next = i < paragraphs.length - 1 ? proseOf(paragraphs[i + 1]) : '';
            frags.push(await rewriteParagraph(paragraphs[i], [prev, next].filter(Boolean).join('\n\n')));
        }
        if (!enabled || !el.isConnected || el.getAttribute('data-simplix') === 'done') return;
        const out = document.createDocumentFragment();
        frags.forEach((f, i) => { out.appendChild(f); if (i < separators.length) out.appendChild(separators[i]); });
        el.textContent = '';
        el.appendChild(out);
        el.setAttribute('data-simplix', 'done');
    }

    // 改写单个段落（带前后段上下文）；任何失败都「保留该段原文」，不波及其它段
    async function rewriteParagraph(para, context) {
        const prose = para.tokenized.replace(/\[\[\d+\]\]/g, ' ');
        if (!shouldProcess(prose)) return buildFrag(para.tokenized, para.entities); // 太短/非英文 → 原样
        let out = cache.get(para.tokenized);
        if (out == null) {
            try { out = await callAPI(para.tokenized, context); }
            catch (e) { return buildFrag(para.tokenized, para.entities); }
            if (out) cache.set(para.tokenized, out);
        }
        const cleaned = out && validateTokens(out, para.entities.length);
        if (cleaned == null) return buildFrag(para.tokenized, para.entities);
        return buildFrag(cleaned, para.entities);
    }

    function isInsideArticle(el) {
        return !!(el && el.closest && el.closest(ARTICLE_HOST_SELECTOR));
    }

    function isTranslatableArticleBlock(el) {
        if (!el || !el.matches || !el.matches('[data-block]')) return false;
        if (!isInsideArticle(el)) return false;
        if (!(el.textContent || '').trim()) return false;
        const tag = el.tagName;
        const cls = String(el.className || '');
        if (tag === 'SECTION') return false;
        if (/^(ARTICLE|BLOCKQUOTE|FIGURE|IFRAME|PRE|CODE|KBD|SAMP|VIDEO)$/.test(tag)) return false;
        if (el.querySelector && el.querySelector(ARTICLE_EMBED_SELECTOR)) return false;
        if (/^H[1-6]$/.test(tag)) return /longform-header/i.test(cls);
        if (tag !== 'DIV') return false;
        return /longform-(?:unstyled|header)|public-DraftStyleDefault/i.test(cls);
    }

    function articleBlocks(host) {
        return [...host.querySelectorAll('[data-block]')].filter(isTranslatableArticleBlock);
    }

    // X 文章：取当前段落前后相邻的普通文字块作为背景上下文
    function neighborContextArticle(el) {
        const host = el.closest && el.closest(ARTICLE_HOST_SELECTOR);
        if (!host) return '';
        const paras = articleBlocks(host);
        for (let i = 0; i < paras.length; i++) {
            if (paras[i] === el) {
                const prev = i > 0 ? (paras[i - 1].textContent || '').trim() : '';
                const next = i < paras.length - 1 ? (paras[i + 1].textContent || '').trim() : '';
                return [prev, next].filter(Boolean).join('\n\n');
            }
        }
        return '';
    }

    /* ---------------- X 文章：相邻块凑段、一次请求翻译 ---------------- */
    // 把多块拼成「一条带换行的长文」：各块 tokenize 结果用 <br> 分隔占位符相连（全局索引）
    function combineBlocks(blocks) {
        let combinedTok = '';
        const entities = [];
        blocks.forEach((b, i) => {
            if (i > 0) { combinedTok += '[[' + entities.length + ']]'; entities.push(document.createElement('br')); }
            const t = tokenize(b);
            const base = entities.length;
            combinedTok += t.tokenized.replace(/\[\[(\d+)\]\]/g, (m, k) => '[[' + (base + (+k)) + ']]');
            t.entities.forEach((e) => entities.push(e));
        });
        return { combinedTok, entities };
    }

    async function processArticleChunk(firstBlock) {
        if (!enabled) return;
        if (!isTranslatableArticleBlock(firstBlock)) { firstBlock.setAttribute('data-simplix', 'skip'); return; }
        const host = firstBlock.closest(ARTICLE_HOST_SELECTOR);
        if (!host) { await processArticleBlock(firstBlock); return; }
        // 贪心组块：从 firstBlock 起按文档顺序收后续未处理块，累计到 ART_CHUNK_CHARS（至少 1 块）
        const all = [...host.querySelectorAll('[data-block]')];
        const start = all.indexOf(firstBlock);
        if (start < 0) { await processArticleBlock(firstBlock); return; }
        const chunk = [];
        let chars = 0;
        for (let i = start; i < all.length; i++) {
            const b = all[i];
            if (!isTranslatableArticleBlock(b)) { if (!chunk.length) b.setAttribute('data-simplix', 'skip'); break; }
            const stt = b.getAttribute('data-simplix');
            if (stt === 'done' || stt === 'busy' || stt === 'skip' || stt === 'giveup') break;
            const len = (b.textContent || '').length;
            if (chunk.length && chars + len > ART_CHUNK_CHARS) break;
            chunk.push(b); chars += len;
            if (chars >= ART_CHUNK_CHARS) break;
        }
        if (!chunk.length) return;
        chunk.forEach((b) => b.setAttribute('data-simplix', 'busy')); // 同步占位，防同屏多块各起重叠组

        const { combinedTok, entities } = combineBlocks(chunk);
        if (!shouldProcess(combinedTok.replace(/\[\[\d+\]\]/g, ' '))) {
            chunk.forEach((b) => b.setAttribute('data-simplix', 'skip')); return;
        }
        let out = cache.get(combinedTok);
        if (out == null) {
            try { out = await callAPI(combinedTok); }
            catch (e) { return chunkFallback(chunk); }
            if (out) cache.set(combinedTok, out);
        }
        const cleaned = out && validateTokens(out, entities.length);
        if (cleaned == null) return chunkFallback(chunk);
        const { paragraphs } = splitParagraphs(cleaned, entities);
        if (paragraphs.length !== chunk.length) {
            return chunkFallback(chunk);
        }
        chunk.forEach((b, i) => {
            if (!enabled || !b.isConnected) return;
            rebuild(b, paragraphs[i].tokenized, paragraphs[i].entities);
            b.setAttribute('data-simplix', 'done');
        });
    }

    // 组块失败 → 清掉 busy，逐块单独翻（拿回逐块的健壮性）
    function chunkFallback(chunk) {
        chunk.forEach((b) => { if (b.getAttribute('data-simplix') === 'busy') b.removeAttribute('data-simplix'); });
        chunk.forEach((b) => { if (isTranslatableArticleBlock(b)) processArticleBlock(b); });
    }

    // 兜底：单块单独翻，带前后段上下文（组块失败时用）
    async function processArticleBlock(el) {
        if (!enabled) return;
        if (!el.isConnected || el.getAttribute('data-simplix') === 'done') return;
        if (!isTranslatableArticleBlock(el)) { el.setAttribute('data-simplix', 'skip'); return; }
        const { tokenized, entities } = tokenize(el);
        const prose = tokenized.replace(/\[\[\d+\]\]/g, ' ');
        if (!shouldProcess(prose)) { el.setAttribute('data-simplix', 'skip'); return; }
        let out = cache.get(tokenized);
        if (out == null) {
            try { out = await callAPI(tokenized, neighborContextArticle(el)); }
            catch (e) { if (enabled) el.setAttribute('data-simplix', 'giveup'); return; }
            if (out) cache.set(tokenized, out);
        }
        const cleaned = out && validateTokens(out, entities.length);
        if (cleaned == null) { if (enabled) el.setAttribute('data-simplix', 'giveup'); return; }
        if (!enabled || !el.isConnected || el.getAttribute('data-simplix') === 'done') return;
        rebuild(el, cleaned, entities);
        el.setAttribute('data-simplix', 'done');
    }

    /* ---------------- 过滤：英文为主 + 够长 ---------------- */
    function latinRatioOf(text) {
        const t = (text || '').trim();
        let latin = 0, han = 0;
        for (const ch of t) {
            const cp = ch.codePointAt(0);
            if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) ||
                (cp >= 0xC0 && cp <= 0x24F && cp !== 0xD7 && cp !== 0xF7)) latin++;
            else if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) han++;
        }
        const letters = latin + han;
        return letters === 0 ? null : latin / letters; // null = 没实义字
    }
    function wordCountOf(text) {
        const t = (text || '').trim();
        if (!t) return 0;
        return t.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
    }
    function shouldProcess(text) {
        const t = (text || '').trim();
        if (!t) return false;
        const ratio = latinRatioOf(t);
        if (ratio == null) return false;            // 没有实义字（纯链接/emoji）
        if (ratio < LATIN_RATIO) return false;       // 中文为主 / 重度混排 → 跳过
        if (wordCountOf(t) < MIN_WORDS) return false; // ≤3 词 → 忽略
        return true;
    }

    /* ---------------- 选中查词 / 译句（基于上下文，输出中文） ---------------- */
    function updateSelBtn() {
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : '';
        if (!text || text.length > 200 || inEditable(sel)) { lastSel = null; hideSelBtn(); return; }
        let ctx = '';
        try {
            const an = sel.anchorNode;
            const host = an && (an.nodeType === 1 ? an : an.parentElement);
            const tw = host && host.closest && host.closest('[data-testid="tweetText"],[data-block]');
            if (tw) ctx = tw.textContent || '';
        } catch (e) { /* ignore */ }
        lastSel = { text, context: ctx };
        showSelBtn();
    }
    function inEditable(sel) {
        try {
            const an = sel.anchorNode;
            const el = an && (an.nodeType === 1 ? an : an.parentElement);
            return !!(el && el.closest && el.closest('input,textarea,[contenteditable="true"]'));
        } catch (e) { return false; }
    }
    function createSelBtn() {
        selBtn = document.createElement('div');
        selBtn.id = 'simplix-sel';
        selBtn.textContent = '译';
        selBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
        selBtn.addEventListener('click', onTranslateSel, true);
        document.documentElement.appendChild(selBtn);
    }
    function showSelBtn() { if (!selBtn) createSelBtn(); selBtn.classList.add('show'); }
    function hideSelBtn() { if (selBtn) selBtn.classList.remove('show'); }

    async function onTranslateSel(e) {
        e.preventDefault(); e.stopPropagation();
        clearTimeout(selTimer); // 防止挂起的 updateSelBtn 把 lastSel 清掉
        if (!lastSel || !lastSel.text) return;
        if (!apiKey) { toast('请先设置 DeepSeek API Key'); return; }
        const sel = lastSel;
        const isWord = !/\s/.test(sel.text.trim()) && /[A-Za-z]/.test(sel.text); // 单个词才给音标+朗读
        hideSelBtn();
        showSelPop(sel.text, '正在翻译…', '', isWord);
        try {
            const res = await translateSel(sel.text, sel.context);
            showSelPop(sel.text, res.meaning || '（翻译失败，请重试）', res.phonetic, isWord);
        } catch (err) {
            showSelPop(sel.text, '翻译出错：' + (err && err.message || err), '', isWord);
        }
    }
    async function translateSel(text, context) {
        const res = await sendToBackground({
            type: 'simplix.translateSelection',
            text,
            context,
            systemPrompt: SIMPLIX_PROMPTS.SELECTION_DEFAULT,
        });
        if (!res || !res.ok) throw new Error((res && res.error) || 'network');
        return {
            meaning: res.meaning ? String(res.meaning).trim() : null,
            phonetic: res.phonetic ? String(res.phonetic).trim() : '',
        };
    }
    function createSelPop() {
        selPop = document.createElement('div');
        selPop.id = 'simplix-sel-pop';
        selPop.innerHTML =
            '<div class="simplix-sel-head">' +
                '<span class="simplix-sel-term"></span>' +
                '<span class="simplix-sel-ipa"></span>' +
                '<span class="simplix-sel-sp"></span>' +
                '<button class="simplix-sel-spk" type="button" aria-label="朗读"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></button>' +
                '<button class="simplix-sel-x" type="button" aria-label="关闭">×</button>' +
            '</div><div class="simplix-sel-body"></div>';
        document.documentElement.appendChild(selPop);
        selPop.querySelector('.simplix-sel-x').addEventListener('click', () => selPop.classList.remove('show'), true);
        selPop.querySelector('.simplix-sel-spk').addEventListener('click',
            () => speak(selPop.querySelector('.simplix-sel-term').textContent), true);
    }
    function showSelPop(term, body, phonetic, isWord) {
        if (!selPop) createSelPop();
        selPop.querySelector('.simplix-sel-term').textContent = term;
        const ipa = selPop.querySelector('.simplix-sel-ipa');
        ipa.textContent = phonetic || '';
        ipa.style.display = phonetic ? 'inline' : 'none';
        selPop.querySelector('.simplix-sel-spk').style.display = isWord ? 'inline-flex' : 'none';
        selPop.querySelector('.simplix-sel-body').textContent = body;
        selPop.classList.add('show');
    }
    // 朗读（美音，用设备 TTS）
    function speak(text) {
        try {
            if (!window.speechSynthesis) { toast('浏览器不支持朗读'); return; }
            const u = new SpeechSynthesisUtterance((text || '').trim());
            u.lang = 'en-US'; u.rate = 0.9;
            speechSynthesis.cancel();
            speechSynthesis.speak(u);
        } catch (e) { toast('朗读失败'); }
    }

    /* ---------------- 调 DeepSeek（绕过 CORS） ---------------- */
    async function callAPI(tokenized, context) {
        const res = await sendToBackground({
            type: 'simplix.rewrite',
            tokenized,
            context,
            systemPrompt: systemPromptFor(tokenized),
            userContent: buildUserContent(tokenized, context),
        });
        if (!res || !res.ok) throw new Error((res && res.error) || 'network');
        return res.rewritten || null;
    }

    function buildUserContent(tokenized, context) {
        // 所有 token 规则在 system prompt 已按需条件装载；用户消息保持中性。
        let s = 'Rewrite this X post into easier English. Output STRICTLY as JSON {"rewritten":"..."}.';
        if (context && context.trim()) {
            // 前后相邻段，仅供理解上下文——绝不改写、绝不输出
            s += '\n\nNearby paragraphs (CONTEXT ONLY — do NOT rewrite or output these):\n"""' + context + '"""';
            s += '\n\nThe part to rewrite (rewrite ONLY this, keep its tokens):\n"""' + tokenized + '"""';
        } else {
            s += '\n\nPost:\n"""' + tokenized + '"""';
        }
        return s;
    }

    /* ---------------- 开关 / 设置 / UI ---------------- */
    function setEnabled(v, opts) {
        enabled = v;
        if (!opts || opts.persist !== false) extensionSetSettings({ enabled });
        updateFab();
        if (enabled) { reRewriteAll(); scan(document); pump(); }
        else { revertAll(); }
        toast(enabled ? 'SimpliX：开（恢复改写）' : 'SimpliX：关（已还原原文）');
    }

    // 关闭 SimpliX：还原已改写内容，并把失败/忙碌状态重置为可重新触发
    function revertAll() {
        document.querySelectorAll(SEGMENT_SELECTOR).forEach((el) => {
            const st = el.getAttribute('data-simplix');
            if (st === 'done') {
                const html = originals.get(el);
                if (html != null) el.innerHTML = html;
                el.removeAttribute('data-simplix-retry');
                el.setAttribute('data-simplix', 'orig');
                return;
            }
            if (st === 'giveup' || st === 'busy') {
                el.removeAttribute('data-simplix-retry');
                el.setAttribute('data-simplix', 'orig');
            }
        });
    }
    // 重新开启：把还原过/失败过的推文再改写一遍（已成功的 tokenized 文本可命中缓存）
    function reRewriteAll() {
        document.querySelectorAll(SEGMENT_SELECTOR).forEach((el) => {
            if (el.getAttribute('data-simplix') !== 'orig') return;
            if (isInsideArticle(el) && !isTranslatableArticleBlock(el)) { el.setAttribute('data-simplix', 'skip'); return; }
            el.removeAttribute('data-simplix');
            io.observe(el);
        });
    }

    function toggle() { setEnabled(!enabled); }

    // 点 FAB：还没填 key 就先弹框填 key；已填则开/关。弹窗也可改同一份设置。
    function onFabClick() {
        if (!apiKey) { setKey(); return; }
        toggle();
    }

    function setKey() {
        const v = prompt('输入 DeepSeek API Key：', apiKey || '');
        if (v == null) return;
        apiKey = v.trim();
        extensionSetSettings({ apiKey });
        toast(apiKey ? 'API Key 已保存' : 'API Key 已清空');
        if (apiKey) rescanAll();
    }

    // 重新观察当前页面里还没改写的推文：设置 key 后让「屏幕上现有的」推文立刻开始处理，
    // 不用等用户滚动出新推文（IntersectionObserver 对当前已在视口内的元素会立即回调一次）。
    function rescanAll() {
        document.querySelectorAll(SEGMENT_SELECTOR).forEach((el) => {
            if (el.getAttribute('data-simplix') === 'done') return;
            if (isInsideArticle(el) && !isTranslatableArticleBlock(el)) { el.setAttribute('data-simplix', 'skip'); return; }
            el.removeAttribute('data-simplix');
            io.observe(el);
        });
        pump();
    }

    function createFab() {
        fab = document.createElement('div');
        fab.id = 'simplix-fab';
        fab.addEventListener('click', onFabClick, true);
        document.documentElement.appendChild(fab);
        updateFab();
    }

    function updateFab() {
        if (!fab) return;
        fab.textContent = enabled ? '易' : '关';
        fab.classList.toggle('off', !enabled);
    }

    function toast(msg) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'simplix-toast';
            document.documentElement.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
    }

    function toastOnce(msg) {
        if (toastedOnce.has(msg)) return;
        toastedOnce.add(msg);
        toast(msg);
    }

    function injectStyle() {
        const s = document.createElement('style');
        s.textContent = `
        #simplix-fab{position:fixed;left:14px;bottom:84px;z-index:99999;width:46px;height:46px;
            border-radius:50%;display:flex;align-items:center;justify-content:center;
            border:1px solid #2b2b2b;font:600 13px -apple-system,"PingFang SC",Arial,sans-serif;
            color:#f5f5f2;background:#050505;box-shadow:0 8px 26px rgba(0,0,0,.35);
            cursor:pointer;user-select:none;-webkit-user-select:none;opacity:.94}
        #simplix-fab.off{color:#050505;background:#f5f5f2;border-color:#d8d8d2}
        [data-simplix="done"]{border-left:2px solid rgba(29,155,240,.45);padding-left:8px}
        [data-simplix="giveup"]{border-left:2px solid rgba(220,80,80,.5);padding-left:8px}
        #simplix-toast{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:99999;
            background:#050505;color:#f5f5f2;border:1px solid #2b2b2b;padding:8px 14px;border-radius:8px;
            max-width:80vw;text-align:center;font:13px -apple-system,"PingFang SC",Arial,sans-serif;
            opacity:0;transition:opacity .2s;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.36)}
        #simplix-toast.show{opacity:.95}
        #simplix-sel{position:fixed;left:50%;transform:translateX(-50%);bottom:180px;z-index:100000;
            height:34px;padding:0 16px;border-radius:17px;display:none;align-items:center;justify-content:center;
            border:1px solid #2b2b2b;font:600 14px -apple-system,"PingFang SC",Arial,sans-serif;
            color:#f5f5f2;background:#050505;box-shadow:0 8px 24px rgba(0,0,0,.36);
            cursor:pointer;user-select:none;-webkit-user-select:none}
        #simplix-sel.show{display:inline-flex}
        #simplix-sel-pop{position:fixed;left:50%;right:auto;bottom:92px;z-index:100000;display:none;
            width:calc(100vw - 24px);max-width:460px;transform:translateX(-50%);
            background:#050505;color:#f5f5f2;border:1px solid #2b2b2b;border-radius:12px;
            box-shadow:0 16px 42px rgba(0,0,0,.55);font:14px -apple-system,"PingFang SC",Arial,sans-serif;overflow:hidden}
        #simplix-sel-pop.show{display:block}
        #simplix-sel-pop .simplix-sel-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0f0f0f;border-bottom:1px solid #2b2b2b}
        #simplix-sel-pop .simplix-sel-term{font-weight:600;color:#f5f5f2;word-break:break-word}
        #simplix-sel-pop .simplix-sel-ipa{margin-left:8px;color:#9b9b96;font:13px monospace}
        #simplix-sel-pop .simplix-sel-sp{flex:1}
        #simplix-sel-pop .simplix-sel-spk{background:transparent;border:0;color:#f5f5f2;padding:2px 6px;align-items:center;justify-content:center}
        #simplix-sel-pop .simplix-sel-spk:active{opacity:.55}
        #simplix-sel-pop .simplix-sel-x{background:transparent;border:0;color:#9b9b96;font-size:22px;line-height:1;padding:0 6px}
        #simplix-sel-pop .simplix-sel-body{padding:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto}`;
        document.documentElement.appendChild(s);
    }
})();
