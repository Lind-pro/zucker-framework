import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

/** Keyboard-navigable tabs (arrow keys move between triggers). */
export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  label,
  className,
}: {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  label: string;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root
      value={value}
      defaultValue={defaultValue ?? items[0]?.value}
      onValueChange={onValueChange}
      className={cn('min-w-0', className)}
    >
      <TabsPrimitive.List aria-label={label} className="flex max-w-full gap-1 overflow-x-auto border-b">
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className="-mb-px min-h-10 shrink-0 border-b-2 border-transparent px-3 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground"
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content key={item.value} value={item.value} className="pt-4 focus-visible:outline-none">
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
