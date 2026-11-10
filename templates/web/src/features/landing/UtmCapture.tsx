'use client';
import { useEffect } from 'react';
import { captureUtmSource } from './utm';

/** Renders nothing; records the first-touch `utm_source` of a landing visit in the browser. */
export function UtmCapture() {
  useEffect(() => captureUtmSource(window.location.search), []);
  return null;
}
