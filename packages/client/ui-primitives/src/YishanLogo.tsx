import type { IconProps } from './icons/props.ts'

/** Props for the Yishan master logo. */
export interface YishanLogoProps extends IconProps {
  /** Called when the public logo asset cannot be rendered. */
  onError?: () => void
}

/**
 * Render the supplied Yishan master logo from the web app's public assets.
 * @param props.size - Rendered logo height in px.
 * @param props.className - Extra class for layout.
 * @param props.onError - Optional asset failure callback.
 * @returns an aria-hidden image preserving the source artwork untouched.
 */
export function YishanLogo({ size = 24, className, onError }: YishanLogoProps) {
  return (
    <img
      className={className}
      src="/yishan-logo.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={onError}
      style={{ height: size, width: 'auto', maxWidth: '100%', objectFit: 'contain' }}
    />
  )
}
