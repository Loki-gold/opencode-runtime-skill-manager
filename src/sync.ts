import { access, cp, mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"

export class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.catch(() => undefined)
    return result
  }
}

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"])

export async function retryFs<T>(operation: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      last = error
      if (!RETRYABLE.has((error as NodeJS.ErrnoException).code ?? "")) throw error
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
    }
  }
  throw last
}

export async function moveAside(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  await retryFs(() => rename(source, destination))
}

export async function restore(source: string, destination: string): Promise<void> {
  await retryFs(() => rename(source, destination))
}

export async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: true, errorOnExist: false })
}
