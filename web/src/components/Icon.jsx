import React from 'react';

const COLORS = {
  folder: '#5b9bd5',
  image: '#e0714a',
  video: '#8b5cf6',
  audio: '#ec4899',
  pdf: '#e0454a',
  archive: '#a3852b',
  doc: '#2f6fed',
  sheet: '#1f9d55',
  slides: '#e0a72e',
  code: '#4b5563',
  file: '#7c8a99',
};

export default function Icon({ category, size = 20 }) {
  const color = COLORS[category] || COLORS.file;
  if (category === 'folder') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path
          d="M3 6a2 2 0 0 1 2-2h4.5l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"
          fill={color}
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill="white"
        stroke={color}
        strokeWidth="1.5"
      />
      <path d="M14 2v4a1 1 0 0 0 1 1h4" fill="none" stroke={color} strokeWidth="1.5" />
      <rect x="7.5" y="12" width="9" height="2" rx="1" fill={color} />
      <rect x="7.5" y="16" width="6" height="2" rx="1" fill={color} opacity="0.7" />
    </svg>
  );
}
