import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 888 248"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      {/* Xiaomi label */}
      <text x="700" y="69" fill="#a9a9a9" font-family="monospace" font-size="28" font-weight="800" letter-spacing="1">Xiaomi</text>

      {/* MIMO */}
      <g fill="#ff7a3d">
        {/* M */}
        <rect x="138" y="115" width="18" height="93" />
        <rect x="155" y="115" width="18" height="18" />
        <rect x="172" y="133" width="17" height="37" />
        <rect x="189" y="115" width="18" height="18" />
        <rect x="206" y="115" width="18" height="93" />
        {/* I */}
        <rect x="240" y="115" width="18" height="93" />
        {/* M */}
        <rect x="274" y="115" width="18" height="93" />
        <rect x="291" y="115" width="18" height="18" />
        <rect x="308" y="133" width="17" height="37" />
        <rect x="325" y="115" width="18" height="18" />
        <rect x="342" y="115" width="18" height="93" />
        {/* O */}
        <rect x="376" y="115" width="68" height="18" />
        <rect x="376" y="115" width="18" height="93" />
        <rect x="426" y="115" width="18" height="93" />
        <rect x="376" y="190" width="68" height="18" />
      </g>

      {/* CODE */}
      <g fill="#a9a9a9">
        {/* C */}
        <rect x="495" y="115" width="52" height="18" />
        <rect x="495" y="115" width="18" height="93" />
        <rect x="495" y="190" width="52" height="18" />
        {/* O */}
        <rect x="563" y="115" width="68" height="18" />
        <rect x="563" y="115" width="18" height="93" />
        <rect x="613" y="115" width="18" height="93" />
        <rect x="563" y="190" width="68" height="18" />
        {/* D */}
        <rect x="648" y="115" width="51" height="18" />
        <rect x="648" y="115" width="18" height="93" />
        <rect x="699" y="133" width="18" height="57" />
        <rect x="648" y="190" width="51" height="18" />
        {/* E */}
        <rect x="733" y="115" width="68" height="18" />
        <rect x="733" y="115" width="18" height="93" />
        <rect x="733" y="151" width="51" height="18" />
        <rect x="733" y="190" width="68" height="18" />
      </g>
    </svg>
  )
}
