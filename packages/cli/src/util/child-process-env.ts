import { withoutCredentials } from "./credential-env"

function snapshot(env: NodeJS.ProcessEnv) {
  return Object.freeze({ ...env })
}

export function makeChildProcessEnv(source: () => NodeJS.ProcessEnv = () => process.env) {
  let baseline: Readonly<NodeJS.ProcessEnv> | undefined

  return {
    set(env: NodeJS.ProcessEnv) {
      baseline = snapshot(env)
    },
    resolve(explicit?: NodeJS.ProcessEnv) {
      return { ...withoutCredentials(baseline ?? source()), ...explicit }
    },
  }
}

const processEnv = makeChildProcessEnv()

export const setChildProcessEnv = (env: NodeJS.ProcessEnv) => processEnv.set(env)
export const childProcessEnv = (explicit?: NodeJS.ProcessEnv) => processEnv.resolve(explicit)

export const ChildProcessEnv = {
  set: setChildProcessEnv,
}
