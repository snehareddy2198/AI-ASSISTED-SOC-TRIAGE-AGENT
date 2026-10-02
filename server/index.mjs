import { createApp } from './app.mjs'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const serveClient = process.argv.includes('--serve-client')
const server = createApp({ serveClient }).listen(port, host, () => {
  const address = server.address()
  console.log(`Signal Loom API listening on http://${host}:${address.port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}