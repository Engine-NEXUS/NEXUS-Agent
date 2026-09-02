import { useEffect, useRef } from "react";
import lottie, { AnimationItem } from "lottie-web";

/**
 * NEXUS Loading Indicator
 *
 * A transparent, click-through window that shows only the loading.json
 * Lottie animation. It appears at the top-right corner of the screen
 * when NEXUS says "On it sir" and disappears when the response arrives.
 *
 * The window itself is permanently click-through (set in Rust via
 * set_ignore_cursor_events(true)), so mouse clicks pass through to
 * whatever application is behind it.
 */
export function LoadingApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<AnimationItem | null>(null);

  useEffect(() => {
    let destroyed = false;

    fetch("/loading.json")
      .then((res) => res.json())
      .then((data) => {
        if (destroyed || !containerRef.current) return;

        const anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: data,
        });
        animRef.current = anim;
      })
      .catch((err) => console.error("LoadingApp: failed to load lottie:", err));

    return () => {
      destroyed = true;
      if (animRef.current) {
        animRef.current.destroy();
        animRef.current = null;
      }
    };
  }, []);

  return (
    <div id="loading-app">
      <div className="loading-animation-container" ref={containerRef} />
    </div>
  );
}
