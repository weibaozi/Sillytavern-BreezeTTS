const icons = {
    characters: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>',
    voices: '<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/>',
    design: '<path d="m15 4 5 5M4 20l3-7L17 3l4 4L11 17l-7 3Zm2-4 2 2M5 3v4M3 5h4M18 15v6m-3-3h6"/>',
    prompt: '<path d="M8 4H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M8 20H5a2 2 0 0 1-2-2v-3m13 5h3a2 2 0 0 0 2-2v-3M9 9l-3 3 3 3m6-6 3 3-3 3"/>',
    connection: '<path d="M10 5H3m18 0h-5M6 12H3m18 0H12m2 7H3m18 0h-1"/><circle cx="13" cy="5" r="3"/><circle cx="9" cy="12" r="3"/><circle cx="17" cy="19" r="3"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.voices}</svg>`;
const pages = {
    characters: ['角色与音色', '让每个角色，拥有自己的声音。'],
    voices: ['本地音色库', '保存喜欢的声音，在不同角色和聊天中使用。'],
    design: ['声音设计室', '从文字或参考音频开始，试听之后再作选择。'],
    prompt: ['预设注入', '随当前聊天更新的对白规范。'],
    connection: ['连接与播放', '连接 Breeze，按你的习惯播放对白。'],
};

/** Build an isolated UI shell. State, API requests and playback belong to index.js. */
export function createStudioPanel() {
    const host = document.createElement('div');
    host.id = 'breeze-studio-host';
    const root = host.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./panel.css', import.meta.url).href;
    const dialog = document.createElement('dialog');
    dialog.id = 'breeze-studio-dialog';
    dialog.className = 'studio';
    dialog.setAttribute('aria-labelledby', 'studio-title');
    dialog.innerHTML = `
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">${icon('voices')}</div><div><strong>Breeze</strong><small>VOICE STUDIO</small></div></div>
        <p class="nav-caption">声音工作台</p>
        <nav aria-label="语音管理导航">${Object.entries(pages).map(([key, [title]], index) => `<button type="button" data-tab="${key}" aria-controls="page-${key}">${icon(key)}<span>${title}</span><span class="nav-index">0${index + 1}</span></button>`).join('')}</nav>
        <div class="sidebar-note"><span class="mini-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><p>文字之间，<br>听见角色。</p></div>
        <div class="service"><span class="service-dot" data-service-dot></span><div><small>BREEZE TTS</small><span data-service-label>等待连接</span></div></div>
      </aside>
      <div class="workspace">
        <header class="topbar"><div><div class="eyebrow">BREEZE <span>/</span> WORKSPACE</div><h1 id="studio-title" data-page-title>角色与音色</h1><p data-page-subtitle>让每个角色，拥有自己的声音。</p></div><div class="topbar-actions"><span class="playback-status">${icon('voices')}<span data-playback-label>未播放</span></span><button class="icon-button close-button" type="button" data-close aria-label="关闭语音工作台" title="关闭 · Esc">${icon('close')}</button></div></header>
        <main class="page-scroll">
          <section data-page="characters" id="page-characters" aria-label="角色与音色">
            <div class="chat-hero"><div><div class="eyebrow">CURRENT CONVERSATION</div><h2 data-chat-name>未打开聊天</h2><p>为本次对话分配音色，绑定会随聊天保存。</p></div><div class="hero-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
            <div class="stats"><div><span>发现的角色</span><strong data-character-count>0</strong></div><div><span>已绑定音色</span><strong data-bound-count>0</strong></div><div><span>本地音色</span><strong data-voice-count>0</strong></div></div>
            <div class="section-toolbar"><div><h3>角色列表</h3><p>未绑定角色会跳过朗读；多个角色可共用音色。</p></div><label class="search-field">${icon('search')}<input data-character-search type="search" placeholder="查找角色" aria-label="查找角色"></label></div>
            <div class="character-grid" data-characters></div>
            <form data-add-character class="add-character"><div class="add-character-icon">${icon('plus')}</div><label>还有其他角色？<span>手动添加正文中出现的固定角色名。</span></label><input name="speaker" required maxlength="100" placeholder="输入角色名" aria-label="手动添加的角色名"><button class="button secondary" type="submit">添加角色</button></form>
          </section>
          <section data-page="voices" id="page-voices" aria-label="本地音色库" hidden>
            <div class="section-toolbar"><div><h2>你的声音收藏</h2><p>每个音色保存一段参考音频和对应文字。</p></div><label class="search-field">${icon('search')}<input data-voice-search type="search" placeholder="查找音色" aria-label="查找音色"></label></div>
            <details class="upload-panel"><summary>${icon('upload')}<div><strong>导入参考音色</strong><span>已经有合适的声音？从本地音频开始。</span></div><span class="expand-symbol">+</span></summary><form data-upload class="upload-form"><div class="two-fields"><label class="field">音色名称<input name="name" required maxlength="100" placeholder="给这个声音起个名字"></label><label class="field">参考音频<input name="audio" type="file" accept="audio/*" required><small>音频须包含清晰人声，文件不超过 20 MB。</small></label></div><label class="field">音频对应的准确文字<textarea name="ref_text" required maxlength="6000" rows="3" placeholder="逐字填写参考音频中的内容。"></textarea></label><div class="form-actions"><p class="help">音频和文字保持一致，有助于稳定复现音色。</p><button class="button primary" type="submit">保存到音色库 ${icon('arrow')}</button></div></form></details>
            <div class="voice-grid" data-voices></div>
          </section>
          <section data-page="design" id="page-design" aria-label="声音设计室" hidden>
            <div class="design-layout">
              <div class="surface design-form-card">
                <div class="card-heading"><span class="step-number">01</span><div><h3>描绘你想听到的声音</h3><p>选择一种起点，生成属于角色的声音。</p></div></div>
                <form data-design>
                  <label class="field">设计方式<select name="mode"><option value="design">文字设计 · 从描述创造音色</option><option value="direction">语音方向 · 参考音频与文字</option></select></label>
                  <div data-direction-fields hidden>
                    <label class="field">参考音频<input name="audio" type="file" accept="audio/*" disabled><small>上传清晰人声，不超过 20 MB。原始参考不会直接存入音色库。</small></label>
                    <audio data-direction-preview controls preload="none" hidden aria-label="试听上传的参考音频"></audio>
                    <label class="field">参考音频对应的准确文字<textarea name="ref_text" maxlength="6000" rows="3" placeholder="逐字填写上传音频中的内容；可与下方试听文本不同。" disabled></textarea></label>
                  </div>
                  <label class="field">声音描述<textarea name="instruction" required maxlength="2000" rows="4" placeholder="例如：年轻男性，清亮而温暖的声音，语速自然，像熟悉的大学室友。"></textarea><small data-description-help>描述年龄感、音色和说话方式。</small></label>
                  <label class="field">试听文本<textarea name="text" required maxlength="6000" rows="4">你好，很高兴见到你。今天想聊些什么？</textarea><small>保存音色时，这段文字会与生成的候选音频一同保留。</small></label>
                  <label class="field candidate-count">候选数量<input name="count" type="number" min="1" max="8" value="3" required><small>1–8 个，依次使用不同种子生成。</small></label>
                  <div class="form-actions"><button class="button primary" type="submit">${icon('design')} 生成候选音色</button><button class="button quiet" type="button" data-cancel-design>取消生成</button></div>
                </form>
              </div>
              <div class="candidate-column"><div class="card-heading"><span class="step-number">02</span><div><h3>听一听，再决定</h3><p>选择喜欢的候选，命名并保存。</p></div></div><div class="candidate-list" data-candidates><div class="empty-state candidate-empty"><span class="empty-icon">${icon('voices')}</span><h3>新的声音，从这里开始</h3><p>选择设计方式并生成候选。<br>完成的音频会出现在这里。</p></div></div></div>
            </div>
          </section>
          <section data-page="prompt" id="page-prompt" aria-label="预设注入" hidden>
            <p class="inline-note"><strong>TTSVoice 单份对白实验版</strong> · 对白只写在标签内，由插件显示成引号对白与气泡。实验模板单独保存，原模板保留。</p>
            <div class="surface prompt-settings"><label class="switch-row"><span><strong>自动注入对白规范</strong><small>每轮生成前，根据当前聊天的角色与音色绑定更新。</small></span><input data-setting="injectPrompt" type="checkbox" role="switch"><span class="switch" aria-hidden="true"></span></label><label class="depth-field">注入深度<input data-setting="promptDepth" type="number" min="0" max="100" step="1" required></label></div>
            <p class="inline-note" data-prompt-status role="status"></p>
            <div class="prompt-guidance-grid">
              <section class="surface prompt-guidance-card" aria-labelledby="vocal-events-heading">
                <div class="guidance-heading"><div><span class="eyebrow">VOCAL EVENTS</span><h3 id="vocal-events-heading">语气词列表</h3></div><span class="editor-chip">所有聊天共用</span></div>
                <p class="guidance-description">告诉模型可以使用哪些发声标签；修改后自动保存，预览实时更新。</p>
                <label class="field" for="breeze-vocal-events">允许的语气词<textarea id="breeze-vocal-events" data-vocal-events rows="5" spellcheck="false" placeholder="[笑]&#10;[叹气]&#10;[咳嗽]&#10;[清嗓子]" aria-describedby="vocal-events-help vocal-events-status"></textarea><small id="vocal-events-help">每行一项，默认使用 [笑]、[叹气]、[咳嗽]、[清嗓子]。</small></label>
                <div class="guidance-footer"><p id="vocal-events-status" class="guidance-status" data-vocal-events-status role="status" aria-live="polite"></p><button class="button quiet" type="button" data-reset-vocal-events>恢复默认四项</button></div>
              </section>
              <section class="surface prompt-guidance-card extra-prompt-card" aria-labelledby="extra-prompt-heading">
                <div class="guidance-heading"><div><span class="eyebrow">CONVERSATION NOTES</span><h3 id="extra-prompt-heading">额外语料</h3></div><span class="editor-chip">语料库共用</span></div>
                <label class="field" for="breeze-extra-prompt-select">当前聊天的语料<select id="breeze-extra-prompt-select" data-extra-prompt-select aria-describedby="extra-prompt-status"><option value="">不使用语料</option></select></label>
                <div class="extra-prompt-actions"><button class="button primary" type="button" data-new-extra-prompt>新建并使用</button><button class="button quiet" type="button" data-copy-extra-prompt>复制并使用</button><button class="button quiet extra-prompt-delete" type="button" data-delete-extra-prompt>删除</button></div>
                <label class="switch-row extra-prompt-switch"><span><strong>在当前聊天启用</strong><small>所选语料与开关只绑定当前聊天，其他聊天可选择同一份语料。</small></span><input data-extra-prompt-enabled type="checkbox" role="switch" aria-describedby="extra-prompt-status"><span class="switch" aria-hidden="true"></span></label>
                <label class="field" for="breeze-extra-prompt-name">语料名称<input id="breeze-extra-prompt-name" data-extra-prompt-name type="text" maxlength="80" required placeholder="例如：校园 · 考后闲聊" aria-describedby="extra-prompt-library-help extra-prompt-status"></label>
                <label class="field" for="breeze-extra-prompt">背景与发声指导<textarea id="breeze-extra-prompt" data-extra-prompt rows="5" placeholder="例如：期末考后，大家都放松下来。周启明偶尔笑着打趣；林同学仍有些紧张，语气轻一些。语气词只在自然发声时使用。" aria-describedby="extra-prompt-help extra-prompt-library-help extra-prompt-status"></textarea><small id="extra-prompt-help">默认留空。当前聊天开启且内容非空时，在预设末尾单独追加第 6 条。</small><small id="extra-prompt-library-help">名称与内容自动保存；修改会影响所有选用该语料的聊天，可先复制再修改。</small></label>
                <p id="extra-prompt-status" class="guidance-status" data-extra-prompt-status role="status" aria-live="polite"></p>
              </section>
            </div>
            <div class="prompt-editors"><div class="surface editor-card"><div class="editor-heading"><div><span class="eyebrow">TEMPLATE</span><h3>英文规范模板</h3></div><span class="editor-chip">可编辑</span></div><textarea data-prompt-template spellcheck="false" rows="16" aria-label="英文规范模板"></textarea><div class="editor-actions"><button class="button quiet" type="button" data-reset-prompt>恢复默认</button><button class="button primary" type="button" data-save-prompt>保存模板</button></div></div><div class="surface editor-card preview-card"><div class="editor-heading"><div><span class="eyebrow">LIVE PREVIEW</span><h3>当前聊天注入预览</h3></div><span class="editor-chip">实时更新</span></div><textarea data-prompt-preview readonly spellcheck="false" rows="16" aria-label="当前聊天注入预览"></textarea><div class="preview-caption">以已保存模板为基础，随角色、语气词与额外语料实时更新；其他酒馆宏在发送时处理。</div></div></div>
            <details class="help-details"><summary>注入位置、模板插槽与兼容说明</summary><div><p>默认深度 1，在最近一条聊天前加入系统指令；0 更靠后。关闭开关即移除注入。不会改写预设文件、TGbreak 其他模块或历史消息。</p><p>开启后，建议关闭手工重复添加的 TTS 规范条目；保留 TGbreak 其他约束；其 TTS 专用规则需同步为单份对白，避免仍要求重复原话。未绑定角色仍输出 New 标签，合成时跳过。后台生成和用户代写不注入。</p><p>可用插槽：<code>{{primary_character_note}}</code>、<code>{{bound_characters_section}}</code>、<code>{{skipped_characters_section}}</code>、<code>{{unbound_characters_section}}</code>、<code>{{vocal_events}}</code>、<code>{{vocal_event_example}}</code>、<code>{{user}}</code>。</p><p><code>{{vocal_events}}</code> 随上方语气词列表更新，<code>{{vocal_event_example}}</code> 为当前列表提供示例标签。自定义模板需保留这些插槽，才能跟随列表变化。额外语料直接追加为末尾第 6 条，无需在模板中添加插槽。</p><p>语料库在各聊天间共用；每个聊天单独保存选中的语料和启用状态。旧版已填写的额外语料会在打开对应聊天时自动存入语料库并保持绑定。关闭开关或选择“不使用语料”仍保留库中内容；删除会让所有选用它的聊天停止注入该语料。</p></div></details>
          </section>
          <section data-page="connection" id="page-connection" aria-label="连接与播放" hidden>
            <div class="surface connection-card"><div class="card-heading"><span class="section-icon">${icon('connection')}</span><div><h3>连接你的 Breeze</h3><p>使用原 TTS WebUI 的服务地址。</p></div></div><div class="connection-address"><label class="field">TTS / WebUI 地址<input data-setting="baseUrl" type="url" placeholder="http://127.0.0.1:7860" aria-label="TTS WebUI 地址"></label><button class="button primary" type="button" data-connect>保存并连接 ${icon('arrow')}</button></div></div>
            <div class="settings-columns"><div class="surface setting-card"><div class="card-heading"><span class="section-icon">${icon('play')}</span><div><h3>对白播放</h3><p>选择从文字到声音的方式。</p></div></div><label class="switch-row"><span><strong>启用语音气泡</strong><small>在带有 TTSVoice 标记的对白旁显示播放按钮。</small></span><input data-setting="enabled" type="checkbox" role="switch"><span class="switch" aria-hidden="true"></span></label><label class="switch-row"><span><strong>自动生成语音</strong><small>新回复完成后，为已绑定角色准备语音。</small></span><input data-setting="autoGenerate" type="checkbox" role="switch"><span class="switch" aria-hidden="true"></span></label><label class="switch-row"><span><strong>自动播放对白</strong><small>回复完成后，按对白顺序生成并播放。</small></span><input data-setting="autoPlay" type="checkbox" role="switch"><span class="switch" aria-hidden="true"></span></label><label class="switch-row"><span><strong>流式生成与播放</strong><small>边合成边播放，完成后保留完整音频供重播。仅预生成时仍保存完整音频。</small></span><input data-setting="streaming" type="checkbox" role="switch"><span class="switch" aria-hidden="true"></span></label><label class="switch-row"><span><strong>显示为对白与气泡</strong><small>开启时隐藏标签与已知语气词，显示完整对白；关闭时显示原始标签。</small></span><input data-setting="hideTags" type="checkbox" role="switch"><span class="switch" aria-hidden="true"></span></label><label class="volume-field"><span>播放音量 <output data-volume-value>80%</output></span><input data-setting="volume" type="range" min="0" max="1" step="0.05"></label></div><div class="settings-side"><div class="surface setting-card"><div class="card-heading"><span class="section-icon">${icon('voices')}</span><div><h3>合成参数</h3><p>用于对白与候选声音的生成。</p></div></div><label class="field">指令强度 · CFG<input data-setting="cfgScale" type="number" min="0.1" max="20" step="0.1"><small>控制模型对声音指令的遵循强度。</small></label><label class="field">随机种子<input data-setting="seed" type="number" min="0" max="4294967295" step="1"><small>设计多个候选时，种子依次递增。</small></label></div><div class="playback-help"><h3>播放小提示</h3><p>浏览器可能要求先手动点击一次播放。右键点击气泡，可清除该句缓存引用并在下次重新生成。</p><button class="button stop-button" type="button" data-stop>${icon('stop')} 停止队列与播放</button></div></div></div>
          </section>
        </main>
        <footer class="statusbar"><span class="status-icon" aria-hidden="true">${icon('voices')}</span><p data-status role="status" aria-live="polite">等待连接</p><span class="statusbar-brand">BREEZE STUDIO</span></footer>
      </div>`;
    root.append(stylesheet, dialog);
    document.body.append(host);

    let activeTab = 'characters';
    let opener = null;
    const select = tab => {
        activeTab = Object.hasOwn(pages, tab) ? tab : 'characters';
        for (const page of dialog.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== activeTab;
        for (const button of dialog.querySelectorAll('[data-tab]')) {
            const active = button.dataset.tab === activeTab;
            button.classList.toggle('active', active);
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        }
        dialog.querySelector('[data-page-title]').textContent = pages[activeTab][0];
        dialog.querySelector('[data-page-subtitle]').textContent = pages[activeTab][1];
        dialog.querySelector('.page-scroll').scrollTop = 0;
    };
    const close = () => { if (dialog.open) dialog.close(); };
    for (const button of dialog.querySelectorAll('[data-tab]')) button.addEventListener('click', () => select(button.dataset.tab));
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.addEventListener('close', () => {
        for (const audio of dialog.querySelectorAll('audio')) audio.pause();
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        opener = null;
    });
    select(activeTab);
    return {
        host, root, dialog, select, close,
        open(tab = 'characters') {
            select(tab);
            if (!dialog.open) {
                opener = document.activeElement;
                while (opener?.shadowRoot?.activeElement) opener = opener.shadowRoot.activeElement;
                dialog.showModal();
                dialog.querySelector(`[data-tab="${activeTab}"]`).focus({ preventScroll: true });
            }
        },
        get activeTab() { return activeTab; },
    };
}
