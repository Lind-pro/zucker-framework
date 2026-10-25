'use client';

import type { ComponentProps, MouseEvent } from 'react';
import { Link } from '@/i18n/navigation';

/** A fresh document prevents marketing SDKs from following visitors into account forms. */
export function AccountLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.location.assign(event.currentTarget.href);
  }} />;
}
