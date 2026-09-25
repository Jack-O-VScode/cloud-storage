import React, { useState } from 'react';
import Modal from './Modal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { PRESETS, FONT_OPTIONS } from '../utils/theme.js';

const CLEAR_COLORS = {
  backgroundColor: '',
  backgroundColorTop: '',
  backgroundColorBottom: '',
  barColor: '',
  accentColor: '',
};

function ColorField({ label, value, onChange }) {
  return (
    <div className="color-field">
      <input
        type="color"
        className="color-swatch"
        value={value || '#000000'}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      <span className="muted small color-hex">{value || 'default'}</span>
    </div>
  );
}

export default function SettingsModal({ onClose }) {
  const { user, updatePreferences } = useAuth();
  const [prefs, setPrefs] = useState(user.preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (patch) => {
    setPrefs((p) => ({ ...p, ...patch }));
    setSaving(true);
    setError('');
    try {
      const updated = await updatePreferences(patch);
      setPrefs(updated.preferences);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = (name) => save(PRESETS[name] || CLEAR_COLORS);

  return (
    <Modal title="App settings" onClose={onClose} width={560} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="settings-section-header">
        <h4>App theme colour</h4>
        <button className="link-btn" onClick={() => applyPreset('System')} disabled={saving}>
          Reset
        </button>
      </div>
      <p className="muted small">
        Colours are saved to your account, so they follow you to other devices. Text and borders are worked out
        automatically from what you pick, so nothing ends up unreadable.
      </p>

      <div className="settings-row">
        <div>
          <label className="field-label">Background colour</label>
          <p className="muted small">The page behind your files.</p>
        </div>
        <div className="segmented">
          <button
            className={prefs.backgroundMode === 'solid' ? 'active' : ''}
            onClick={() => save({ backgroundMode: 'solid' })}
          >
            Solid
          </button>
          <button
            className={prefs.backgroundMode === 'gradient' ? 'active' : ''}
            onClick={() => save({ backgroundMode: 'gradient' })}
          >
            Gradient
          </button>
        </div>
      </div>

      {prefs.backgroundMode === 'gradient' ? (
        <div className="settings-row">
          <span className="muted small">Top</span>
          <ColorField
            label="Background top"
            value={prefs.backgroundColorTop}
            onChange={(v) => save({ backgroundColorTop: v })}
          />
          <span className="muted small">Bottom</span>
          <ColorField
            label="Background bottom"
            value={prefs.backgroundColorBottom}
            onChange={(v) => save({ backgroundColorBottom: v })}
          />
        </div>
      ) : (
        <div className="settings-row">
          <span />
          <ColorField label="Background" value={prefs.backgroundColor} onChange={(v) => save({ backgroundColor: v })} />
        </div>
      )}

      <div className="settings-row">
        <div>
          <label className="field-label">Bar colour</label>
          <p className="muted small">The sidebar and its menus.</p>
        </div>
        <ColorField label="Bar colour" value={prefs.barColor} onChange={(v) => save({ barColor: v })} />
      </div>

      <div className="settings-row">
        <div>
          <label className="field-label">Accent colour</label>
          <p className="muted small">Buttons, the active page, progress bars.</p>
        </div>
        <ColorField label="Accent colour" value={prefs.accentColor} onChange={(v) => save({ accentColor: v })} />
      </div>

      <div className="preset-chips">
        {Object.keys(PRESETS).map((name) => (
          <button key={name} className="preset-chip" onClick={() => applyPreset(name)}>
            {name}
          </button>
        ))}
      </div>

      <hr className="divider" />

      <h4>Look and text</h4>

      <div className="settings-row">
        <div>
          <label className="field-label">Buttons</label>
          <p className="muted small">Glass frosts buttons and bars and blurs what's behind them.</p>
        </div>
        <div className="segmented">
          <button className={prefs.buttonStyle === 'glass' ? 'active' : ''} onClick={() => save({ buttonStyle: 'glass' })}>
            Glass
          </button>
          <button className={prefs.buttonStyle === 'solid' ? 'active' : ''} onClick={() => save({ buttonStyle: 'solid' })}>
            Solid
          </button>
        </div>
      </div>

      <div className="settings-row">
        <label className="field-label">Font</label>
        <select
          className="text-input settings-select"
          value={prefs.fontFamily}
          onChange={(e) => save({ fontFamily: e.target.value })}
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-row">
        <label className="field-label">Text size</label>
        <div className="segmented">
          {['small', 'normal', 'large'].map((size) => (
            <button key={size} className={prefs.textSize === size ? 'active' : ''} onClick={() => save({ textSize: size })}>
              {size[0].toUpperCase() + size.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}
