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

// The same idea for a phone: a rounded bezel, nothing pretending to be a
// specific handset.
export function PhoneFrame({ src, alt, className = '', width, height, eager = false }: {
  src: string; alt: string; className?: string; width?: number; height?: number; eager?: boolean;
}) {
  return (
    <div className={`phone-frame ${className}`}>
      <img src={src} alt={alt} width={width} height={height}
           loading={eager ? 'eager' : 'lazy'} decoding="async" />
    </div>
  );
}
