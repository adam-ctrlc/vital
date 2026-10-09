import { Capacitor } from '@capacitor/core';

/** 'android', 'ios' or 'web'. */
export const PLATFORM = Capacitor.getPlatform() as 'android' | 'ios' | 'web';

/** True inside the Capacitor app, false in a browser. */
export const IS_NATIVE = Capacitor.isNativePlatform();
