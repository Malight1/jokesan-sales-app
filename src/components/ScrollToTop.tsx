import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// React Router doesn't reset scroll position on navigation — clicking a
// link while scrolled halfway down one page lands you halfway down the
// next one too. Mounted once near the router root so it covers the
// marketing site and the authenticated app in one place.
export default function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}
