import type { Icon } from '@phosphor-icons/react';

/** Nav icon with an optional unread dot pinned to its top-right corner. */
export function TabIcon({ icon: TabGlyph, color, dot = false }: { icon: Icon; color?: string; dot?: boolean }) {
  return (
    <span className="relative inline-flex">
      <TabGlyph size={22} weight="bold" color={color} aria-hidden="true" />
      {dot ? (
        <span
          aria-label="Has new activity"
          className="border-background absolute -right-1 -top-0.5 size-2.5 rounded-full border-2 bg-red-500"
        />
      ) : null}
    </span>
  );
}
