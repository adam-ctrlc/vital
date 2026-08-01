import { Redirect } from 'expo-router';
import { useColorScheme } from 'nativewind';
import Envelope from 'phosphor-react-native/src/icons/Envelope';
import Eye from 'phosphor-react-native/src/icons/Eye';
import EyeSlash from 'phosphor-react-native/src/icons/EyeSlash';
import HardHat from 'phosphor-react-native/src/icons/HardHat';
import Info from 'phosphor-react-native/src/icons/Info';
import Lock from 'phosphor-react-native/src/icons/Lock';
import Palette from 'phosphor-react-native/src/icons/Palette';
import Wrench from 'phosphor-react-native/src/icons/Wrench';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AboutModal } from '@/components/about-modal';
import { AppearanceModal } from '@/components/appearance-modal';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { IconInput } from '@/components/ui/icon-input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/features/auth/context';
import type { Role } from '@/features/auth/types';
import { useAppearance } from '@/lib/appearance';

const ROLES = [
  { label: 'User', value: 'user' as Role, icon: HardHat },
  { label: 'Admin', value: 'admin' as Role, icon: Wrench },
];

/** The role's full title, used in the changing hint under the picker. */
const ROLE_TITLE: Record<Role, string> = {
  user: 'Power Utility Personnel',
  admin: 'Maintenance Engineer',
};

export default function LoginScreen() {
  const { token, signIn } = useAuth();
  const { primary } = useAppearance();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const muted = isDark ? '#a1a1aa' : '#71717a';
  const fg = isDark ? '#fafafa' : '#0a0a0a';

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const scroller = useRef<ScrollView>(null);
  const passwordField = useRef<TextInput>(null);

  /**
   * The form is the last thing in the scroll view, so scrolling to the end puts
   * the focused field and the button above the keyboard. The delay lets the
   * keyboard finish animating in, otherwise the scroll targets the old height.
   */
  function liftIntoView() {
    setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 120);
  }

  if (token) {
    return <Redirect href="/dashboard" />;
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(identifier.trim(), password, role);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = identifier.trim().length > 0 && password.length > 0 && !busy;

  return (
    <SafeAreaView className="bg-background flex-1" edges={['top', 'bottom']}>
      {/*
        Android needs an explicit behavior too. Expo SDK 54 turns on edge-to-edge,
        under which the window no longer resizes for the keyboard, so leaving this
        undefined on Android let the keyboard cover the form.
      */}
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <ScrollView
          ref={scroller}
          contentContainerClassName="grow justify-center gap-6 p-6"
          keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}>
          <View className="flex-row items-center justify-end">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              accessibilityLabel="About VITAL"
              onPress={() => setShowAbout(true)}>
              <Info size={16} weight="bold" color={fg} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              accessibilityLabel="Appearance"
              onPress={() => setShowAppearance(true)}>
              <Palette size={16} weight="bold" color={fg} />
            </Button>
            <ThemeToggle />
          </View>

          <View className="items-center gap-3">
            <Image
              source={require('@/assets/images/phinmacoc.png')}
              style={{ width: 96, height: 96 }}
              resizeMode="contain"
              accessibilityLabel="PHINMA Cagayan de Oro College"
            />
            <View className="items-center gap-1">
              <Text className="text-2xl font-bold">Maligayang pagbabalik!</Text>
              <Text variant="muted" className="text-center text-sm">
                VITAL is watching your 1 KVA transformer. Sign in to pick up where the
                readings left off.
              </Text>
            </View>
          </View>

          <Card>
            <CardContent className="gap-4 p-5">
              <View className="gap-1.5">
                <Text className="text-sm font-medium">Signing in as</Text>
                <Segmented
                  fill
                  variant="solid"
                  options={ROLES}
                  value={role}
                  onChange={setRole}
                  activeColor={primary.hex}
                  inactiveColor={muted}
                />
                <Text variant="muted" className="text-[10px]">
                  You are signing in as a {ROLE_TITLE[role]}. This must match your account.
                </Text>
              </View>

              <View className="gap-1.5">
                <Text className="text-sm font-medium">Email or username</Text>
                <IconInput
                  icon={Envelope}
                  iconColor={primary.hex}
                  value={identifier}
                  onChangeText={setIdentifier}
                  onFocus={liftIntoView}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="username"
                  returnKeyType="next"
                  // The key said "next" and did nothing. Without this the keyboard
                  // just closed and the password field had to be found by tapping.
                  onSubmitEditing={() => passwordField.current?.focus()}
                  submitBehavior="submit"
                  placeholder="you@example.com"
                />
              </View>

              <View className="gap-1.5">
                <Text className="text-sm font-medium">Password</Text>
                <IconInput
                  ref={passwordField}
                  icon={Lock}
                  iconColor={primary.hex}
                  value={password}
                  onChangeText={setPassword}
                  onFocus={liftIntoView}
                  secureTextEntry={!reveal}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="password"
                  returnKeyType="go"
                  placeholder="Your password"
                  onSubmitEditing={() => canSubmit && void submit()}
                  action={{
                    icon: reveal ? EyeSlash : Eye,
                    label: reveal ? 'Hide password' : 'Show password',
                    onPress: () => setReveal((v) => !v),
                  }}
                />
              </View>

              {error ? <Text className="text-destructive text-sm">{error}</Text> : null}

              <Button disabled={!canSubmit} onPress={() => void submit()}>
                {busy ? <ActivityIndicator color={muted} /> : <Text>Sign in</Text>}
              </Button>
            </CardContent>
          </Card>

          <Text variant="muted" className="text-center text-[10px] uppercase tracking-widest">
            Pro Deo et Humanitate
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <AppearanceModal visible={showAppearance} onClose={() => setShowAppearance(false)} />
      <AboutModal visible={showAbout} onClose={() => setShowAbout(false)} />
    </SafeAreaView>
  );
}
