import React from 'react';

// A plain browser-chrome frame around a real screenshot — real software,
// not marketing art. No device mockup asset, just three dots and a bar.
export default function ScreenshotFrame({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  return (
    <div className={`shot-frame ${className}`}>
      <div className="shot-frame__bar">
        <span /><span /><span />
      </div>
      <img src={src} alt={alt} loading="lazy" />
    </div>
  );
}
