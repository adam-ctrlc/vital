import { useColorScheme } from 'nativewind';
import X from 'phosphor-react-native/src/icons/X';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type BottomSheetProps = {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * The height the on-screen keyboard currently occupies, or zero.
 *
 * Only consumed on iOS. See the `lift` comment below for why Android wants nothing.
 */
function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    // iOS emits the Will events in step with its own animation, so the sheet travels
    // with the keyboard rather than after it. Android only reports the Did events.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(showEvent, (event) =>
      setKeyboardHeight(event.endCoordinates.height)
    );
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));

    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return keyboardHeight;
}

export function BottomSheet({ visible, title, onClose, children }: BottomSheetProps) {
  const { colorScheme } = useColorScheme();
  const { height } = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();
  const insets = useSafeAreaInsets();
  const fg = colorScheme === 'dark' ? '#fafafa' : '#0a0a0a';

  // The sheet is pinned to the bottom of an edge-to-edge window, so without this its
  // last row sits behind the navigation bar: visible, but not reachable by a tap.
  //
  // Dropped while the keyboard is up, because the keyboard already occupies that strip
  // and the inset would only open a gap under the fields.
  const bottomInset = keyboardHeight > 0 ? 0 : insets.bottom;

  // Android resizes the modal window for the keyboard, so the sheet is already sitting
  // above it and useWindowDimensions already reports the reduced height. Lifting again
  // there left a gap exactly one keyboard tall. iOS does not resize a modal window, so
  // it is the platform that actually needs the offset.
  //
  // KeyboardAvoidingView is deliberately not used: with the window already resized its
  // 'height' behavior shortened the container a second time, which is what buried the
  // account form under the keyboard to begin with.
  const lift = Platform.OS === 'ios' ? keyboardHeight : 0;

  // Only subtract what was actually added, or the sheet loses height it still has.
  const available = height - lift;

  // A hidden Modal still mounts its children, which kept the sheet's contents
  // (including WebViews) live and re-rendering behind every screen.
  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable className="absolute inset-0 bg-black/50" accessibilityLabel="Close" onPress={onClose} />
        <View
          style={{ maxHeight: available * 0.9, marginBottom: lift }}
          className="overflow-hidden rounded-t-3xl border border-border bg-card">
          <View className="flex-row items-center justify-between px-5 pb-2 pt-5">
            <Text className="text-lg font-semibold">{title}</Text>
            <Button variant="ghost" size="icon" accessibilityLabel="Close" onPress={onClose}>
              <X size={20} weight="bold" color={fg} />
            </Button>
          </View>
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerClassName="gap-5 px-5 pt-1"
            // Padding rather than a margin, so the card's own surface still runs to the
            // bottom of the screen and the navigation bar sits over the sheet instead of
            // over a gap.
            contentContainerStyle={{ paddingBottom: bottomInset + 32 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator
            persistentScrollbar>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
