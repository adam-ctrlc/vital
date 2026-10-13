import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

type AvatarUser = {
  firstName?: string;
  lastName?: string;
  username?: string;
  avatar?: string | null;
};

/** Initials from the name, else the username's first letter, so it is never blank. */
export function initialsOf(user: AvatarUser | null | undefined): string {
  const letters = `${user?.firstName?.trim()[0] ?? ''}${user?.lastName?.trim()[0] ?? ''}`;
  return (letters || user?.username?.[0] || '?').toUpperCase();
}

/** The person's photo, or their initials on a tinted circle. Size and colours come from the caller. */
export function UserAvatar({
  user,
  className,
  style,
}: {
  user: AvatarUser | null | undefined;
  className?: string;
  style?: CSSProperties;
}) {
  if (user?.avatar) {
    return <img src={user.avatar} alt="" className={cn('shrink-0 rounded-full object-cover', className)} />;
  }
  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full', className)} style={style}>
      {initialsOf(user)}
    </span>
  );
}
