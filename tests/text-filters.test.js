import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEXT_FILTERS, MAX_TEXT_FILTER_RULES, MAX_TEXT_FILTER_LENGTH,
    normalizeTextFilters, applyTextFilters } from '../text-filters.js';

test('defaults contain only the literal double ellipsis and are deeply frozen', () => {
    assert.deepEqual(DEFAULT_TEXT_FILTERS, [{ text: '\u2026\u2026', enabled: true }]);
    assert.ok(Object.isFrozen(DEFAULT_TEXT_FILTERS));
    assert.ok(Object.isFrozen(DEFAULT_TEXT_FILTERS[0]));
    assert.equal(applyTextFilters('等……再……说'), '等 再 说');
    assert.equal(applyTextFilters('… ... *星号* _下划线_ `代码` [笑]'), '… ... *星号* _下划线_ `代码` [笑]');
});

test('missing or malformed settings return independent copies of defaults', () => {
    for (const value of [undefined, null, false, 0, '……', {}]) {
        const first = normalizeTextFilters(value);
        const second = normalizeTextFilters(value);
        assert.deepEqual(first, DEFAULT_TEXT_FILTERS);
        assert.notEqual(first, DEFAULT_TEXT_FILTERS);
        assert.notEqual(first, second);
        assert.notEqual(first[0], second[0]);
        first[0].text = 'changed';
        assert.deepEqual(second, DEFAULT_TEXT_FILTERS);
    }
});

test('explicit empty settings and arrays with no valid entries disable all filters', () => {
    for (const rules of [[], [null, '……', { text: '' }, { text: ' \t\n' }]]) {
        assert.deepEqual(normalizeTextFilters(rules), []);
        assert.equal(applyTextFilters('原……文', rules), '原……文');
    }
});

test('normalization preserves literal whitespace, ignores malformed entries, and defaults enabled to true', () => {
    const input = [null, true, 'text', [], { text: 4 }, { text: '' }, { text: ' \t\n' },
        { text: '  literal\t ', extra: 'ignored' }, { text: 'off', enabled: false },
        { text: 'zero', enabled: 0 }, { text: 'null', enabled: null }, { text: 'string', enabled: 'false' }];
    const before = structuredClone(input);
    assert.deepEqual(normalizeTextFilters(input), [
        { text: '  literal\t ', enabled: true }, { text: 'off', enabled: false },
        { text: 'zero', enabled: true }, { text: 'null', enabled: true }, { text: 'string', enabled: true },
    ]);
    assert.deepEqual(input, before);
    assert.equal(applyTextFilters('off zero null string', input), 'off      ');
});

test('normalization caps accepted rules and rejects overlong text without truncating it', () => {
    assert.equal(MAX_TEXT_FILTER_RULES, 64);
    assert.equal(MAX_TEXT_FILTER_LENGTH, 500);
    const limit = 'x'.repeat(MAX_TEXT_FILTER_LENGTH);
    assert.deepEqual(normalizeTextFilters([{ text: `${limit}y` }, { text: limit }]), [
        { text: limit, enabled: true },
    ]);
    const input = [null, ...Array.from({ length: MAX_TEXT_FILTER_RULES + 2 }, (_, i) => ({ text: `rule ${i}` }))];
    const normalized = normalizeTextFilters(input);
    assert.equal(normalized.length, MAX_TEXT_FILTER_RULES);
    assert.equal(normalized.at(-1).text, 'rule 63');
    assert.equal(input.length, MAX_TEXT_FILTER_RULES + 3);
});

test('filter matching is literal for regex syntax and replacement-like characters', () => {
    const tokens = ['.*', '[笑]', '(a|b)', '\\d+', '^$', '$&', '$`', "$'", '$$'];
    for (const token of tokens) {
        assert.equal(applyTextFilters(`前${token}中${token}后`, [{ text: token }]), '前 中 后');
    }
    assert.equal(applyTextFilters('ab a b 123', [{ text: '(a|b)' }, { text: '\\d+' }]), 'ab a b 123');
});

test('filters preserve unmatched whitespace and vocal tags unless explicitly matched', () => {
    const input = '  你好……\t [笑] [叹气]\n尾声  ';
    assert.equal(applyTextFilters(input), '  你好 \t [笑] [叹气]\n尾声  ');
    assert.equal(applyTextFilters(input, [{ text: '[笑]' }]), '  你好……\t   [叹气]\n尾声  ');
    assert.equal(applyTextFilters('x  literal\t y literal z', [{ text: '  literal\t ' }]), 'x y literal z');
});

test('every nonoverlapping occurrence becomes one space, including whitespace-only results', () => {
    assert.equal(applyTextFilters('……'), ' ');
    assert.equal(applyTextFilters('…………'), '  ');
    assert.equal(applyTextFilters('…… \t……'), '  \t ');
    assert.equal(applyTextFilters('aaa', [{ text: 'aa' }]), ' a');
    assert.equal(applyTextFilters(''), '');
});

test('rule order is respected and later rules can match spaces introduced earlier', () => {
    const first = [{ text: 'a' }, { text: ' b' }];
    assert.equal(applyTextFilters('ab', first), ' ');
    assert.equal(applyTextFilters('ab', [...first].reverse()), ' b');
    assert.equal(applyTextFilters('ab', [{ text: 'a', enabled: false }, { text: ' b' }]), 'ab');
});

test('normalizing and applying rules never mutate caller settings', () => {
    const input = Object.freeze([
        Object.freeze({ text: '……', enabled: false }),
        Object.freeze({ text: '[笑]' }),
    ]);
    const normalized = normalizeTextFilters(input);
    assert.notEqual(normalized, input);
    assert.notEqual(normalized[0], input[0]);
    normalized[0].enabled = true;
    assert.equal(applyTextFilters('……[笑]', input), '…… ');
    assert.deepEqual(input, [{ text: '……', enabled: false }, { text: '[笑]' }]);
});
