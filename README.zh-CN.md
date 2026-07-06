# SimpliX

[English](README.md)

![SimpliX 标志与字标](docs/images/hero.png)

**Read English on X/Twitter, with simpler English.**

它不会把整页翻译成中文，而是把难懂的英文推文改写成**更清楚、更容易读的英文**，让你尽量**保留英文阅读环境**。

此外，当你选中单词、短语或句子时，页面上的「译」按钮还可以结合当前推文上下文，用中文解释它的意思。

> 注意：SimpliX 会使用你自己的 DeepSeek API Key，将需要处理的 X/Twitter 文本和必要上下文直接发送到 DeepSeek API。API 费用由你的 DeepSeek 账号承担。

![SimpliX 使用前后对比](docs/images/before-after-musk.png)

![SimpliX 处理长推文前后对比](docs/images/before-after-long-post.png)

## 为什么不翻译成中文？

很多翻译插件会直接把英文网页翻译成中文。这样虽然省力，但也**容易让你脱离英文阅读环境**。

SimpliX 的目标不是替你绕开英文，而是帮你**继续读英文**：

- 难句子变成更清楚的英文；
- 长推文变得更容易理解；
- 不懂的词、短语或句子可以单独点「译」查看中文解释；
- 原文的链接、@提及、#话题、emoji 和换行尽量保留。

**它适合那些不想完全依赖翻译、但又希望降低英文阅读难度的英语学习者。**

## 主要功能

- 自动处理进入屏幕的英文 X/Twitter 内容，无需逐条点击。
- 只处理英文为主且有一定长度的内容，中文推文和很短的英文会跳过。
- 将英文推文原地改写为更易读的英文，并尽量保留原意、语气和上下文。
- 保留链接、@提及、#话题、emoji 和换行结构。
- 支持 X 长文章段落。
- 跳过图片、媒体、嵌入推文、引用推文和代码块。
- 选中英文单词、短语或句子后，显示「译」按钮。
- 使用你自己的 DeepSeek API Key，不内置任何公共 Key。
- 没有项目自有后端服务器，请求直接从浏览器发送到 DeepSeek API。
- Chrome 插件版支持自定义英文简化改写提示词，适合高级用户微调风格和难度。

## 项目结构

```
SimpliX/
├─ chrome-extension/   # Chrome Manifest V3 插件版
├─ userscript/         # Tampermonkey / Violentmonkey 油猴脚本版
├─ docs/images/        # README 图片
├─ PRIVACY.md          # 隐私说明
├─ LICENSE             # MIT License
├─ README.md           # 英文 README
└─ README.zh-CN.md     # 中文 README
```

两个版本可以并存：

- 电脑端建议使用 **Chrome 插件版；**
- 手机端可使用 Firefox + Violentmonkey 的**油猴脚本版。**

## 使用方式

如果你不想手动阅读和理解整个项目结构，也可以**直接把这个仓库丢给你常用的 AI，让它帮你完成安装或解释**。

你可以这样做：

- 把整个项目下载下来（或复制 GitHub 链接）；
- 告诉 AI：「这是一个 Chrome 插件 / 油猴脚本项目，帮我一步一步安装并运行它」；
- 或者让 AI 帮你解释某个文件、修改配置、甚至做二次开发。

SimpliX 的结构比较简单，对 AI 也比较友好，大多数情况下它可以直接读懂并给出可执行的步骤。

### 1、Chrome 插件安装

1. 下载或克隆本仓库。
2. 打开 Chrome 扩展管理页面：

```
chrome://extensions/
```

3. 开启右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择本项目中的 `chrome-extension/` 文件夹。
6. 打开 `x.com` 或 `twitter.com`。
7. 点击浏览器工具栏里的 SimpliX 图标，填入你的 DeepSeek API Key。

安装后，页面左下角会出现「易 / 关」浮动按钮，可以快速开启或关闭 SimpliX。

### 2、油猴脚本安装

1. 安装 Tampermonkey 或 Violentmonkey。
2. 新建一个 userscript。
3. 复制 `userscript/simplix.user.js` 的内容并保存。
4. 打开 `x.com` 或 `twitter.com`。
5. 在脚本管理器菜单中设置你的 DeepSeek API Key。

手机端建议使用：

```
Firefox + Violentmonkey
```

油猴脚本版更多说明见：

```
userscript/README.md
```

## API Key 与费用

SimpliX 调用 DeepSeek API，因此你需要准备自己的 DeepSeek API Key。

API 使用费用由你的 DeepSeek 账号承担。本项目不提供、不内置、也不共享任何公共 API Key。

API Key 的本地存储方式如下：

- Chrome 插件版：存储在 `chrome.storage.local`。
- 油猴脚本版：存储在脚本管理器的本地 value storage 中。

## 隐私说明

SimpliX 没有项目自有后端服务器。

当你使用改写或解释功能时，浏览器会把相关 X/Twitter 文本和必要上下文直接发送到：

```
https://api.deepseek.com/
```

这些内容用于生成更易读的英文改写，或用于解释你选中的单词、短语、句子。

## 已知限制

- X/Twitter 经常调整页面结构，SimpliX 可能偶尔无法识别或处理部分内容。
- 很短的英文推文、中文为主的推文、代码块、图片、媒体、嵌入内容和引用推文会被跳过。
- 改写结果由 AI 生成，可能偶尔不准确。
- 对重要内容、专业内容或敏感信息，请以原文为准。
- 如果 DeepSeek API 不可用、余额不足或 Key 配置错误，SimpliX 将无法正常改写或解释文本。

## License

MIT. See `LICENSE`.
