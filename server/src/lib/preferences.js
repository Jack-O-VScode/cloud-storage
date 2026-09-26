// Curated so the font picker can't be used to inject arbitrary CSS - the
// server only ever accepts a name from this exact list.
export const FONT_OPTIONS = [
  'system',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Trebuchet MS',
  'Arial',
  'Helvetica',
];

// Color fields default to '' (no override) rather than a hardcoded hex, so
// "no custom theme yet" is a real, distinguishable state - the app then
// falls back to the built-in light/dark theme that follows the OS, the
// same thing the "System" preset restores.
export const DEFAULT_PREFERENCES = {
  backgroundMode: 'solid', // 'solid' | 'gradient'
  backgroundColor: '',
  backgroundColorTop: '',
  backgroundColorBottom: '',
  barColor: '',
  accentColor: '',
  buttonStyle: 'solid', // 'solid' | 'glass'
  fontFamily: 'system',
  textSize: 'normal', // 'small' | 'normal' | 'large'
  compressImages: false, // re-encode/downsize large photos on upload to save space
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const COLOR_KEYS = ['backgroundColor', 'backgroundColorTop', 'backgroundColorBottom', 'barColor', 'accentColor'];

export function defaultPreferences() {
  return { ...DEFAULT_PREFERENCES };
}

// Only ever returns fields that passed validation - callers merge this over
// existing preferences, so an invalid/missing field just leaves the
// current value in place rather than erroring the whole request. An empty
// string is explicitly valid for a color field - it means "clear this
// override", not "invalid".
export function sanitizePreferences(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;

  if (input.backgroundMode === 'solid' || input.backgroundMode === 'gradient') {
    out.backgroundMode = input.backgroundMode;
  }
  for (const key of COLOR_KEYS) {
    if (typeof input[key] === 'string' && (input[key] === '' || HEX_RE.test(input[key]))) out[key] = input[key];
  }
  if (input.buttonStyle === 'solid' || input.buttonStyle === 'glass') {
    out.buttonStyle = input.buttonStyle;
  }
  if (typeof input.fontFamily === 'string' && FONT_OPTIONS.includes(input.fontFamily)) {
    out.fontFamily = input.fontFamily;
  }
  if (input.textSize === 'small' || input.textSize === 'normal' || input.textSize === 'large') {
    out.textSize = input.textSize;
  }
  if (typeof input.compressImages === 'boolean') {
    out.compressImages = input.compressImages;
  }
  return out;
}
