import { CaretLeftIcon, type Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** The title row at the top of every page. */
export function PageHeader({
  icon: TitleIcon,
  iconColor,
  title,
  actions,
  back,
}: {
  icon?: Icon;
  iconColor?: string;
  title: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <header className="flex items-center gap-2">
      {back ? (
        <Link
          to={back.to}
          aria-label={back.label}
          className="hover:bg-accent -ml-2 grid size-8 place-items-center rounded-full transition-colors">
          <CaretLeftIcon size={18} weight="bold" aria-hidden="true" />
        </Link>
      ) : null}
      {TitleIcon ? <TitleIcon size={22} weight="fill" color={iconColor} aria-hidden="true" /> : null}
      <h1 className="flex-1 text-lg font-bold tracking-tight">{title}</h1>
      {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
    </header>
  );
}
