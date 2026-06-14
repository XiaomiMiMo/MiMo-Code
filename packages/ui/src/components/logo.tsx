import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="devora-mark-gradient" x1="18" y1="20" x2="82" y2="82" gradientUnits="userSpaceOnUse">
          <stop stop-color="#6EC9F6" />
          <stop offset="1" stop-color="#2768FF" />
        </linearGradient>
      </defs>
      <path
        data-slot="logo-mark-d"
        d="M27 22H53C70 22 84 35 84 50C84 65 70 78 53 78H27"
        stroke="url(#devora-mark-gradient)"
        stroke-width="9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        data-slot="logo-mark-chevron"
        d="M35 42L45 50L35 58"
        stroke="url(#devora-mark-gradient)"
        stroke-width="7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        data-slot="logo-mark-slash"
        d="M58 59L66 41"
        stroke="url(#devora-mark-gradient)"
        stroke-width="7"
        stroke-linecap="round"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="devora-splash-gradient" x1="18" y1="20" x2="82" y2="82" gradientUnits="userSpaceOnUse">
          <stop stop-color="#6EC9F6" />
          <stop offset="1" stop-color="#2768FF" />
        </linearGradient>
      </defs>
      <path
        d="M27 22H53C70 22 84 35 84 50C84 65 70 78 53 78H27"
        stroke="url(#devora-splash-gradient)"
        stroke-width="9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M35 42L45 50L35 58"
        stroke="url(#devora-splash-gradient)"
        stroke-width="7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M58 59L66 41" stroke="url(#devora-splash-gradient)" stroke-width="7" stroke-linecap="round" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 210 64"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <defs>
        <linearGradient id="devora-logo-gradient" x1="4" y1="10" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop stop-color="#6EC9F6" />
          <stop offset="1" stop-color="#2768FF" />
        </linearGradient>
      </defs>
      <path
        d="M16 14H35C48 14 58 23 58 32C58 41 48 50 35 50H16"
        stroke="url(#devora-logo-gradient)"
        stroke-width="7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M22 27L29 32L22 37"
        stroke="url(#devora-logo-gradient)"
        stroke-width="5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M39 38L45 26" stroke="url(#devora-logo-gradient)" stroke-width="5" stroke-linecap="round" />
      <text
        x="74"
        y="43"
        fill="var(--icon-strong-base)"
        font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        font-size="33"
        font-weight="700"
        letter-spacing="0"
      >
        Devora
      </text>
    </svg>
  )
}
