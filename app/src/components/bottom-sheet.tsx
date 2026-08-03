import { useColorScheme } from 'nativewind';
import X from 'phosphor-react-native/src/icons/X';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
 * Where the top of the on-screen keyboard is, in screen coordinates, or null when it
 * is closed.
 *
 * The position rather than the height, because that is what can be compared against
 * the sheet's own measured position. Whether the modal window resizes for the keyboard
 * turns out to vary, and guessing that rule wrongly puts the form either under the
 * keyboard or a full keyboard's height above it. Measuring sidesteps the question.
 */
function useKeyboardTop() {
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);

  useEffect(() => {
    // iOS emits the Will events in step with its own animation, so the sheet travels
    // with the keyboard rather than after it. Android only reports the Did events.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(showEvent, (event) =>
      setKeyboardTop(event.endCoordinates.screenY)
    );
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardTop(null));

    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return keyboardTop;
}

export function BottomSheet({ visible, title, onClose, children }: BottomSheetProps) {
  const { colorScheme } = useColorScheme();
  const { height } = useWindowDimensions();
  const keyboardTop = useKeyboardTop();
  const insets = useSafeAreaInsets();
  const fg = colorScheme === 'dark' ? '#fafafa' : '#0a0a0a';

  const sheet = useRef<View>(null);
  const [lift, setLift] = useState(0);
  // Guards against re-measuring after the lift has been applied. The lift moves the
  // sheet clear of the keyboard, so a second measurement would read no overlap, remove
  // the lift, and start the whole thing oscillating.
  const measured = useRef(false);

  /**
   * Lifts the sheet by however much the keyboard actually covers it, and by nothing
   * when it covers nothing.
   *
   * Self-correcting on purpose. If the window resized for the keyboard, the sheet is
   * already clear and the overlap measures zero. If it did not, the overlap is exactly
   * how far the sheet extends past the keyboard's top edge. Either way the arithmetic
   * is the same and no platform rule has to be assumed.
   */
  useEffect(() => {
    if (keyboardTop === null) {
      measured.current = false;
      setLift(0);
      return;
    }
    if (measured.current) return;
    measured.current = true;

    // A beat after the keyboard reports itself, so any window resize has settled and
    // the measurement reflects where the sheet has actually come to rest.
    const timer = setTimeout(() => {
      sheet.current?.measureInWindow((_x, y, _width, sheetHeight) => {
        setLift(Math.max(0, y + sheetHeight - keyboardTop));
      });
    }, 80);

    return () => clearTimeout(timer);
  }, [keyboardTop]);

  // The sheet is pinned to the bottom of an edge-to-edge window, so without this its
  // last row sits behind the navigation bar: visible, but not reachable by a tap.
  //
  // Dropped while the keyboard is up, because the keyboard already occupies that strip
  // and the inset would only open a gap under the fields.
  const bottomInset = keyboardTop === null ? insets.bottom : 0;

  // Only subtract what was actually added, or the sheet loses height it still has. The
  // floor is insurance: a measurement gone wrong should leave the sheet cramped and
  // obviously wrong, not collapsed to nothing with no way to tell why.
  const available = Math.max(height - lift, height * 0.35);

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
          ref={sheet}
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
