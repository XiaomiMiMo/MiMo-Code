/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://mimo.xiaomi.com/mimocode",

  // GitHub
  github: {
    repoUrl: "https://github.com/XiaomiMiMo/MiMo-Code",
    starsFormatted: {
      compact: "4.8K",
      full: "4,833",
    },
  },

  // Social links
  social: {
    issues: "https://github.com/XiaomiMiMo/MiMo-Code/issues",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "850",
    commits: "11,000",
    monthlyUsers: "6.5M",
  },
} as const
