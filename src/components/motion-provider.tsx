"use client";
import { useSyncExternalStore } from "react";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
const query = "(prefers-reduced-motion: reduce)";
function subscribe(callback: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
function preference() { return window.matchMedia(query).matches; }
// Keep media-query changes reactive as well as honoring the initial device setting.
export function InteractionProvider({ children }: { children: React.ReactNode }) {
  const reduce = useSyncExternalStore(subscribe, preference, () => true);
  return <LazyMotion features={domAnimation} strict>
    <MotionConfig reducedMotion={reduce ? "always" : "never"} skipAnimations={reduce}
      transition={{ duration: 0.18, ease: [0.2, 0.65, 0.3, 1] }}>
      <div className="interaction-root" data-reduced-motion={reduce}>{children}</div>
    </MotionConfig>
  </LazyMotion>;
}
