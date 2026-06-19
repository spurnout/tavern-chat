import type { ComponentPropsWithoutRef } from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '../lib/cn.js';

/**
 * Tabs — thin wrappers over @radix-ui/react-tabs carrying the tavern pill
 * styling. Radix supplies the full WAI-ARIA tabs pattern for free: tab and
 * tabpanel `id`s wired together with `aria-controls`/`aria-labelledby`, roving
 * tabindex, and Arrow / Home / End keyboard navigation. A panel's children
 * render only while its tab is active — inactive panels keep just an empty,
 * `hidden` wrapper in the DOM — so panel components mount lazily and unmount on
 * switch exactly as the old `{active ? <Panel/> : null}` did. Any data fetch a
 * panel kicks off on mount therefore stays scoped to the active tab.
 *
 * `<Tabs>` is the controlled root (`value` / `onValueChange`); use `asChild` to
 * fold it onto an existing layout element rather than nesting an extra div.
 *
 *   <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} asChild>
 *     <div className="…">
 *       <TabList aria-label="…"><Tab value="a">A</Tab>…</TabList>
 *       <TabPanel value="a">…</TabPanel>
 *     </div>
 *   </Tabs>
 */
export const Tabs = RadixTabs.Root;
export const TabPanel = RadixTabs.Content;

export function TabList({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof RadixTabs.List>): JSX.Element {
  return (
    <RadixTabs.List
      // A crowded strip scrolls horizontally instead of crushing or clipping
      // its tabs (the responsive-overflow fix). `min-w-0` lets the list shrink
      // below its content inside a flex row so `overflow-x-auto` can take over;
      // `py-1 -my-1` keeps the strip's outer box the same height while giving
      // the keyboard focus ring vertical room (overflow-x coerces overflow-y to
      // `auto`, which would otherwise clip the ring's top/bottom).
      className={cn('flex min-w-0 gap-1 overflow-x-auto py-1 -my-1', className)}
      {...props}
    />
  );
}

export function Tab({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>): JSX.Element {
  return (
    <RadixTabs.Trigger
      // `shrink-0` keeps each tab at its natural width so the list scrolls
      // rather than compressing the tabs to illegibility.
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-fg-muted transition-colors hover:bg-raised data-[state=active]:bg-raised data-[state=active]:text-fg',
        className,
      )}
      {...props}
    />
  );
}
