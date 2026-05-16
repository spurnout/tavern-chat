/**
 * Three small vertical bars that pulse while a participant is speaking.
 * Inherits its color from the surrounding text (text-ember, text-moss…),
 * and quiets itself for users with `prefers-reduced-motion: reduce`. The
 * keyframes live in styles.css.
 */
export function SpeakingIndicator(): JSX.Element {
  return (
    <span aria-hidden className="speak-bar">
      <span />
      <span />
      <span />
    </span>
  );
}
