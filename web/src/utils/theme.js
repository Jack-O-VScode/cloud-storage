export const FONT_OPTIONS = [
  { value: 'system', label: 'System default' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
];

const SYSTEM_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Named after the reference app that inspired this feature - color-only
// presets, independent of the separate button-style/font/text-size choices.
export const PRESETS = {
  System: null, // clears custom colors entirely, falls back to the built-in light/dark theme
  Ink: {
    backgroundMode: 'solid',
    backgroundColor: '#111318',
    barColor: '#1a1c22',
    accentColor: '#5b8bf0',
  },
  Paper: {
    backgroundMode: 'solid',
    backgroundColor: '#faf8f3',
    barColor: '#ffffff',
    accentColor: '#8a6d3b',
  },
  Ocean: {
    backgroundMode: 'gradient',
    backgroundColorTop: '#0f2a4a',
    backgroundColorBottom: '#1c6e8c',
    barColor: '#0f2a4a',
    accentColor: '#4fc3d9',
  },
  Forest: {
    backgroundMode: 'solid',
    backgroundColor: '#12261c',
    barColor: '#173023',
    accentColor: '#4caf7d',
  },
  Plum: {
    backgroundMode: 'gradient',
    backgroundColorTop: '#000000',
    backgroundColorBottom: '#61187c',
    barColor: '#3a1049',
    accentColor: '#c96bd8',
  },
  Slate: {
    backgroundMode: 'solid',
    backgroundColor: '#2b2f38',
    barColor: '#343a45',
    accentColor: '#8fa3bf',
  },
  Dawn: {
    backgroundMode: 'gradient',
    backgroundColorTop: '#3a1c4b',
    backgroundColorBottom: '#d97a6c',
    barColor: '#3a1c4b',
    accentColor: '#f2a65a',
  },
  Dusk: {
    backgroundMode: 'gradient',
    backgroundColorTop: '#141a35',
    backgroundColorBottom: '#3c3f68',
    barColor: '#141a35',
    accentColor: '#7d86c9',
  },
};

const TEXT_SIZE_REM = { small: '87.5%', normal: '100%', large: '112.5%' };

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// WCAG-ish relative luminance, used to pick readable black/white text and
// borders for whatever background/bar/accent color the user chooses.
export function contrastColor(hex, dark = '#1c1f24', light = '#ffffff') {
  const rgb = hexToRgb(hex);
  if (!rgb) return dark;
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? dark : light;
}

// Keeps the browser's own chrome (the tab/toolbar tint on Android Chrome,
// an installed PWA's title bar on Windows) in step with whatever bar color
// is actually showing, instead of the static color baked into index.html/
// the manifest at build time - falls back to the built-in theme's own bar
// color for whichever OS light/dark mode is active.
function updateThemeColorMeta(preferences) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  if (preferences.barColor) {
    meta.setAttribute('content', preferences.barColor);
    return;
  }
  const prefersDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  meta.setAttribute('content', prefersDark ? '#16181d' : '#fbfbfc');
}

// Sets/clears a small set of `--user-*` custom properties that every
// consuming CSS rule reads with a fallback, e.g. `var(--user-accent-bg,
// var(--primary))` - so leaving a property unset (System preset) means the
// built-in light/dark theme applies exactly as before, with no separate
// "is a custom theme active" branch needed in the stylesheet.
export function applyTheme(preferences) {
  const root = document.documentElement;
  if (!preferences) return;

  const hasCustomColors = Boolean(
    preferences.backgroundColor || preferences.backgroundColorTop || preferences.backgroundColorBottom
  );

  if (hasCustomColors) {
    const pageBg =
      preferences.backgroundMode === 'gradient'
        ? `linear-gradient(160deg, ${preferences.backgroundColorTop}, ${preferences.backgroundColorBottom})`
        : preferences.backgroundColor;
    const pageBgSolidForContrast =
      preferences.backgroundMode === 'gradient' ? preferences.backgroundColorTop : preferences.backgroundColor;

    root.style.setProperty('--user-page-bg', pageBg);
    root.style.setProperty('--user-page-text', contrastColor(pageBgSolidForContrast));
    root.style.setProperty('--user-bar-bg', preferences.barColor);
    root.style.setProperty('--user-bar-text', contrastColor(preferences.barColor));
    root.style.setProperty('--user-accent-bg', preferences.accentColor);
    root.style.setProperty('--user-accent-text', contrastColor(preferences.accentColor));
  } else {
    for (const prop of ['--user-page-bg', '--user-page-text', '--user-bar-bg', '--user-bar-text', '--user-accent-bg', '--user-accent-text']) {
      root.style.removeProperty(prop);
    }
  }

  root.setAttribute('data-button-style', preferences.buttonStyle === 'glass' ? 'glass' : 'solid');

  const font = FONT_OPTIONS.find((f) => f.value === preferences.fontFamily);
  if (font && font.value !== 'system') {
    root.style.setProperty('--user-font', `"${font.value}", ${SYSTEM_FONT_STACK}`);
  } else {
    root.style.removeProperty('--user-font');
  }

  root.style.fontSize = TEXT_SIZE_REM[preferences.textSize] || TEXT_SIZE_REM.normal;

  updateThemeColorMeta(preferences);
}
