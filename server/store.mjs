import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDemoAlerts } from './domain.mjs'

const defaultFile = fileURLToPath(new URL('../data/store.json', import.meta.url))

export function createStore({ filePath = defaultFile, seed = createDemoAlerts } = {}) {
  const path = resolve(filePath)
  let state
  let loading
  let updateQueue = Promise.resolve()

  async function load() {
    if (state) return state
    if (!loading) {
      loading = (async () => {
        try {
          state = JSON.parse(await readFile(path, 'utf8'))
          if (!Array.isArray(state.alerts) || typeof state.storyStates !== 'object') {
            throw new Error(`Store file has an invalid format: ${path}`)
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          state = { version: 1, alerts: seed(), storyStates: {} }
          await persist(state)
        }
        return state
      })()
    }
    return loading
  }

  async function persist(value) {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  }

  async function read() {
    return structuredClone(await load())
  }

  function update(mutator) {
    const operation = updateQueue.then(async () => {
      const current = await load()
      const result = await mutator(current)
      await persist(current)
      return structuredClone(result)
    })
    updateQueue = operation.catch(() => {})
    return operation
  }

  function reset() {
    return update((current) => {
      current.alerts = seed()
      current.storyStates = {}
      return { alertCount: current.alerts.length }
    })
  }

  return { read, update, reset }
}