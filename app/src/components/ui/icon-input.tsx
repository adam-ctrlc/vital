import { useColorScheme } from 'nativewind';
import { Pressable, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type PhosphorIcon = React.ComponentType<{ size?: number; color?: string; weight?: 'bold' | 'fill' }>;

// RefAttributes so a caller can hold the field and move focus to it, which is what makes
// a "next" key on the keyboard actually go somewhere. React 19 passes ref through as an
// ordinary prop, so the spread onto TextInput below is all the wiring it needs.
type IconInputProps = React.ComponentProps<typeof TextInput> &
  React.RefAttributes<TextInput> & {
    icon: PhosphorIcon;
    iconColor?: string;
    unit?: string;
    containerClassName?: string;
    /** Tappable affordance rendered inside the field, after the text. */
    action?: {
      icon: PhosphorIcon;
      label: string;
      onPress: () => void;
    };
  };

/**
 * Like SearchField, the wrapper owns the fill and border and the TextInput is
 * transparent, so the icon well and the text never render as two surfaces.
 */
export function IconInput({
  icon: Icon,
  iconColor,
  unit,
  containerClassName,
  action,
  editable = true,
  ...props
}: IconInputProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const muted = isDark ? '#a1a1aa' : '#71717a';

  return (
    <View
      className={cn(
        'border-input bg-muted/40 dark:bg-input/30 h-11 flex-row items-center gap-2 rounded-md border px-3',
        !editable && 'opacity-60',
        containerClassName
      )}>
      <Icon size={18} weight="bold" color={editable ? (iconColor ?? muted) : muted} />
      <TextInput
        editable={editable}
        placeholderTextColor={muted}
        className="text-foreground h-full flex-1 border-0 bg-transparent p-0 text-base leading-5"
        {...props}
      />
      {unit ? (
        <Text variant="muted" className="text-xs font-medium">
          {unit}
        </Text>
      ) : null}
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={8}
          onPress={action.onPress}>
          <action.icon size={16} weight="bold" color={muted} />
        </Pressable>
      ) : null}
    </View>
  );
}
