import React from 'react';

export const DluflEmblem: React.FC<{ className?: string }> = ({ className = 'w-9 h-9' }) => (
  <svg
    className={className}
    viewBox="0 0 128 128"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="DLUFL Emblem"
  >
    <circle cx="64" cy="64" r="61" stroke="#0D386B" strokeWidth="4" fill="#FFFFFF" />
    <circle cx="64" cy="64" r="49" stroke="#0D386B" strokeWidth="1.5" strokeDasharray="3 3" />
    <path
      d="M35 84V44C35 41.79 36.79 40 39 40H57C61.42 40 64 43.2 64 47.5V86C64 82.8 60.8 81 56.5 81H38C36.34 81 35 82.34 35 84Z"
      fill="#0D386B"
    />
    <path
      d="M93 84V44C93 41.79 91.21 40 89 40H71C66.58 40 64 43.2 64 47.5V86C64 82.8 67.2 81 71.5 81H90C91.66 81 93 82.34 93 84Z"
      fill="#0D386B"
      fillOpacity="0.86"
    />
    <path d="M43 52H56M43 61H56M43 70H53" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
    <path d="M72 52H85M72 61H85M75 70H85" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
    <circle cx="64" cy="29" r="5" fill="#DF7900" />
    <path d="M46 96H82" stroke="#DF7900" strokeWidth="4" strokeLinecap="round" />
  </svg>
);
