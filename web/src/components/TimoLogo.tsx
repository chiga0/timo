import type { SVGProps } from "react";

/**
 * Timo official geometric cat mark with subtle negative-space "T" at the nose/chin.
 * Automatically adapts to Timo's Light & Dark themes via `--primary` / `--primary-ink`
 * CSS tokens (falling back to `#09090b` / `#ffffff` when rendered standalone).
 */
export const TIMO_CAT_PATH =
  "M11.7 9.6L24.4 19.8Q32 17.5 39.6 19.8L52.3 9.6V31.4H38.6" +
  "C36.6 31.4 35.5 33.4 35.5 36.2V37.8" +
  "C36.9 36.2 38.2 35.8 40.8 35.8C43.8 35.8 45.2 34.8 45.8 33.1H52.3V40" +
  "L33 54.4V45.4L36.2 40.9H27.8L31 45.4V54.4L11.7 40V33.1H18.2" +
  "C18.8 34.8 20.2 35.8 23.2 35.8C25.8 35.8 27.1 36.2 28.5 37.8V36.2" +
  "C28.5 33.4 27.4 31.4 25.4 31.4H11.7Z" +
  "M14.3 15.2L21.7 21.3L14.3 27.6Z" +
  "M49.7 15.2L42.3 21.3L49.7 27.6Z";

export function TimoLogo(
  props: { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height" | "viewBox">,
): React.JSX.Element {
  const { size = 22, ...svgProps } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      {...svgProps}
    >
      <rect width="64" height="64" rx="15" fill="var(--primary, #09090b)" />
      <path fillRule="evenodd" clipRule="evenodd" fill="var(--primary-ink, #ffffff)" d={TIMO_CAT_PATH} />
    </svg>
  );
}
