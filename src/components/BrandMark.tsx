import React from 'react';

// The ProfixBook mark: stock bars climbing into a P. Same drawing as
// public/logo.svg (the favicon and the source of every PNG icon), inlined
// here so it renders instantly at any size with no extra request.
export default function BrandMark({ size = 32, className, title }: {
  size?: number;
  className?: string;
  // Omit when a visible "ProfixBook" sits right beside it, so screen
  // readers don't hear the name twice.
  title?: string;
}) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 64 64" className={className}
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="#2563eb" />
      <rect x="10" y="38" width="8" height="14" rx="2" fill="#fff" fillOpacity="0.55" />
      <rect x="21" y="29" width="8" height="23" rx="2" fill="#fff" fillOpacity="0.78" />
      <path
        fill="#fff" fillRule="evenodd"
        d="M32 14C32 12.9 32.9 12 34 12H43C49.6 12 55 17 55 23.5C55 30 49.6 35 43 35H40V50C40 51.1 39.1 52 38 52H34C32.9 52 32 51.1 32 50Z M40 19.5V27.5H43C45.4 27.5 47.3 25.7 47.3 23.5C47.3 21.3 45.4 19.5 43 19.5Z"
      />
    </svg>
  );
}
