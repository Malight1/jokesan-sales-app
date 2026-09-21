import { useEffect } from 'react';

const DEFAULT_TITLE = 'StockFlow: Inventory and Sales for African SMEs';
const DEFAULT_DESCRIPTION = "StockFlow: know your real profit, track stock, and chase debtors on WhatsApp. Inventory and sales for African manufacturing SMEs.";

const setMetaTag = (name: string, content: string, attr: 'name' | 'property' = 'name') => {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attr, name);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
};

// A hand-rolled stand-in for react-helmet. CRA has no server-side
// rendering, so a crawler that doesn't execute JavaScript never sees any
// of this anyway. It's still worth doing: a real browser tab, a shared
// link's preview, and a crawler that DOES execute JS all benefit. Resets
// to the app's own default title/description on unmount, so navigating
// from a marketing page into the authenticated app doesn't leave a stale
// marketing title behind.
export default function useMeta(title: string, description: string) {
  useEffect(() => {
    document.title = title;
    setMetaTag('description', description);
    setMetaTag('og:title', title, 'property');
    setMetaTag('og:description', description, 'property');

    const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
      ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'canonical' }));
    canonical.setAttribute('href', window.location.origin + window.location.pathname);

    return () => {
      document.title = DEFAULT_TITLE;
      setMetaTag('description', DEFAULT_DESCRIPTION);
      setMetaTag('og:title', DEFAULT_TITLE, 'property');
      setMetaTag('og:description', DEFAULT_DESCRIPTION, 'property');
    };
  }, [title, description]);
}
