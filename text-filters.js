export const MAX_TEXT_FILTER_RULES = 64;
export const MAX_TEXT_FILTER_LENGTH = 500;

export const DEFAULT_TEXT_FILTERS = Object.freeze([
    Object.freeze({ text: '……', enabled: true }),
]);

export function normalizeTextFilters(value) {
    const source = Array.isArray(value) ? value : DEFAULT_TEXT_FILTERS;
    const rules = [];
    for (const entry of source) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || typeof entry.text !== 'string' || !entry.text.trim()
            || entry.text.length > MAX_TEXT_FILTER_LENGTH) continue;
        rules.push({ text: entry.text, enabled: entry.enabled !== false });
        if (rules.length === MAX_TEXT_FILTER_RULES) break;
    }
    return rules;
}

export function applyTextFilters(text, rules) {
    let result = String(text ?? '');
    for (const rule of normalizeTextFilters(rules)) {
        // Split/join treats every rule literally, including regex characters.
        if (rule.enabled) result = result.split(rule.text).join(' ');
    }
    return result;
}
