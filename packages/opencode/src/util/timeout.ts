export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
    promise.then(
      (result) => {
        clearTimeout(timeout)
        resolve(result)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}
