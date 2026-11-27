import { useRef, type KeyboardEvent } from "react";

/**
 * Bulletproof macOS / Chinese IME composition guard for Enter-to-submit inputs.
 *
 * Checking `event.nativeEvent.isComposing` alone fails on macOS Chrome/Safari
 * with Pinyin/Sogou/WeType IMEs when pressing Enter to commit Latin characters:
 * - Chrome often fires `keydown` with `key: "Enter"`, `isComposing: false`,
 *   and legacy `keyCode: 229` (IME Process).
 * - Safari & several third-party IMEs fire `compositionend` immediately before
 *   the very same Enter `keydown` event (< 80ms).
 */
export function useImeGuard(): {
  compositionProps: {
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  isImeEvent: (event: KeyboardEvent) => boolean;
} {
  const composingRef = useRef(false);
  const lastEndAtRef = useRef(0);

  return {
    compositionProps: {
      onCompositionStart: () => {
        composingRef.current = true;
      },
      onCompositionEnd: () => {
        composingRef.current = false;
        lastEndAtRef.current = Date.now();
      },
    },
    isImeEvent: (event: KeyboardEvent): boolean => {
      if (event.nativeEvent.isComposing) return true;
      if (event.nativeEvent.keyCode === 229) return true;
      if (composingRef.current) return true;
      if (Date.now() - lastEndAtRef.current < 80) return true;
      return false;
    },
  };
}
