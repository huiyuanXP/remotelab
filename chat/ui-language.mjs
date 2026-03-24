const SUPPORTED_UI_LANGUAGE_VALUES = new Set(['auto', 'en', 'zh-CN']);

export const DEFAULT_UI_LANGUAGE = 'auto';

export function normalizeUiLanguagePreference(value, { allowAuto = true } = {}) {
  if (typeof value !== 'string') return allowAuto ? DEFAULT_UI_LANGUAGE : 'en';
  const normalized = value.trim();
  if (!normalized) return allowAuto ? DEFAULT_UI_LANGUAGE : 'en';
  if (normalized === 'auto') return allowAuto ? 'auto' : 'en';
  if (/^zh(?:[-_](?:cn|hans))?$/i.test(normalized)) return 'zh-CN';
  if (/^en(?:[-_].*)?$/i.test(normalized)) return 'en';
  return allowAuto ? DEFAULT_UI_LANGUAGE : 'en';
}

export function isSupportedUiLanguagePreference(value, { allowAuto = true } = {}) {
  const normalized = normalizeUiLanguagePreference(value, { allowAuto });
  return SUPPORTED_UI_LANGUAGE_VALUES.has(normalized) && (allowAuto || normalized !== 'auto');
}

export function listSupportedUiLanguagePreferences({ includeAuto = true } = {}) {
  return includeAuto
    ? ['auto', 'zh-CN', 'en']
    : ['zh-CN', 'en'];
}
