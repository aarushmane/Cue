"use client";
import { useEffect, useRef } from "react";

/** Moves focus to the screen heading when a shopper screen opens, so screen readers announce the new screen. */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
