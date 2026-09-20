import { normalizeTextFilters, DEFAULT_TEXT_FILTERS, MAX_TEXT_FILTER_RULES, MAX_TEXT_FILTER_LENGTH } from './text-filters.js';

let editorCount = 0;

/** Keep editable drafts local; the caller owns persistence and playback invalidation. */
export function createTextFilterEditor({ root, rules, onSave }) {
    const doc = root.ownerDocument;
    const make = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (label, className, attribute) => {
        const node = make('button', `button ${className}`, label);
        node.type = 'button';
        node.setAttribute(attribute, '');
        return node;
    };
    let draft = normalizeTextFilters(rules);
    const rows = make('div', 'text-filter-rows');
    rows.setAttribute('data-text-filter-rows', '');
    const empty = make('p', 'text-filter-empty', '尚无过滤规则。可以添加规则，或恢复默认的省略号规则。');
    const actions = make('div', 'text-filter-actions');
    const add = button('添加规则', 'secondary', 'data-add-text-filter');
    const count = make('span', 'text-filter-count');
    count.setAttribute('data-text-filter-count', '');
    const reset = button('恢复默认', 'quiet', 'data-reset-text-filters');
    const save = button('保存规则', 'primary', 'data-save-text-filters');
    actions.append(add, count, reset, save);
    const status = make('p', 'guidance-status text-filter-status');
    status.id = `breeze-text-filter-status-${++editorCount}`;
    status.setAttribute('data-text-filter-status', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', '文本过滤规则');
    root.replaceChildren(rows, empty, actions, status);

    const setStatus = (message, state = 'draft') => {
        status.textContent = message;
        status.dataset.state = state;
    };
    const changed = () => setStatus('尚未保存。点击“保存规则”后，对所有聊天生效。');
    const validationMessage = value => !value.trim()
        ? '请输入匹配文字，或删除空白规则。'
        : value.length > MAX_TEXT_FILTER_LENGTH ? `每条匹配文字最多 ${MAX_TEXT_FILTER_LENGTH} 个字符。` : '';
    const renderRows = () => {
        rows.replaceChildren();
        for (const [index, rule] of draft.entries()) {
            const row = make('div', 'text-filter-row');
            row.setAttribute('data-text-filter-row', '');
            row.setAttribute('role', 'group');
            row.setAttribute('aria-label', `过滤规则 ${index + 1}`);
            const enabledLabel = make('label', 'text-filter-enabled');
            const enabled = make('input');
            enabled.type = 'checkbox';
            enabled.checked = rule.enabled;
            enabled.setAttribute('data-text-filter-enabled', '');
            enabledLabel.append(enabled, make('span', '', '启用'));
            enabled.addEventListener('change', () => { rule.enabled = enabled.checked; changed(); });
            const matchLabel = make('label', 'field text-filter-match');
            const input = make('input');
            input.type = 'text';
            input.value = rule.text;
            input.maxLength = MAX_TEXT_FILTER_LENGTH;
            input.required = true;
            input.spellcheck = false;
            input.placeholder = '例如：……';
            input.setAttribute('data-text-filter-match', '');
            input.setAttribute('aria-describedby', status.id);
            matchLabel.append(make('span', '', '匹配文字'), input);
            input.addEventListener('input', () => {
                rule.text = input.value;
                input.setCustomValidity('');
                input.removeAttribute('aria-invalid');
                changed();
            });
            const replacement = make('span', 'text-filter-replacement', '替换为空格');
            const remove = button('删除', 'quiet text-filter-delete', 'data-delete-text-filter');
            remove.setAttribute('aria-label', `删除规则 ${index + 1}`);
            remove.addEventListener('click', () => {
                draft.splice(index, 1);
                renderRows();
                changed();
                const next = rows.children[Math.min(index, draft.length - 1)];
                (next?.querySelector('[data-delete-text-filter]') || add).focus();
            });
            row.append(enabledLabel, matchLabel, replacement, remove);
            rows.append(row);
        }
        empty.hidden = draft.length !== 0;
        add.disabled = draft.length >= MAX_TEXT_FILTER_RULES;
        count.textContent = `${draft.length} / ${MAX_TEXT_FILTER_RULES} 条`;
        add.title = add.disabled ? `最多添加 ${MAX_TEXT_FILTER_RULES} 条规则` : '添加一条文字匹配规则';
    };
    add.addEventListener('click', () => {
        if (draft.length >= MAX_TEXT_FILTER_RULES) return;
        draft.push({ text: '', enabled: true });
        renderRows();
        changed();
        rows.lastElementChild.querySelector('[data-text-filter-match]').focus();
    });
    reset.addEventListener('click', () => {
        draft = normalizeTextFilters(DEFAULT_TEXT_FILTERS);
        renderRows();
        setStatus('已恢复默认规则草稿：将 …… 替换为空格。点击“保存规则”后生效。');
    });
    save.addEventListener('click', () => {
        let firstInvalid = null;
        for (const input of rows.querySelectorAll('[data-text-filter-match]')) {
            const message = validationMessage(input.value);
            input.setCustomValidity(message);
            if (message) {
                input.setAttribute('aria-invalid', 'true');
                firstInvalid ||= input;
            } else input.removeAttribute('aria-invalid');
        }
        if (firstInvalid) {
            setStatus(firstInvalid.validationMessage, 'error');
            firstInvalid.focus();
            firstInvalid.reportValidity();
            return;
        }
        try {
            onSave(normalizeTextFilters(draft));
            setStatus('已保存。规则对所有聊天的角色对白与旁白合成生效。', 'saved');
        } catch (error) {
            setStatus(`保存失败：${error.message || '请重试。'}`, 'error');
        }
    });
    renderRows();
    setStatus(`按列表顺序匹配完整文字，不使用正则表达式。每条最多 ${MAX_TEXT_FILTER_LENGTH} 个字符。`, 'ready');
    return {
        setRules(value) {
            draft = normalizeTextFilters(value);
            renderRows();
            setStatus('已载入保存的规则。', 'ready');
        },
    };
}
