// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// react-router v7 pulls in its server-runtime crypto helpers at import time,
// which touch TextEncoder/TextDecoder. The jsdom bundled with CRA 5's Jest 27
// doesn't expose either as a global, so importing the router in a test threw
// before a single assertion ran. Node has both — hand them to jsdom.
import { TextEncoder, TextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = TextDecoder as typeof global.TextDecoder;
}
