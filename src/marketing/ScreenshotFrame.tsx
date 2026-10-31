import React from 'react';

// A plain browser-chrome frame around a real screenshot: real software,
// not marketing art. No device mockup asset, just three dots and a bar.
// Pass width/height (the image's real pixel size) so the browser reserves
// the space before it loads, and eager for anything above the fold.
export default function ScreenshotFrame({ src, alt, className = '', width, height, eager = false }: {
  src: string; alt: string; className?: string; width?: number; height?: number; eager?: boolean;
}) {
  return (
    <div className={`shot-frame ${className}`}>
      <div className="shot-frame__bar" aria-hidden="true">
        <span /><span /><span />
      </div>
      <img src={src} alt={alt} width={width} height={height}
           loading={eager ? 'eager' : 'lazy'} decoding="async" />
    </div>
  );
}

// An iPhone-style handset drawn in CSS: titanium edge, Dynamic Island,
// status bar, side buttons and home indicator. Everything scales with the
// frame's width (cqw), so one set of proportions works at any size.
export function PhoneFrame({ src, alt, className = '', width, height, eager = false }: {
  src: string; alt: string; className?: string; width?: number; height?: number; eager?: boolean;
}) {
  return (
    <div className={`phone-frame ${className}`}>
      <span className="phone-frame__btn phone-frame__btn--action" aria-hidden="true" />
      <span className="phone-frame__btn phone-frame__btn--up" aria-hidden="true" />
      <span className="phone-frame__btn phone-frame__btn--down" aria-hidden="true" />
      <span className="phone-frame__btn phone-frame__btn--power" aria-hidden="true" />
      <div className="phone-frame__body">
        <div className="phone-frame__screen">
          <div className="phone-frame__status" aria-hidden="true">
            <span className="phone-frame__time">9:41</span>
            <span className="phone-frame__island" />
            <svg className="phone-frame__icons" viewBox="0 0 66 12" fill="currentColor">
              <rect x="0" y="8" width="3" height="4" rx="0.8" />
              <rect x="5" y="5.5" width="3" height="6.5" rx="0.8" />
              <rect x="10" y="3" width="3" height="9" rx="0.8" />
              <rect x="15" y="0" width="3" height="12" rx="0.8" />
              <path d="M30 2.2c2.6 0 4.9 1 6.6 2.7l-1.2 1.2A7.9 7.9 0 0 0 30 3.9c-2.1 0-4.1.8-5.4 2.2l-1.2-1.200A9.400 9.400 0 0 1 30 2.200Zm0 3.400c1.700 0 3.200.700 4.300 1.800l-1.200 1.200A4.700 4.700 0 0 0 30 7.300c-1.200 0-2.300.500-3.100 1.300l-1.200-1.200A6.400 6.400 0 0 1 30 5.600Zm0 3.300c.8 0 1.500.3 2 .9L30 11.800l-2-2c.5-.6 1.200-.9 2-.9Z" />
              <rect x="42" y="0.5" width="21" height="11" rx="3.200" fill="none" stroke="currentColor" strokeOpacity="0.4" />
              <rect x="43.800" y="2.300" width="17.400" height="7.400" rx="1.800" />
              <rect x="64" y="4" width="1.600" height="4" rx="0.8" fillOpacity="0.4" />
            </svg>
          </div>
          <img src={src} alt={alt} width={width} height={height}
               loading={eager ? 'eager' : 'lazy'} decoding="async" />
          <span className="phone-frame__home" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
