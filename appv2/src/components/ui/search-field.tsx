import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

type SearchFieldProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

export function SearchField({ value, onValueChange, placeholder, className }: SearchFieldProps) {
  return (
    <div
      className={cn(
        'border-input bg-background dark:bg-input/30 flex h-10 min-w-0 items-center gap-2 rounded-md border px-3 shadow-sm shadow-black/5 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 sm:h-9',
        className
      )}>
      <MagnifyingGlassIcon size={16} className="text-muted-foreground shrink-0" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder ?? 'Search'}
        className="placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent text-base outline-none md:text-sm [&::-webkit-search-cancel-button]:hidden"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label="Clear search"
          className="text-muted-foreground hover:text-foreground -m-2 cursor-pointer p-2"
          onClick={() => onValueChange('')}>
          <XIcon size={16} weight="bold" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
